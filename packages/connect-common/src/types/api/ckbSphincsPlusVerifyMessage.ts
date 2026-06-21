import type { PROTO } from '../../';
import type { Params, Response } from '../params';
import type { CKBSphincsPlusVerifyMessage } from './ckb';

export declare function ckbSphincsPlusVerifyMessage(
    params: Params<CKBSphincsPlusVerifyMessage>,
): Response<PROTO.Success>;
