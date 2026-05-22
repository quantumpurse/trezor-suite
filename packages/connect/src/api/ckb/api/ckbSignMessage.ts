import type { MethodPermission } from '@trezor/connect-common';
import { CKBSignMessage as CKBSignMessageSchema } from '@trezor/connect-common/src/types/api/ckb';
import type { MessagesSchema as PROTO } from '@trezor/protobuf';
import { Assert } from '@trezor/schema-utils';

import type { MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { hexToText, messageToHex } from '../../../utils/formatUtils';
import { getSerializedPath, validatePath } from '../../../utils/pathUtils';

type CkbNetwork = 'Mainnet' | 'Testnet';

type Params = {
    proto: PROTO.CKBSignMessage & { network: CkbNetwork };
    readableMessage: string;
};

export default class CkbSignMessage extends AbstractMethod<'ckbSignMessage', Params> {
    constructor(message: MethodMessage<'ckbSignMessage'>) {
        const { payload } = message;

        Assert(CKBSignMessageSchema, payload);

        const path = validatePath(payload.path, 3);
        const fullPath = path.length === 3 ? [...path, 0, 0] : path;

        const messageHex = payload.hex
            ? messageToHex(payload.message)
            : Buffer.from(payload.message, 'utf8').toString('hex');

        const proto = {
            address_n: fullPath,
            message: messageHex,
            network: payload.network,
            chunkify: typeof payload.chunkify === 'boolean' ? payload.chunkify : false,
        };

        const params = {
            proto,
            readableMessage: payload.hex ? hexToText(payload.message) : payload.message,
        };

        super(message, params);

        this.requiredFirmwareCoins = [getCoinInfo(payload.network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read', 'write'];
    }

    get info() {
        return 'Sign Nervos CKB message';
    }

    getButtonRequestData(code: string, name?: string) {
        if (code === 'ButtonRequest_Other' && name === 'sign_message') {
            return {
                type: 'message' as const,
                coin: this.params.proto.network === 'Testnet' ? 'tCKB' : 'CKB',
                serializedPath: getSerializedPath(this.params.proto.address_n),
                message: this.params.readableMessage,
            };
        }
    }

    async run() {
        const cmd = this.getDevice().getCommands();
        const { message } = await cmd.typedCall(
            'CKBSignMessage',
            'CKBMessageSignature',
            this.params.proto,
        );

        return message;
    }
}
