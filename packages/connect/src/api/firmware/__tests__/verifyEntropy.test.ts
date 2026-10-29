import { entropyToMnemonic } from '@scure/bip39';
import { createHash, createHmac } from 'crypto';

import { bip39 } from '@trezor/crypto-utils';

import { verifyEntropy } from '../verifyEntropy';

// Recreates what the firmware sends for an extended (SPHINCS+) mnemonic, using
// Node's crypto rather than the @noble code under test: the entropy commitment
// and the SHA-256 of the whole 36/54/72-word mnemonic.
const computeExtended = (internalHex: string, externalHex: string) => {
    const internal = Buffer.from(internalHex, 'hex');
    const external = Buffer.from(externalHex, 'hex');

    // 3 sub-secrets (matches firmware reset_device._compute_secret_from_entropy)
    const sub = Math.floor(internal.length / 3);
    const phrases = [0, 1, 2].map(i => {
        const subSecret = createHash('sha256')
            .update(internal.subarray(i * sub, (i + 1) * sub))
            .update(external)
            .update(Buffer.from([i]))
            .digest()
            .subarray(0, sub);

        return entropyToMnemonic(subSecret, [...bip39]);
    });

    return {
        commitment: createHmac('sha256', internal).update(Buffer.alloc(0)).digest('hex'),
        fullPhraseDigest: createHash('sha256').update(phrases.join(' '), 'utf-8').digest('hex'),
    };
};

describe('firmware/verifyEntropy', () => {
    it('bip39 success', async () => {
        const response = await verifyEntropy({
            strength: 256,
            hostEntropy: 'e14806194511f95f2e6b7c5267fcb824469a478007d97339da08abb379244553',
            commitment: '09c7dff5c85814852fb9cb12feecd11183f7af1c10296a5075f276c5eca9fb44',
            trezorEntropy: 'ffa4581852ee93e789b9e83554f58dd1a3e09765a64d91d8cd08f6b5c813745d',
            xpubs: {
                "m/84'/0'/0'":
                    'xpub6CCMQserNP7QkjspvUVWfCdjK1FcgFdmka3ZgzVgZKqkkCL5bfQoscxZ9UzTLLLedPGwkhQobEGE84gWvZY1tXaHJsVLMHA6cXNUmXnrj3s',
                "m/44'/60'/0'":
                    'xpub6Cdh8AtW8tSXTDYYGirGkmTCgYe4SCCAuqJLmqkhDFYVCkHLngQ7JmNSVuCQuQARqx5tDJJ9my1JCgaUHHizioZZoXRWw6LR95uQUkbKJi3',
            },
        });
        expect(response.success).toEqual(true);
    });

    it('slip39 success', async () => {
        const response = await verifyEntropy({
            type: 1,
            strength: 256,
            hostEntropy: '20e1524b5ea128b581c8882ddd5b030dd54e3bf49c8e7063768be13e0add4420',
            commitment: '0ea37a3ae4e765ac59f6d721548920c92667bb9cc09b53ebf81404d3c07794a1',
            trezorEntropy: '00610ab95fe09b3d32320662e96ba195344461b00322a09b86df68432db1e745',
            xpubs: {
                "m/84'/0'/0'":
                    'xpub6CxDGHMZekeQtFmny74NHcf1cA8opN8yWHLdmXhwhin7WrjCWKgypDyG5SoCR7ae57JqPT8ZWd2st56yzgC8bzzpHRDurXxZxkaZfXeF1bW',
                "m/44'/60'/0'":
                    'xpub6CV17nmnkijMua6ZpyRU7MNnZjHoByRGoWf2nPxJmKF1EriH92awnhV7KS2X1mB6ke1fuRerGir3kvZr6uRcQqn2Pnv48gmhtsyaHcLALVG',
            },
        });
        expect(response.success).toEqual(true);
    });

    it.each([384, 576, 768])(
        'bip39 extended (SPHINCS+ %i-bit) success without xpubs',
        async strength => {
            const trezorEntropy = 'ab'.repeat(strength / 8);
            const hostEntropy = 'cd'.repeat(32);
            const { commitment, fullPhraseDigest } = computeExtended(trezorEntropy, hostEntropy);

            const response = await verifyEntropy({
                strength,
                hostEntropy,
                commitment,
                trezorEntropy,
                xpubs: {},
                fullPhraseDigest,
            });
            expect(response).toEqual({ success: true });
        },
    );

    it('bip39 extended rejects a wrong full-phrase digest', async () => {
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs: {},
            fullPhraseDigest: '00'.repeat(32),
        });
        expect(response).toEqual({
            success: false,
            error: 'verifyEntropy full phrase digest mismatch',
        });
    });

    it('bip39 extended rejects a digest over different host entropy', async () => {
        // A firmware that ignored the host entropy produces a digest the host
        // cannot reproduce from the entropy it sent.
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment } = computeExtended(trezorEntropy, hostEntropy);
        const { fullPhraseDigest } = computeExtended(trezorEntropy, '00'.repeat(32));

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs: {},
            fullPhraseDigest,
        });
        expect(response.success).toEqual(false);
    });

    it('bip39 extended rejects a missing full-phrase digest', async () => {
        // Optional on the wire, so extended strengths must require it.
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs: {},
        });
        expect(response).toEqual({
            success: false,
            error: 'verifyEntropy missing full phrase digest',
        });
    });

    it('bip39 extended rejects a wrong commitment', async () => {
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { fullPhraseDigest } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment: '00'.repeat(32),
            trezorEntropy,
            xpubs: {},
            fullPhraseDigest,
        });
        expect(response.success).toEqual(false);
    });
});
