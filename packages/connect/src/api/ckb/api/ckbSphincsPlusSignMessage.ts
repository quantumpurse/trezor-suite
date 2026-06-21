import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import {
    type CKBSphincsPlusMessageSignature,
    CKBSphincsPlusSignMessage as CKBSphincsPlusSignMessageSchema,
} from '@trezor/connect-common/src/types/api/ckb';
import { Assert } from '@trezor/schema-utils';

import type { MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { hexToText, messageToHex } from '../../../utils/formatUtils';

const DEFAULT_SPHINCS_PLUS_VARIANT = 49;

// Upper bound for the reassembled SPHINCS+ signature (~50 KB largest variant).
const MAX_SIGNATURE_BYTES = 64 * 1024;

type CkbNetwork = 'Mainnet' | 'Testnet';

type Params = {
    proto: PROTO.CKBSphincsPlusSignMessage & { network: CkbNetwork };
    readableMessage: string;
};

export default class CkbSphincsPlusSignMessage extends AbstractMethod<
    'ckbSphincsPlusSignMessage',
    Params
> {
    constructor(message: MethodMessage<'ckbSphincsPlusSignMessage'>) {
        const { payload } = message;

        Assert(CKBSphincsPlusSignMessageSchema, payload);

        const messageHex = payload.hex
            ? messageToHex(payload.message)
            : Buffer.from(payload.message, 'utf8').toString('hex');

        const proto = {
            account_index: typeof payload.accountIndex === 'number' ? payload.accountIndex : 0,
            variant:
                typeof payload.variant === 'number'
                    ? payload.variant
                    : DEFAULT_SPHINCS_PLUS_VARIANT,
            message: messageHex,
            network: payload.network,
            chunkify: typeof payload.chunkify === 'boolean' ? payload.chunkify : false,
        };

        super(message, {
            proto,
            readableMessage: payload.hex ? hexToText(payload.message) : payload.message,
        });

        this.requiredFirmwareCoins = [getCoinInfo(payload.network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read', 'write'];
    }

    get info() {
        return 'Sign Nervos CKB SPHINCS+ message';
    }

    getButtonRequestData(code: string, name?: string) {
        if (code === 'ButtonRequest_Other' && name === 'sign_message') {
            return {
                type: 'message' as const,
                coin: this.params.proto.network === 'Testnet' ? 'tCKB' : 'CKB',
                serializedPath: `SPHINCS+ account #${this.params.proto.account_index}`,
                message: this.params.readableMessage,
            };
        }
    }

    async run(): Promise<CKBSphincsPlusMessageSignature> {
        const cmd = this.getDevice().getCommands();
        const typedCall = cmd.typedCall.bind(cmd);

        // The device confirms, then streams the multi-kilobyte signature back as
        // CKBTxRequest(TXSIGCHUNK) frames, finishing with CKBSphincsPlusMessageSignature.
        let response = await typedCall(
            'CKBSphincsPlusSignMessage',
            ['CKBTxRequest', 'CKBSphincsPlusMessageSignature'],
            this.params.proto,
        );

        let signatureBuffer: Uint8Array | undefined;
        let received = 0;

        while (response.type !== 'CKBSphincsPlusMessageSignature') {
            const { request_type, details, serialized } = response.message;
            if (request_type !== 'TXSIGCHUNK') {
                throw ERRORS.TypedError(
                    'Runtime',
                    `CKB sign message: unexpected request_type ${request_type}`,
                );
            }

            const totalSize = details?.signature_total_size;
            const offset = details?.signature_offset ?? 0;
            const chunkHex = serialized?.signature;
            if (totalSize === undefined || chunkHex === undefined) {
                throw ERRORS.TypedError(
                    'Runtime',
                    'CKB sign message: TXSIGCHUNK missing signature_total_size or payload',
                );
            }
            if (totalSize <= 0 || totalSize > MAX_SIGNATURE_BYTES) {
                throw ERRORS.TypedError(
                    'Runtime',
                    `CKB sign message: signature_total_size ${totalSize} out of bounds`,
                );
            }

            const chunk = Buffer.from(chunkHex, 'hex');
            if (!signatureBuffer) {
                signatureBuffer = new Uint8Array(totalSize);
            } else if (signatureBuffer.length !== totalSize) {
                throw ERRORS.TypedError(
                    'Runtime',
                    'CKB sign message: signature_total_size changed mid-stream',
                );
            }
            if (offset + chunk.length > signatureBuffer.length) {
                throw ERRORS.TypedError(
                    'Runtime',
                    'CKB sign message: chunk overflows signature buffer',
                );
            }

            signatureBuffer.set(chunk, offset);
            received += chunk.length;

            response = await typedCall(
                'CKBTxAckSigChunk',
                ['CKBTxRequest', 'CKBSphincsPlusMessageSignature'],
                {},
            );
        }

        if (received !== signatureBuffer?.length) {
            throw ERRORS.TypedError('Runtime', 'CKB sign message: incomplete signature stream');
        }

        return {
            address: response.message.address,
            signature: Buffer.from(signatureBuffer).toString('hex'),
            publicKey: response.message.public_key,
            variant: response.message.variant,
        };
    }
}
