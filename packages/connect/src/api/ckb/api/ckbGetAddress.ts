import { ERRORS } from '@trezor/connect-common/src/constants';
import { Assert } from '@trezor/schema-utils';

import type { PROTO } from '../../../constants';
import type {
    MethodMessage,
    MethodPermission,
    MethodReturnType,
} from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { UI_REQUEST, createUiMessage } from '../../../events';
import { Bundle } from '../../../types';
import { CkbGetAddress as CkbGetAddressSchema } from '../../../types/api/ckbGetAddress';
import { getSerializedPath, validatePath } from '../../../utils/pathUtils';
import { getFirmwareRange } from '../../common/paramsValidator';

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

type Params = Omit<PROTO.CKBGetAddress, 'network'> & {
    address?: string;
    network: CkbNetwork;
};

export default class CkbGetAddress extends AbstractMethod<'ckbGetAddress', Params[]> {
    hasBundle?: boolean;
    progress = 0;

    constructor(message: MethodMessage<'ckbGetAddress'>) {
        super(message);
        this.confirmMissingBackup = true;
    }

    get requiredPermissions(): MethodPermission[] {
        return ['read'];
    }

    init() {
        // create a bundle with only one batch if bundle doesn't exists
        this.hasBundle = !!this.payload.bundle;
        const payload = !this.payload.bundle
            ? { ...this.payload, bundle: [this.payload] }
            : this.payload;

        // validate bundle type
        Assert(Bundle(CkbGetAddressSchema), payload);

        this.params = payload.bundle.map(batch => {
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

            this.firmwareRange = getFirmwareRange(
                this.name,
                getCoinInfo(getCoinSymbolFromNetwork(network)),
                this.firmwareRange,
            );

            return {
                address_n: path,
                address: batch.address,
                show_display: typeof batch.showOnTrezor === 'boolean' ? batch.showOnTrezor : true,
                chunkify: typeof batch.chunkify === 'boolean' ? batch.chunkify : false,
                network,
            };
        });

        this.useUi = this.getUseUi(this.params);
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
                serializedPath: getSerializedPath(this.params[this.progress].address_n),
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

    async _call({ address_n, show_display, chunkify, network }: Params) {
        const cmd = this.getDevice().getCommands();

        // Extend 3-segment account path to 5-segment address path (append /0/0)
        const fullPath = address_n.length === 3 ? [...address_n, 0, 0] : address_n;

        const response = await cmd.typedCall('CKBGetAddress', 'CKBAddress', {
            address_n: fullPath,
            show_display,
            chunkify,
            network,
        });

        return response.message;
    }

    async run() {
        const responses: MethodReturnType<typeof this.name> = [];
        for (let i = 0; i < this.params.length; i++) {
            const batch = this.params[i];

            // silently get address and compare with requested address
            // or display as default inside popup
            if (batch.show_display) {
                const silent = await this._call({
                    ...batch,
                    show_display: false,
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
                path: batch.address_n,
                serializedPath: getSerializedPath(batch.address_n),
                address: message.address,
            });

            if (this.hasBundle) {
                // send progress
                this.postMessage(
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
