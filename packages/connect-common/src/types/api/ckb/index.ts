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
    // Nervos DAO phase-2 withdrawal inputs only: positions in `headerDeps` of the
    // deposit block header and of the withdrawing cell's including block header.
    daoDepositHeaderIndex: Type.Optional(Type.Number()),
    daoWithdrawHeaderIndex: Type.Optional(Type.Number()),
});

// A CKB block header (as returned by the `get_header` RPC). Supplied for Nervos
// DAO withdrawals so the device can verify the compensation trustlessly.
export type CKBBlockHeader = Static<typeof CKBBlockHeader>;
export const CKBBlockHeader = Type.Object({
    version: Type.Number(),
    compactTarget: Type.Number(),
    timestamp: Type.Uint(),
    number: Type.Uint(),
    epoch: Type.Uint(),
    parentHash: Type.String(),
    transactionsRoot: Type.String(),
    proposalsHash: Type.String(),
    extraHash: Type.String(),
    dao: Type.String(),
    nonce: Type.String(),
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

export type CKBWitnessArgs = Static<typeof CKBWitnessArgs>;
export const CKBWitnessArgs = Type.Object({
    lockSize: Type.Optional(Type.Number()),
    inputType: Type.Optional(Type.String()),
    outputType: Type.Optional(Type.String()),
});

export type CKBSignWitness = Static<typeof CKBSignWitness>;
export const CKBSignWitness = Type.Object({
    // Signing witness: `witnessArgs` (device blanks its lock). Others: `raw`.
    witnessArgs: Type.Optional(CKBWitnessArgs),
    raw: Type.Optional(Type.String()),
});

export type CKBSignTransaction = Static<typeof CKBSignTransaction>;
export const CKBSignTransaction = Type.Object({
    path: DerivationPath,
    transaction: CKBTransaction,
    // Full on-chain witness vector (required at runtime).
    witnesses: Type.Optional(Type.Array(CKBSignWitness)),
    // Inputs of the lock-script group to sign; first index holds the signature (required).
    signGroupInputIndices: Type.Optional(Type.Array(Type.Number())),
    network: CKBNetwork,
    chunkify: Type.Optional(Type.Boolean()),
    // Full block headers, one per `transaction.headerDeps` entry in the same
    // order. Required when any input is a Nervos DAO withdrawing cell: the device
    // re-hashes each header, checks it against the committed headerDeps, and reads
    // the accumulated rate to verify the DAO compensation.
    headers: Type.Optional(Type.Array(CKBBlockHeader)),
    // Previous transactions keyed by their hash (with or without 0x prefix). The
    // device re-hashes each to verify the spent input capacities and compute the
    // fee trustlessly. Optional: any input whose previous tx is not supplied here
    // is fetched from the backend during signing.
    prevTxs: Type.Optional(Type.Record(Type.String(), CKBTransaction)),
});

export type CKBSignedTx = Static<typeof CKBSignedTx>;
export const CKBSignedTx = Type.Object({
    signature: Type.String(),
    tx_hash: Type.String(),
});

export type CKBSignMessage = Static<typeof CKBSignMessage>;
export const CKBSignMessage = Type.Object({
    path: DerivationPath,
    message: Type.String(),
    network: CKBNetwork,
    hex: Type.Optional(Type.Boolean()),
    chunkify: Type.Optional(Type.Boolean()),
});

export type CKBMessageSignature = Static<typeof CKBMessageSignature>;
export const CKBMessageSignature = Type.Object({
    address: Type.String(),
    signature: Type.String(),
});

export type CKBVerifyMessage = Static<typeof CKBVerifyMessage>;
export const CKBVerifyMessage = Type.Object({
    address: Type.String(),
    message: Type.String(),
    signature: Type.String(),
    network: CKBNetwork,
    hex: Type.Optional(Type.Boolean()),
    chunkify: Type.Optional(Type.Boolean()),
});
