import { ccc } from '@ckb-ccc/core';

import {
    ensureCkbInputWitnesses,
    normalizeTrezorCkbSignature,
} from '../../src/send/sendFormCkbThunks';

describe('sendFormCkbThunks helpers', () => {
    it('pads missing empty witnesses for additional CKB inputs', () => {
        const tx = ccc.Transaction.from({
            inputs: [
                {
                    previousOutput: {
                        txHash: `0x${'11'.repeat(32)}`,
                        index: 0,
                    },
                    since: '0',
                },
                {
                    previousOutput: {
                        txHash: `0x${'22'.repeat(32)}`,
                        index: 1,
                    },
                    since: '0',
                },
            ],
        });

        ensureCkbInputWitnesses(tx);

        expect(tx.witnesses).toEqual(['0x', '0x']);
    });

    it('keeps existing witnesses while padding the missing ones', () => {
        const tx = ccc.Transaction.from({
            inputs: [
                {
                    previousOutput: {
                        txHash: `0x${'33'.repeat(32)}`,
                        index: 0,
                    },
                    since: '0',
                },
                {
                    previousOutput: {
                        txHash: `0x${'44'.repeat(32)}`,
                        index: 1,
                    },
                    since: '0',
                },
            ],
            witnesses: ['0x1234'],
        });

        ensureCkbInputWitnesses(tx);

        expect(tx.witnesses).toEqual(['0x1234', '0x']);
    });

    it('passes through CKB native format signature', () => {
        const ckbSignature = `${'11'.repeat(32)}${'22'.repeat(32)}01`;

        expect(normalizeTrezorCkbSignature(ckbSignature)).toBe(ckbSignature);
    });

    it('strips 0x prefix from signature', () => {
        const ckbSignature = `${'11'.repeat(32)}${'22'.repeat(32)}00`;

        expect(normalizeTrezorCkbSignature(`0x${ckbSignature}`)).toBe(ckbSignature);
    });

    it('throws on unexpected CKB signature length', () => {
        expect(() => normalizeTrezorCkbSignature('1234')).toThrow(
            'Unexpected CKB signature length returned by Trezor.',
        );
    });
});
