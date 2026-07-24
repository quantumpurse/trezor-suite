import type { Static } from '@trezor/schema-utils';
import { Type } from '@trezor/schema-utils';

import { CKBNetwork } from './ckb';
import type { Address, BundledParams, Params, Response } from '../params';
import { GetAddress as GetAddressShared } from '../params';

export type CKBCoin = Static<typeof CKBCoin>;
export const CKBCoin = Type.Union([Type.Literal('ckb'), Type.Literal('tckb')]);

const CkbGetAddressWithNetwork = Type.Composite([
    GetAddressShared,
    Type.Object({
        network: CKBNetwork,
        coin: Type.Optional(CKBCoin),
    }),
]);

const CkbGetAddressWithCoin = Type.Composite([
    GetAddressShared,
    Type.Object({
        network: Type.Optional(CKBNetwork),
        coin: CKBCoin,
    }),
]);

export type CkbGetAddress = Static<typeof CkbGetAddress>;
export const CkbGetAddress = Type.Union([CkbGetAddressWithNetwork, CkbGetAddressWithCoin]);

export declare function ckbGetAddress(params: Params<CkbGetAddress>): Response<Address>;
export declare function ckbGetAddress(params: BundledParams<CkbGetAddress>): Response<Address[]>;
