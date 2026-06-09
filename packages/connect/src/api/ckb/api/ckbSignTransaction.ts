import type { CkbRawTransaction } from '@trezor/blockchain-link-types';
import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import {
    CKBSignTransaction as CKBSignTransactionSchema,
    type CKBTransaction,
} from '@trezor/connect-common/src/types/api/ckb';
import { Assert } from '@trezor/schema-utils';

import { initBlockchain, isBackendSupported } from '../../../backend/BlockchainLink';
import type { MethodContext, MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import type { TypedCall } from '../../../device/DeviceCommands';
import { validatePath } from '../../../utils/pathUtils';

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

// secp256k1 recoverable signature length (the WitnessArgs lock field size).
const SIGNATURE_PLACEHOLDER_SIZE = 65;

// Strip '0x' prefix from hex strings for protobuf bytes fields.
// Buffer.from('0xABCD', 'hex') silently returns empty buffer,
// so the prefix MUST be removed before protobuf encoding.
const stripHex = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

// Canonical key for matching a previous tx against an input OutPoint or against
// the device's CKBTxRequestDetails.tx_hash (both are bare lowercase hex).
const normHash = (hex: string): string => stripHex(hex).toLowerCase();

type CkbNetwork = 'Mainnet' | 'Testnet';

type CKBSignTxInitialParams = PROTO.CKBSignTx & { network: CkbNetwork };

const mapInput = (input: CKBTransaction['inputs'][number]): PROTO.CKBCellInput => ({
    previous_output_tx_hash: stripHex(input.previousOutput.txHash),
    previous_output_index: Number(input.previousOutput.index),
    since: String(input.since ?? '0'),
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

// Proto pieces of a previous transaction, served on demand to the device so it
// can re-hash the tx and trust the spent capacity.
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

// A previous tx fetched from the backend arrives in the CKB-native shape; coerce
// it to CKBTransaction (validating the supported version) so buildPrevTx can use it.
const rawToCkbTransaction = (raw: CkbRawTransaction): CKBTransaction => {
    if (raw.version !== 0) {
        throw ERRORS.TypedError(
            'Runtime',
            `CKB previous tx has unsupported version ${raw.version}`,
        );
    }

    return { ...raw, version: 0 };
};

type ProcessContext = {
    typedCall: TypedCall;
    inputs: PROTO.CKBCellInput[];
    outputs: PROTO.CKBCellOutput[];
    cellDeps: PROTO.CKBCellDep[];
    witnesses: PROTO.CKBTxAckWitness[];
    prevTxs: Record<string, PrevTxProto>;
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

const processCkbTxRequest = async (
    ctx: ProcessContext,
    txRequest: PROTO.CKBTxRequest,
): Promise<{ signature: string; tx_hash: string }> => {
    const { typedCall } = ctx;
    const { request_type, details, serialized } = txRequest;

    if (request_type === 'TXFINISHED') {
        if (!serialized?.signature || !serialized.tx_hash) {
            throw ERRORS.TypedError(
                'Runtime',
                'CKB signing: Device finished but no signature/tx_hash returned',
            );
        }

        return {
            signature: serialized.signature,
            tx_hash: serialized.tx_hash,
        };
    }

    const requestIndex = details?.request_index ?? 0;
    let next: PROTO.CKBTxRequest;

    switch (request_type) {
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

export default class CkbSignTransaction extends AbstractMethod<
    'ckbSignTransaction',
    CKBSignTxInitialParams
> {
    inputs: PROTO.CKBCellInput[] = [];
    outputs: PROTO.CKBCellOutput[] = [];
    cellDeps: PROTO.CKBCellDep[] = [];
    witnesses: PROTO.CKBTxAckWitness[] = [];
    prevTxs: Record<string, PrevTxProto> = {};

    constructor(message: MethodMessage<'ckbSignTransaction'>) {
        const { payload } = message;

        Assert(CKBSignTransactionSchema, payload);

        const path = validatePath(payload.path, 3);
        const {
            transaction,
            network,
            chunkify,
            witnesses: payloadWitnesses,
            signGroupInputIndices: payloadGroupIndices,
            prevTxs: payloadPrevTxs,
        } = payload;

        // Extend 3-segment account path to 5-segment address path (append /0/0)
        const fullPath = path.length === 3 ? [...path, 0, 0] : path;

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

        // The host supplies the real on-chain witness vector; the device never
        // guesses a layout, so reject the request if it is missing.
        if (!payloadWitnesses || payloadWitnesses.length === 0) {
            throw ERRORS.TypedError(
                'Method_InvalidParameter',
                'CKB signing requires the transaction witness vector.',
            );
        }

        // Signing witness goes structured (device blanks its lock); others raw.
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

        // The caller may supply prevTxs; any input left without one is fetched from
        // the backend in run() (mirrors Bitcoin's refTxs), so completeness is not
        // checked here.
        const prevTxs: Record<string, PrevTxProto> = {};
        for (const [hash, prevTx] of Object.entries(payloadPrevTxs ?? {})) {
            prevTxs[normHash(hash)] = buildPrevTx(prevTx);
        }

        const params: CKBSignTxInitialParams = {
            address_n: fullPath,
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
        return 'Sign Nervos CKB transaction';
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
        // For CKB the worker returns the native previous tx as JSON through the
        // generic getTransactionHex message (see workers/ckb), hence JSON.parse below.
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

        const { message } = await typedCall('CKBSignTx', 'CKBTxRequest', this.params);

        return processCkbTxRequest(
            {
                typedCall,
                inputs: this.inputs,
                outputs: this.outputs,
                cellDeps: this.cellDeps,
                witnesses: this.witnesses,
                prevTxs: this.prevTxs,
            },
            message,
        );
    }
}
