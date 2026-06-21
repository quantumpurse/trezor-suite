import { Bundle, UI_REQUEST, createUiMessage } from '@trezor/connect-common';
import type { MethodPermission, PROTO } from '@trezor/connect-common';
import { ERRORS } from '@trezor/connect-common/src/constants';
import type { CKBSphincsPlusGetAddressResult } from '@trezor/connect-common/src/types/api/ckb';
import { CkbSphincsPlusGetAddress as CkbSphincsPlusGetAddressSchema } from '@trezor/connect-common/src/types/api/ckbSphincsPlusGetAddress';
import { Assert } from '@trezor/schema-utils';

import type { MethodContext, MethodMessage, MethodReturnType } from '../../../core/AbstractMethod';
import { AbstractMethod } from '../../../core/AbstractMethod';
import { getCoinInfo } from '../../../data/coinInfo';
import { bundlify } from '../../common/paramsValidator';

type CkbCoin = 'ckb' | 'tckb';
type CkbNetwork = 'Mainnet' | 'Testnet';

const DEFAULT_SPHINCS_PLUS_VARIANT = 49; // sha2-128s

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
    proto: PROTO.CKBSphincsPlusGetAddress & { network: CkbNetwork };
    address?: string;
};

export default class CkbSphincsPlusGetAddress extends AbstractMethod<
    'ckbSphincsPlusGetAddress',
    Params[]
> {
    hasBundle?: boolean;
    progress = 0;

    constructor(message: MethodMessage<'ckbSphincsPlusGetAddress'>) {
        const { hasBundle, payload } = bundlify(message.payload);

        Assert(Bundle(CkbSphincsPlusGetAddressSchema), payload);

        const params = payload.bundle.map(batch => {
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

            const proto = {
                account_index: typeof batch.accountIndex === 'number' ? batch.accountIndex : 0,
                variant:
                    typeof batch.variant === 'number'
                        ? batch.variant
                        : DEFAULT_SPHINCS_PLUS_VARIANT,
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
            return 'Export Nervos CKB SPHINCS+ address';
        }

        return 'Export multiple Nervos CKB SPHINCS+ addresses';
    }

    getButtonRequestData(code: string) {
        if (code === 'ButtonRequest_Address') {
            return {
                type: 'address' as const,
                serializedPath: `SPHINCS+ account #${this.params[this.progress].proto.account_index}`,
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

    async _call({ proto }: Params): Promise<CKBSphincsPlusGetAddressResult> {
        const cmd = this.getDevice().getCommands();

        const response = await cmd.typedCall('CKBSphincsPlusGetAddress', 'CKBSphincsPlusAddress', {
            account_index: proto.account_index,
            variant: proto.variant,
            show_display: proto.show_display,
            chunkify: proto.chunkify,
            network: proto.network,
        });

        return {
            address: response.message.address,
            lockArgs: response.message.lock_args,
            publicKey: response.message.public_key,
            variant: response.message.variant,
        };
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
                    batch.address = silent.address;
                }
            }

            const result = await this._call(batch);
            responses.push(result);

            if (this.hasBundle) {
                sendCoreMessage(
                    createUiMessage(UI_REQUEST.BUNDLE_PROGRESS, {
                        total: this.params.length,
                        progress: i,
                        response: result,
                    }),
                );
            }

            this.progress++;
        }

        return this.hasBundle ? responses : responses[0];
    }
}
