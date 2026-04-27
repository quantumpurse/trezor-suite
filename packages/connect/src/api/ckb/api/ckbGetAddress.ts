import { Bundle, UI_REQUEST, createUiMessage } from '@trezor/connect-common';
import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import { CkbGetAddress as CkbGetAddressSchema } from '@trezor/connect-common/src/types/api/ckbGetAddress';
import { Assert } from '@trezor/schema-utils';

import type { MethodContext, MethodMessage, MethodReturnType } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { getSerializedPath, validatePath } from '../../../utils/pathUtils';
import { bundlify } from '../../common/paramsValidator';

type CkbCoin = 'ckb' | 'tckb';
type CkbNetwork = 'Mainnet' | 'Testnet';

const getNetworkFromCoin = (coin?: CkbCoin): CkbNetwork | undefined => {
    if (coin === 'ckb') {
        return 'Mainnet';
    }

    if (coin === 'tckb') {
        return 'Testnet';
    }
};

const getCoinSymbolFromNetwork = (network: CkbNetwork) => (network === 'Testnet' ? 'tckb' : 'ckb');

type Params = {
    proto: PROTO.CKBGetAddress & { network: CkbNetwork };
    address?: string;
};

export default class CkbGetAddress extends AbstractMethod<'ckbGetAddress', Params[]> {
    hasBundle?: boolean;
    progress = 0;

    constructor(message: MethodMessage<'ckbGetAddress'>) {
        const { hasBundle, payload } = bundlify(message.payload);

        // validate bundle type
        Assert(Bundle(CkbGetAddressSchema), payload);

        const params = payload.bundle.map(batch => {
            const path = validatePath(batch.path, 3);
            const networkFromCoin = getNetworkFromCoin(batch.coin as CkbCoin | undefined);

            if (networkFromCoin && batch.network && batch.network !== networkFromCoin) {
                throw ERRORS.TypedError(
                    'Method_InvalidParameter',
                    'Parameters "coin" and "network" do not match',
                );
            }

            const network = batch.network ?? networkFromCoin;
            if (!network) {
                throw ERRORS.TypedError(
                    'Method_InvalidParameter',
                    'Either parameter "coin" or "network" must be provided',
                );
            }

            // Extend 3-segment account path to 5-segment address path (append /0/0)
            const fullPath = path.length === 3 ? [...path, 0, 0] : path;

            const proto = {
                address_n: fullPath,
                show_display: typeof batch.showOnTrezor === 'boolean' ? batch.showOnTrezor : true,
                chunkify: typeof batch.chunkify === 'boolean' ? batch.chunkify : false,
                network,
            };

            return { proto, address: batch.address };
        });

        super(message, params);

        this.hasBundle = hasBundle;
        this.useUi = this.getUseUi(this.params, payload.useEventListener);
        this.confirmMissingBackup = true;
        this.requiredFirmwareCoins = [
            getCoinInfo(getCoinSymbolFromNetwork(this.params[0].proto.network)),
        ];
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read'];
    }

    get info() {
        if (this.params.length === 1) {
            return 'Export Nervos CKB address';
        }

        return 'Export multiple Nervos CKB addresses';
    }

    getButtonRequestData(code: string) {
        if (code === 'ButtonRequest_Address') {
            return {
                type: 'address' as const,
                serializedPath: getSerializedPath(this.params[this.progress].proto.address_n),
                address: this.params[this.progress].address || 'not-set',
            };
        }
    }

    get confirmation() {
        return {
            view: 'export-address' as const,
            label: this.info,
        };
    }

    async _call({ proto }: Params) {
        const cmd = this.getDevice().getCommands();
        const response = await cmd.typedCall('CKBGetAddress', 'CKBAddress', proto);

        return response.message;
    }

    async run({ sendCoreMessage }: MethodContext) {
        const responses: MethodReturnType<typeof this.name> = [];
        for (let i = 0; i < this.params.length; i++) {
            const batch = this.params[i];

            // silently get address and compare with requested address
            // or display as default inside popup
            if (batch.proto.show_display) {
                const silent = await this._call({
                    ...batch,
                    proto: { ...batch.proto, show_display: false },
                });
                if (typeof batch.address === 'string') {
                    if (batch.address !== silent.address) {
                        throw ERRORS.TypedError('Method_AddressNotMatch');
                    }
                } else {
                    // save address for future verification in "getButtonRequestData"
                    batch.address = silent.address;
                }
            }

            const message = await this._call(batch);
            responses.push({
                path: batch.proto.address_n,
                serializedPath: getSerializedPath(batch.proto.address_n),
                address: message.address,
            });

            if (this.hasBundle) {
                // send progress
                sendCoreMessage(
                    createUiMessage(UI_REQUEST.BUNDLE_PROGRESS, {
                        total: this.params.length,
                        progress: i,
                        response: message,
                    }),
                );
            }

            this.progress++;
        }

        return this.hasBundle ? responses : responses[0];
    }
}
