import type { Params, Response } from '../params';
import type { CKBSignedTx, CKBSphincsPlusSignTransaction } from './ckb';

export declare function ckbSphincsPlusSignTransaction(
    params: Params<CKBSphincsPlusSignTransaction>,
): Response<CKBSignedTx>;
