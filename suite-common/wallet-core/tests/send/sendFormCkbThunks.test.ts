import { ccc } from '@ckb-ccc/core';

import {
    convertTrezorSigToCkb,
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

    it('keeps CKB-format signatures unchanged', () => {
        const ckbSignature = `${'11'.repeat(32)}${'22'.repeat(32)}01`;

        expect(normalizeTrezorCkbSignature(ckbSignature)).toBe(ckbSignature);
    });

    it('converts Trezor vrs signatures to CKB format', () => {
        const trezorSignature = `1f${'11'.repeat(32)}${'22'.repeat(32)}`;

        expect(normalizeTrezorCkbSignature(trezorSignature)).toBe(
            convertTrezorSigToCkb(trezorSignature),
        );
    });

    it('converts Trezor vrs signature even when last byte of s is 0-3', () => {
        // v=0x1f (recid=0), r=AA..AA, s=BB..BB00 (last byte is 0x00)
        const trezorSignature = `1f${'aa'.repeat(32)}${'bb'.repeat(31)}00`;

        const expected = convertTrezorSigToCkb(trezorSignature);

        expect(normalizeTrezorCkbSignature(trezorSignature)).toBe(expected);
        // recid should be 0 (v=0x1f → 31-31=0)
        expect(expected.slice(-2)).toBe('00');
    });

    it('converts Trezor vrs signature when last byte of s is 0x01', () => {
        // v=0x20 (recid=1), r=CC..CC, s=DD..DD01 (last byte is 0x01)
        const trezorSignature = `20${'cc'.repeat(32)}${'dd'.repeat(31)}01`;

        const expected = convertTrezorSigToCkb(trezorSignature);

        expect(normalizeTrezorCkbSignature(trezorSignature)).toBe(expected);
        // recid should be 1 (v=0x20 → 32-31=1)
        expect(expected.slice(-2)).toBe('01');
    });

    it('throws on unexpected CKB signature length', () => {
        expect(() => normalizeTrezorCkbSignature('1234')).toThrow(
            'Unexpected CKB signature length returned by Trezor.',
        );
    });

    it('throws on unexpected CKB signature format', () => {
        const unsupportedSignature = `${'11'.repeat(64)}aa`;

        expect(() => normalizeTrezorCkbSignature(unsupportedSignature)).toThrow(
            'Unexpected CKB signature format returned by Trezor.',
        );
    });
});
