import type { Static } from '@trezor/schema-utils';
import { Type } from '@trezor/schema-utils';

import type { CKBSphincsPlusGetAddressResult } from './ckb';
import { CKBNetwork } from './ckb';
import { CKBCoin } from './ckbGetAddress';
import type { BundledParams, Params, Response } from '../params';

const CkbSphincsPlusGetAddressWithNetwork = Type.Object({
    accountIndex: Type.Optional(Type.Number()),
    variant: Type.Optional(Type.Number()),
    network: CKBNetwork,
    coin: Type.Optional(CKBCoin),
    showOnTrezor: Type.Optional(Type.Boolean()),
    chunkify: Type.Optional(Type.Boolean()),
    address: Type.Optional(Type.String()),
});

const CkbSphincsPlusGetAddressWithCoin = Type.Object({
    accountIndex: Type.Optional(Type.Number()),
    variant: Type.Optional(Type.Number()),
    network: Type.Optional(CKBNetwork),
    coin: CKBCoin,
    showOnTrezor: Type.Optional(Type.Boolean()),
    chunkify: Type.Optional(Type.Boolean()),
    address: Type.Optional(Type.String()),
});

export type CkbSphincsPlusGetAddress = Static<typeof CkbSphincsPlusGetAddress>;
export const CkbSphincsPlusGetAddress = Type.Union([
    CkbSphincsPlusGetAddressWithNetwork,
    CkbSphincsPlusGetAddressWithCoin,
]);

export declare function ckbSphincsPlusGetAddress(
    params: Params<CkbSphincsPlusGetAddress>,
): Response<CKBSphincsPlusGetAddressResult>;
export declare function ckbSphincsPlusGetAddress(
    params: BundledParams<CkbSphincsPlusGetAddress>,
): Response<CKBSphincsPlusGetAddressResult[]>;
