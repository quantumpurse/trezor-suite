import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import { CKBSphincsPlusVerifyMessage as CKBSphincsPlusVerifyMessageSchema } from '@trezor/connect-common/src/types/api/ckb';
import { Assert } from '@trezor/schema-utils';

import type { MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { messageToHex } from '../../../utils/formatUtils';

// Chunk size for streaming the signature to the device, under the THP buffer.
const SIG_CHUNK_SIZE = 4096;

type CkbNetwork = 'Mainnet' | 'Testnet';

const stripHex = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

// Strict hex → bytes. `Buffer.from(hex, 'hex')` silently drops a trailing odd
// nibble and stops at the first invalid char, so a tampered signature could
// decode back to the original and pass verification; reject malformed input.
const parseSignatureHex = (value: string): Buffer => {
    const hex = stripHex(value);
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw ERRORS.TypedError(
            'Method_InvalidParameter',
            'CKB SPHINCS+ verify: signature must be non-empty even-length hex',
        );
    }

    return Buffer.from(hex, 'hex');
};

type Params = {
    variant: number;
    address: string;
    public_key: string;
    message: string;
    signature: Buffer;
    network: CkbNetwork;
    chunkify: boolean;
};

export default class CkbSphincsPlusVerifyMessage extends AbstractMethod<
    'ckbSphincsPlusVerifyMessage',
    Params
> {
    constructor(message: MethodMessage<'ckbSphincsPlusVerifyMessage'>) {
        const { payload } = message;

        Assert(CKBSphincsPlusVerifyMessageSchema, payload);

        const messageHex = payload.hex
            ? messageToHex(payload.message)
            : Buffer.from(payload.message, 'utf8').toString('hex');

        super(message, {
            variant: payload.variant,
            address: payload.address,
            public_key: stripHex(payload.publicKey),
            message: messageHex,
            signature: parseSignatureHex(payload.signature),
            network: payload.network,
            chunkify: typeof payload.chunkify === 'boolean' ? payload.chunkify : false,
        });

        this.requiredFirmwareCoins = [getCoinInfo(payload.network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read'];
    }

    get info() {
        return 'Verify Nervos CKB SPHINCS+ message';
    }

    async run(): Promise<PROTO.Success> {
        const cmd = this.getDevice().getCommands();
        const typedCall = cmd.typedCall.bind(cmd);
        const { signature } = this.params;

        // The device drives the transfer: it asks for the signature by offset via
        // CKBTxRequest(TXSIGCHUNK); the host returns the slice in CKBTxAckSigChunk.
        let response = await typedCall('CKBSphincsPlusVerifyMessage', ['CKBTxRequest', 'Success'], {
            variant: this.params.variant,
            address: this.params.address,
            public_key: this.params.public_key,
            message: this.params.message,
            network: this.params.network,
            signature_total_size: signature.length,
            chunkify: this.params.chunkify,
        });

        while (response.type !== 'Success') {
            const { request_type, details } = response.message;
            if (request_type !== 'TXSIGCHUNK') {
                throw ERRORS.TypedError(
                    'Runtime',
                    `CKB verify message: unexpected request_type ${request_type}`,
                );
            }

            const offset = details?.signature_offset ?? 0;
            if (offset < 0 || offset >= signature.length) {
                throw ERRORS.TypedError(
                    'Runtime',
                    `CKB verify message: requested offset ${offset} out of range`,
                );
            }

            const chunk = signature.subarray(offset, offset + SIG_CHUNK_SIZE);
            response = await typedCall('CKBTxAckSigChunk', ['CKBTxRequest', 'Success'], {
                signature: chunk.toString('hex'),
            });
        }

        return response.message;
    }
}
