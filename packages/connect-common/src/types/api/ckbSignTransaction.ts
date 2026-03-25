import type { Params, Response } from '../params';
import type { CKBSignTransaction, CKBSignedTx } from './ckb';

export declare function ckbSignTransaction(
    params: Params<CKBSignTransaction>,
): Response<CKBSignedTx>;
