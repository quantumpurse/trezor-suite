import type { Params, Response } from '../params';
import type { CKBSphincsPlusMessageSignature, CKBSphincsPlusSignMessage } from './ckb';

export declare function ckbSphincsPlusSignMessage(
    params: Params<CKBSphincsPlusSignMessage>,
): Response<CKBSphincsPlusMessageSignature>;
