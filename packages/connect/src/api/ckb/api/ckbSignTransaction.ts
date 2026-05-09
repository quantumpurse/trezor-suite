import type { PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import { CKBSignTransaction as CKBSignTransactionSchema } from '@trezor/connect-common/src/types/api/ckb';
import { Assert } from '@trezor/schema-utils';

import type { MethodMessage, MethodPermission } from '../../../core/AbstractMethod';
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

// Strip '0x' prefix from hex strings for protobuf bytes fields.
// Buffer.from('0xABCD', 'hex') silently returns empty buffer,
// so the prefix MUST be removed before protobuf encoding.
const stripHex = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

type CkbNetwork = 'Mainnet' | 'Testnet';

type CKBSignTxInitialParams = PROTO.CKBSignTx & { network: CkbNetwork };

const processCkbTxRequest = async (
    typedCall: TypedCall,
    txRequest: PROTO.CKBTxRequest,
    inputs: PROTO.CKBCellInput[],
    outputs: PROTO.CKBCellOutput[],
    cellDeps: PROTO.CKBCellDep[],
): Promise<{ signature: string; tx_hash: string }> => {
    const { request_type, details, serialized } = txRequest;

    if (request_type === 'TXFINISHED') {
        if (!serialized || !serialized.signature || !serialized.tx_hash) {
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

    if (request_type === 'TXINPUT') {
        const input = inputs[requestIndex];
        if (!input) {
            throw ERRORS.TypedError(
                'Runtime',
                `CKB signing: Requested input at index ${requestIndex}` +
                    ` but only ${inputs.length} inputs available`,
            );
        }
        const { message } = await typedCall('CKBTxAckInput', 'CKBTxRequest', {
            input,
        });

        return processCkbTxRequest(typedCall, message, inputs, outputs, cellDeps);
    }

    if (request_type === 'TXOUTPUT') {
        const output = outputs[requestIndex];
        if (!output) {
            throw ERRORS.TypedError(
                'Runtime',
                `CKB signing: Requested output at index ${requestIndex}` +
                    ` but only ${outputs.length} outputs available`,
            );
        }
        const { message } = await typedCall('CKBTxAckOutput', 'CKBTxRequest', {
            output,
        });

        return processCkbTxRequest(typedCall, message, inputs, outputs, cellDeps);
    }

    if (request_type === 'TXCELLDEP') {
        const cellDep = cellDeps[requestIndex];
        if (!cellDep) {
            throw ERRORS.TypedError(
                'Runtime',
                `CKB signing: Requested cell_dep at index ${requestIndex}` +
                    ` but only ${cellDeps.length} cell_deps available`,
            );
        }
        const { message } = await typedCall('CKBTxAckCellDep', 'CKBTxRequest', {
            cell_dep: cellDep,
        });

        return processCkbTxRequest(typedCall, message, inputs, outputs, cellDeps);
    }

    throw ERRORS.TypedError('Runtime', `CKB signing: Unknown request_type ${request_type}`);
};

export default class CkbSignTransaction extends AbstractMethod<
    'ckbSignTransaction',
    CKBSignTxInitialParams
> {
    inputs: PROTO.CKBCellInput[] = [];
    outputs: PROTO.CKBCellOutput[] = [];
    cellDeps: PROTO.CKBCellDep[] = [];

    constructor(message: MethodMessage<'ckbSignTransaction'>) {
        const { payload } = message;

        Assert(CKBSignTransactionSchema, payload);

        const path = validatePath(payload.path, 3);
        const { transaction, network, fee, chunkify } = payload;

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

        const inputs = transaction.inputs.map(input => ({
            previous_output_tx_hash: stripHex(input.previousOutput.txHash),
            previous_output_index: Number(input.previousOutput.index),
            since: String(input.since ?? '0'),
        }));

        const outputs = transaction.outputs.map((output, i) => {
            const outputData = transaction.outputsData[i];

            if (typeof outputData !== 'string') {
                throw ERRORS.TypedError(
                    'Method_InvalidParameter',
                    `CKB outputsData is missing for output index ${i}`,
                );
            }

            return {
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
                data: stripHex(outputData),
            };
        });

        const cellDeps = transaction.cellDeps.map(dep => ({
            tx_hash: stripHex(dep.outPoint.txHash),
            index: Number(dep.outPoint.index),
            dep_type: DEP_TYPE_MAP[dep.depType] ?? 0,
        }));

        const params: CKBSignTxInitialParams = {
            address_n: fullPath,
            network,
            inputs_count: inputs.length,
            outputs_count: outputs.length,
            cell_deps_count: cellDeps.length,
            fee: fee ?? 0,
            chunkify: typeof chunkify === 'boolean' ? chunkify : false,
        };

        super(message, params);

        this.inputs = inputs;
        this.outputs = outputs;
        this.cellDeps = cellDeps;
        this.requiredFirmwareCoins = [getCoinInfo(network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read', 'write'];
    }

    get info() {
        return 'Sign Nervos CKB transaction';
    }

    async run() {
        const cmd = this.getDevice().getCommands();
        const typedCall = cmd.typedCall.bind(cmd);

        const { message } = await typedCall('CKBSignTx', 'CKBTxRequest', this.params);

        return processCkbTxRequest(typedCall, message, this.inputs, this.outputs, this.cellDeps);
    }
}
