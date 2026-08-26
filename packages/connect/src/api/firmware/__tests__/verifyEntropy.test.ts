import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { entropyToMnemonic } from '@scure/bip39';
import { pbkdf2Sync } from 'crypto';

import { bip39 } from '@trezor/crypto-utils';
import { bip32 } from '@trezor/utxo-lib';

import { verifyEntropy } from '../verifyEntropy';

// Recreates the firmware's extended (SPHINCS+) entropy → mnemonic → seed → xpub
// derivation. The seed is derived with Node's PBKDF2 (not @noble, which is what
// verifyEntropy uses), so the expected xpubs are computed independently of the
// seed code path under test.
const computeExtended = (
    internalHex: string,
    externalHex: string,
    // 'base' is what the firmware actually does: derive from sub-phrase 1 alone.
    // 'concatenated' reproduces the pre-fix behaviour so a regression test can
    // assert that those xpubs are now rejected.
    phraseUnderTest: 'base' | 'concatenated' = 'base',
) => {
    const internal = Buffer.from(internalHex, 'hex');
    const external = Buffer.from(externalHex, 'hex');

    // 3 sub-secrets (matches firmware reset_device._compute_secret_from_entropy)
    const sub = Math.floor(internal.length / 3);
    const parts: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
        const subInternal = internal.subarray(i * sub, (i + 1) * sub);
        const subSecret = sha256(Buffer.concat([subInternal, external, Buffer.from([i])]));
        parts.push(Buffer.from(subSecret.subarray(0, sub)));
    }
    const secret = Buffer.concat(parts);

    const subLen = Math.floor(secret.length / 3);
    const phrases: string[] = [];
    for (let i = 0; i < 3; i++) {
        const subSecret = Buffer.from(secret.subarray(i * subLen, (i + 1) * subLen));
        phrases.push(entropyToMnemonic(subSecret, [...bip39]));
    }

    // Independent PBKDF2 (Node/OpenSSL) — must match what verifyEntropy derives.
    // The device hashes only the base phrase (core `bip39_base_phrase`).
    const words = phraseUnderTest === 'base' ? phrases[0] : phrases.join(' ');
    const seed = pbkdf2Sync(
        words.normalize('NFKD'),
        'mnemonic'.normalize('NFKD'),
        2048,
        64,
        'sha512',
    );
    const node = bip32.fromSeed(seed);

    return {
        commitment: Buffer.from(hmac(sha256, internal, Buffer.alloc(0))).toString('hex'),
        xpubs: {
            "m/84'/0'/0'": node.derivePath("m/84'/0'/0'").neutered().toBase58(),
            "m/44'/60'/0'": node.derivePath("m/44'/60'/0'").neutered().toBase58(),
        },
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

    it('bip39 extended (SPHINCS+ 768-bit) success', async () => {
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment, xpubs } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs,
        });
        expect(response.success).toEqual(true);
    });

    it('bip39 extended rejects a wrong xpub (comparison is real, not a no-op)', async () => {
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment, xpubs } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            // swap the two paths' xpubs so neither matches its path anymore
            xpubs: {
                "m/84'/0'/0'": xpubs["m/44'/60'/0'"],
                "m/44'/60'/0'": xpubs["m/84'/0'/0'"],
            },
        });
        expect(response.success).toEqual(false);
    });

    it('bip39 extended (SPHINCS+ 384-bit) success', async () => {
        // The smallest extended strength: sub-phrases are 12 words, so the base
        // phrase takes a different `subLength` branch than the 768-bit case.
        const trezorEntropy = '3a'.repeat(48);
        const hostEntropy = '5c'.repeat(32);
        const { commitment, xpubs } = computeExtended(trezorEntropy, hostEntropy);

        const response = await verifyEntropy({
            strength: 384,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs,
        });
        expect(response.success).toEqual(true);
    });

    it('bip39 extended rejects xpubs derived from the concatenated phrase', async () => {
        // Regression guard for the base-phrase rule. Deriving over all 72 words
        // is exactly what this code did before the fix, and it made every
        // SPHINCS+ wallet creation fail against real firmware.
        const trezorEntropy = 'ab'.repeat(96);
        const hostEntropy = 'cd'.repeat(32);
        const { commitment } = computeExtended(trezorEntropy, hostEntropy);
        const { xpubs } = computeExtended(trezorEntropy, hostEntropy, 'concatenated');

        const response = await verifyEntropy({
            strength: 768,
            hostEntropy,
            commitment,
            trezorEntropy,
            xpubs,
        });
        expect(response.success).toEqual(false);
    });
});
