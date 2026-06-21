import type { CkbRawTransaction } from '@trezor/blockchain-link-types';
import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import {
    CKBSphincsPlusSignTransaction as CKBSphincsPlusSignTransactionSchema,
    type CKBTransaction,
} from '@trezor/connect-common/src/types/api/ckb';
import { Assert } from '@trezor/schema-utils';

import { initBlockchain, isBackendSupported } from '../../../backend/BlockchainLink';
import type { MethodContext, MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import type { TypedCall } from '../../../device/DeviceCommands';

const HASH_TYPE_MAP: Record<string, number> = {
    data: 0,
    type: 1,
    data1: 2,
    data2: 4,
};

const DEP_TYPE_MAP: Record<string, number> = {
    code: 0,
    dep_group: 1,
};

const DEFAULT_SPHINCS_PLUS_VARIANT = 49; // sha2-128s

// Witness lock field size used when the caller does not pass an explicit one.
// For SPHINCS+ the caller is expected to reserve the variant-sized lock, so
// this fallback only guards against a malformed witness vector.
const SIGNATURE_PLACEHOLDER_SIZE = 65;

// Upper bound for the reassembled SPHINCS+ signature (largest variant ~50 KB
// plus margin); stops a misbehaving device from forcing unbounded allocation.
const MAX_SIGNATURE_BYTES = 64 * 1024;

const stripHex = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

const normHash = (hex: string): string => stripHex(hex).toLowerCase();

type CkbNetwork = 'Mainnet' | 'Testnet';

type CKBSphincsPlusSignTxInitialParams = PROTO.CKBSphincsPlusSignTx & { network: CkbNetwork };

const mapInput = (input: CKBTransaction['inputs'][number]): PROTO.CKBCellInput => ({
    previous_output_tx_hash: stripHex(input.previousOutput.txHash),
    previous_output_index: Number(input.previousOutput.index),
    since: String(input.since),
});

const mapOutput = (
    output: CKBTransaction['outputs'][number],
    dataHex: string,
): PROTO.CKBCellOutput => ({
    capacity: output.capacity,
    lock_code_hash: stripHex(output.lock.codeHash),
    lock_hash_type: HASH_TYPE_MAP[output.lock.hashType] ?? 0,
    lock_args: stripHex(output.lock.args),
    type_code_hash: output.type?.codeHash ? stripHex(output.type.codeHash) : undefined,
    type_hash_type:
        output.type?.hashType !== undefined
            ? (HASH_TYPE_MAP[output.type.hashType] ?? 0)
            : undefined,
    type_args: output.type?.args ? stripHex(output.type.args) : undefined,
    data: stripHex(dataHex),
});

const mapCellDep = (dep: CKBTransaction['cellDeps'][number]): PROTO.CKBCellDep => ({
    tx_hash: stripHex(dep.outPoint.txHash),
    index: Number(dep.outPoint.index),
    dep_type: DEP_TYPE_MAP[dep.depType] ?? 0,
});

type PrevTxProto = {
    meta: PROTO.CKBTxAckPrevMeta;
    inputs: PROTO.CKBCellInput[];
    outputs: PROTO.CKBCellOutput[];
    cellDeps: PROTO.CKBCellDep[];
};

const buildPrevTx = (tx: CKBTransaction): PrevTxProto => {
    if (tx.outputsData.length !== tx.outputs.length) {
        throw ERRORS.TypedError(
            'Method_InvalidParameter',
            'CKB previous tx outputsData length must match outputs length',
        );
    }

    return {
        meta: {
            version: tx.version,
            inputs_count: tx.inputs.length,
            outputs_count: tx.outputs.length,
            cell_deps_count: tx.cellDeps.length,
            header_deps: tx.headerDeps.map(stripHex),
        },
        inputs: tx.inputs.map(mapInput),
        outputs: tx.outputs.map((output, i) => mapOutput(output, tx.outputsData[i] ?? '')),
        cellDeps: tx.cellDeps.map(mapCellDep),
    };
};

const rawToCkbTransaction = (raw: CkbRawTransaction): CKBTransaction => {
    if (raw.version !== 0) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB previous tx has unsupported version ${raw.version}`,
        );
    }

    return { ...raw, version: 0 };
};

// Holds the SPHINCS+ signature being assembled from TXSIGCHUNK chunks.
type CkbSignState = {
    signatureBuffer?: Uint8Array;
    signatureBytesReceived: number;
};

type ProcessContext = {
    typedCall: TypedCall;
    inputs: PROTO.CKBCellInput[];
    outputs: PROTO.CKBCellOutput[];
    cellDeps: PROTO.CKBCellDep[];
    witnesses: PROTO.CKBTxAckWitness[];
    prevTxs: Record<string, PrevTxProto>;
    state: CkbSignState;
};

const getPrevTx = (ctx: ProcessContext, txHash?: string): PrevTxProto => {
    if (!txHash) {
        throw ERRORS.TypedError(
            'Runtime',
            'CKB signing: Device requested a previous tx without a tx_hash',
        );
    }
    const prev = ctx.prevTxs[normHash(txHash)];
    if (!prev) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: Missing previous transaction for ${txHash}`,
        );
    }

    return prev;
};

const getItem = <T>(items: T[], index: number, label: string): T => {
    const item = items[index];
    if (!item) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: Requested ${label} at index ${index}` +
                ` but only ${items.length} available`,
        );
    }

    return item;
};

const finalizeChunkedSignature = (state: CkbSignState): string => {
    if (!state.signatureBuffer) {
        throw ERRORS.TypedError(
            'Runtime',
            'CKB signing: TXFINISHED arrived before any signature chunk',
        );
    }
    if (state.signatureBytesReceived !== state.signatureBuffer.length) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: signature stream incomplete (${state.signatureBytesReceived}/${state.signatureBuffer.length} bytes)`,
        );
    }

    return Buffer.from(state.signatureBuffer).toString('hex');
};

const handleSigChunk = (
    state: CkbSignState,
    details: PROTO.CKBTxRequestDetails | undefined,
    serialized: PROTO.CKBTxRequestSerialized | undefined,
) => {
    const totalSize = details?.signature_total_size;
    const offset = details?.signature_offset ?? 0;
    const chunkHex = serialized?.signature;

    if (totalSize === undefined || chunkHex === undefined) {
        throw ERRORS.TypedError(
            'Runtime',
            'CKB signing: TXSIGCHUNK missing signature_total_size or signature payload',
        );
    }
    if (totalSize <= 0 || totalSize > MAX_SIGNATURE_BYTES) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: signature_total_size ${totalSize} out of bounds`,
        );
    }

    const chunk = Buffer.from(chunkHex, 'hex');

    if (!state.signatureBuffer) {
        state.signatureBuffer = new Uint8Array(totalSize);
        state.signatureBytesReceived = 0;
    } else if (state.signatureBuffer.length !== totalSize) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: signature_total_size changed mid-stream (${state.signatureBuffer.length} → ${totalSize})`,
        );
    }

    if (offset + chunk.length > state.signatureBuffer.length) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB signing: chunk overflows signature buffer (offset=${offset}, chunk=${chunk.length}, total=${state.signatureBuffer.length})`,
        );
    }

    state.signatureBuffer.set(chunk, offset);
    state.signatureBytesReceived += chunk.length;
};

const processCkbTxRequest = async (
    ctx: ProcessContext,
    txRequest: PROTO.CKBTxRequest,
): Promise<{ signature: string; tx_hash: string }> => {
    const { typedCall } = ctx;
    const { request_type, details, serialized } = txRequest;

    if (request_type === 'TXFINISHED') {
        if (!serialized?.tx_hash) {
            throw ERRORS.TypedError(
                'Runtime',
                'CKB signing: Device finished but no tx_hash returned',
            );
        }

        // SPHINCS+ streams the (multi-kilobyte) signature via TXSIGCHUNK; fall
        // back to the reassembled buffer when no inline signature is present.
        const signature = serialized.signature ?? finalizeChunkedSignature(ctx.state);

        return {
            signature,
            tx_hash: serialized.tx_hash,
        };
    }

    const requestIndex = details?.request_index ?? 0;
    let next: PROTO.CKBTxRequest;

    switch (request_type) {
        case 'TXSIGCHUNK':
            handleSigChunk(ctx.state, details, serialized);
            ({ message: next } = await typedCall('CKBTxAckSigChunk', 'CKBTxRequest', {}));
            break;
        case 'TXINPUT':
            ({ message: next } = await typedCall('CKBTxAckInput', 'CKBTxRequest', {
                input: getItem(ctx.inputs, requestIndex, 'input'),
            }));
            break;
        case 'TXOUTPUT':
            ({ message: next } = await typedCall('CKBTxAckOutput', 'CKBTxRequest', {
                output: getItem(ctx.outputs, requestIndex, 'output'),
            }));
            break;
        case 'TXCELLDEP':
            ({ message: next } = await typedCall('CKBTxAckCellDep', 'CKBTxRequest', {
                cell_dep: getItem(ctx.cellDeps, requestIndex, 'cell_dep'),
            }));
            break;
        case 'TXWITNESS':
            ({ message: next } = await typedCall(
                'CKBTxAckWitness',
                'CKBTxRequest',
                getItem(ctx.witnesses, requestIndex, 'witness'),
            ));
            break;
        case 'TXPREVMETA':
            ({ message: next } = await typedCall(
                'CKBTxAckPrevMeta',
                'CKBTxRequest',
                getPrevTx(ctx, details?.tx_hash).meta,
            ));
            break;
        case 'TXPREVINPUT':
            ({ message: next } = await typedCall('CKBTxAckInput', 'CKBTxRequest', {
                input: getItem(getPrevTx(ctx, details?.tx_hash).inputs, requestIndex, 'prev input'),
            }));
            break;
        case 'TXPREVOUTPUT':
            ({ message: next } = await typedCall('CKBTxAckOutput', 'CKBTxRequest', {
                output: getItem(
                    getPrevTx(ctx, details?.tx_hash).outputs,
                    requestIndex,
                    'prev output',
                ),
            }));
            break;
        case 'TXPREVCELLDEP':
            ({ message: next } = await typedCall('CKBTxAckCellDep', 'CKBTxRequest', {
                cell_dep: getItem(
                    getPrevTx(ctx, details?.tx_hash).cellDeps,
                    requestIndex,
                    'prev cell_dep',
                ),
            }));
            break;
        default:
            throw ERRORS.TypedError('Runtime', `CKB signing: Unknown request_type ${request_type}`);
    }

    return processCkbTxRequest(ctx, next);
};

export default class CkbSphincsPlusSignTransaction extends AbstractMethod<
    'ckbSphincsPlusSignTransaction',
    CKBSphincsPlusSignTxInitialParams
> {
    inputs: PROTO.CKBCellInput[] = [];
    outputs: PROTO.CKBCellOutput[] = [];
    cellDeps: PROTO.CKBCellDep[] = [];
    witnesses: PROTO.CKBTxAckWitness[] = [];
    prevTxs: Record<string, PrevTxProto> = {};

    constructor(message: MethodMessage<'ckbSphincsPlusSignTransaction'>) {
        const { payload } = message;

        Assert(CKBSphincsPlusSignTransactionSchema, payload);

        const {
            transaction,
            network,
            chunkify,
            accountIndex,
            variant,
            witnesses: payloadWitnesses,
            signGroupInputIndices: payloadGroupIndices,
            prevTxs: payloadPrevTxs,
        } = payload;

        if (transaction.version !== 0) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'Only CKB transaction version 0 is supported',
            );
        }

        if (transaction.headerDeps.length > 0) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'CKB headerDeps are not supported yet',
            );
        }

        if (transaction.outputsData.length !== transaction.outputs.length) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'CKB outputsData length must match outputs length',
            );
        }

        const inputs = transaction.inputs.map(mapInput);

        const outputs = transaction.outputs.map((output, i) => {
            const outputData = transaction.outputsData[i];

            if (typeof outputData !== 'string') {
                throw ERRORS.TypedError(
                    'Method_InvalidParameter',
                    `CKB outputsData is missing for output index ${i}`,
                );
            }

            return mapOutput(output, outputData);
        });

        const cellDeps = transaction.cellDeps.map(mapCellDep);

        if (!payloadWitnesses || payloadWitnesses.length === 0) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'CKB signing requires the transaction witness vector.',
            );
        }

        const witnesses: PROTO.CKBTxAckWitness[] = payloadWitnesses.map(witness =>
            witness.witnessArgs
                ? {
                      witness_args: {
                          lock_size: witness.witnessArgs.lockSize ?? SIGNATURE_PLACEHOLDER_SIZE,
                          input_type:
                              witness.witnessArgs.inputType !== undefined
                                  ? stripHex(witness.witnessArgs.inputType)
                                  : undefined,
                          output_type:
                              witness.witnessArgs.outputType !== undefined
                                  ? stripHex(witness.witnessArgs.outputType)
                                  : undefined,
                      },
                  }
                : { raw: witness.raw !== undefined ? stripHex(witness.raw) : '' },
        );

        if (!payloadGroupIndices || payloadGroupIndices.length === 0) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'CKB signing requires sign_group_input_indices.',
            );
        }
        const signGroupInputIndices = payloadGroupIndices;

        const prevTxs: Record<string, PrevTxProto> = {};
        for (const [hash, prevTx] of Object.entries(payloadPrevTxs ?? {})) {
            prevTxs[normHash(hash)] = buildPrevTx(prevTx);
        }

        const params: CKBSphincsPlusSignTxInitialParams = {
            account_index: typeof accountIndex === 'number' ? accountIndex : 0,
            variant: typeof variant === 'number' ? variant : DEFAULT_SPHINCS_PLUS_VARIANT,
            network,
            inputs_count: inputs.length,
            outputs_count: outputs.length,
            cell_deps_count: cellDeps.length,
            witnesses_count: witnesses.length,
            sign_group_input_indices: signGroupInputIndices,
            chunkify: typeof chunkify === 'boolean' ? chunkify : false,
        };

        super(message, params);

        this.inputs = inputs;
        this.outputs = outputs;
        this.cellDeps = cellDeps;
        this.witnesses = witnesses;
        this.prevTxs = prevTxs;
        this.requiredFirmwareCoins = [getCoinInfo(network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read', 'write'];
    }

    get info() {
        return 'Sign Nervos CKB SPHINCS+ transaction';
    }

    private async fetchMissingPrevTxs(sendCoreMessage: MethodContext['sendCoreMessage']) {
        const missing = [
            ...new Set(this.inputs.map(input => normHash(input.previous_output_tx_hash))),
        ].filter(hash => !this.prevTxs[hash]);

        if (missing.length === 0) {
            return;
        }

        const coinInfo = getCoinInfo(this.params.network === 'Testnet' ? 'tckb' : 'ckb');
        if (!coinInfo) {
            throw ERRORS.TypedError('Runtime', 'CKB coin info not found');
        }
        isBackendSupported(coinInfo);
        const blockchain = await initBlockchain(coinInfo, sendCoreMessage);
        const hexes = await blockchain.getTransactionHexes(missing);

        missing.forEach((hash, i) => {
            const hex = hexes[i];
            if (hex) {
                const raw = JSON.parse(hex) as CkbRawTransaction;
                this.prevTxs[hash] = buildPrevTx(rawToCkbTransaction(raw));
            }
        });

        const stillMissing = this.inputs.find(
            input => !this.prevTxs[normHash(input.previous_output_tx_hash)],
        );
        if (stillMissing) {
            throw ERRORS.TypedError(
                'Runtime',
                'CKB signing requires a previous transaction for every input' +
                    ` (missing ${stillMissing.previous_output_tx_hash}).`,
            );
        }
    }

    async run({ sendCoreMessage }: MethodContext) {
        await this.fetchMissingPrevTxs(sendCoreMessage);

        const cmd = this.getDevice().getCommands();
        const typedCall = cmd.typedCall.bind(cmd);

        const { message } = await typedCall('CKBSphincsPlusSignTx', 'CKBTxRequest', this.params);

        return processCkbTxRequest(
            {
                typedCall,
                inputs: this.inputs,
                outputs: this.outputs,
                cellDeps: this.cellDeps,
                witnesses: this.witnesses,
                prevTxs: this.prevTxs,
                state: { signatureBytesReceived: 0 },
            },
            message,
        );
    }
}
