import type { MethodPermission } from '@trezor/connect-common';
import { CKBVerifyMessage as CKBVerifyMessageSchema } from '@trezor/connect-common/src/types/api/ckb';
import type { MessagesSchema as PROTO } from '@trezor/protobuf';
import { Assert } from '@trezor/schema-utils';

import type { MethodMessage } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { messageToHex } from '../../../utils/formatUtils';

type CkbNetwork = 'Mainnet' | 'Testnet';

type Params = PROTO.CKBVerifyMessage & { network: CkbNetwork };

export default class CkbVerifyMessage extends AbstractMethod<'ckbVerifyMessage', Params> {
    constructor(message: MethodMessage<'ckbVerifyMessage'>) {
        const { payload } = message;

        Assert(CKBVerifyMessageSchema, payload);

        const messageHex = payload.hex
            ? messageToHex(payload.message)
            : Buffer.from(payload.message, 'utf8').toString('hex');

        const params: Params = {
            address: payload.address,
            signature: payload.signature,
            message: messageHex,
            network: payload.network,
            chunkify: typeof payload.chunkify === 'boolean' ? payload.chunkify : false,
        };

        super(message, params);

        this.requiredFirmwareCoins = [getCoinInfo(payload.network === 'Testnet' ? 'tckb' : 'ckb')];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read'];
    }

    get info() {
        return 'Verify Nervos CKB message';
    }

    async run() {
        const cmd = this.getDevice().getCommands();
        const response = await cmd.typedCall('CKBVerifyMessage', 'Success', this.params);

        return response.message;
    }
}
