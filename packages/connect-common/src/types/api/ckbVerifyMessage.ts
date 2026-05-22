import type { PROTO } from '../../';
import type { Params, Response } from '../params';
import type { CKBVerifyMessage } from './ckb';

export declare function ckbVerifyMessage(params: Params<CKBVerifyMessage>): Response<PROTO.Success>;
