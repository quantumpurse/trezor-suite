import type { Params, Response } from '../params';
import type { CKBMessageSignature, CKBSignMessage } from './ckb';

export declare function ckbSignMessage(
    params: Params<CKBSignMessage>,
): Response<CKBMessageSignature>;
