import type { Static } from '@trezor/schema-utils';
import { Type } from '@trezor/schema-utils';

import { DerivationPath } from '../../params';

export type CKBNetwork = Static<typeof CKBNetwork>;
export const CKBNetwork = Type.Union([Type.Literal('Mainnet'), Type.Literal('Testnet')]);

export type CKBScript = Static<typeof CKBScript>;
export const CKBScript = Type.Object({
    codeHash: Type.String(),
    hashType: Type.Union([
        Type.Literal('data'),
        Type.Literal('type'),
        Type.Literal('data1'),
        Type.Literal('data2'),
    ]),
    args: Type.String(),
});

export type CKBCellOutput = Static<typeof CKBCellOutput>;
export const CKBCellOutput = Type.Object({
    capacity: Type.Uint(),
    lock: CKBScript,
    type: Type.Optional(CKBScript),
});

export type CKBOutPoint = Static<typeof CKBOutPoint>;
export const CKBOutPoint = Type.Object({
    txHash: Type.String(),
    index: Type.Uint(),
});

export type CKBCellInput = Static<typeof CKBCellInput>;
export const CKBCellInput = Type.Object({
    since: Type.Uint(),
    previousOutput: CKBOutPoint,
});

export type CKBCellDep = Static<typeof CKBCellDep>;
export const CKBCellDep = Type.Object({
    outPoint: CKBOutPoint,
    depType: Type.Union([Type.Literal('code'), Type.Literal('dep_group')]),
});

export type CKBTransaction = Static<typeof CKBTransaction>;
export const CKBTransaction = Type.Object({
    version: Type.Literal(0),
    cellDeps: Type.Array(CKBCellDep),
    headerDeps: Type.Array(Type.String()),
    inputs: Type.Array(CKBCellInput),
    outputs: Type.Array(CKBCellOutput),
    outputsData: Type.Array(Type.String()),
});

export type CKBSignTransaction = Static<typeof CKBSignTransaction>;
export const CKBSignTransaction = Type.Object({
    path: DerivationPath,
    transaction: CKBTransaction,
    network: CKBNetwork,
    fee: Type.Optional(Type.Uint()),
    chunkify: Type.Optional(Type.Boolean()),
});

export type CKBSignedTx = Static<typeof CKBSignedTx>;
export const CKBSignedTx = Type.Object({
    signature: Type.String(),
    tx_hash: Type.String(),
});
