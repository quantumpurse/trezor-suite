import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToSeed } from '@scure/bip39';

import { bip39 } from '@trezor/crypto-utils';
import { MessagesSchema as PROTO } from '@trezor/protobuf';
import { bip32 } from '@trezor/utxo-lib';

export const generateEntropy = (len: number) => {
    try {
        return Buffer.from(randomBytes(len));
    } catch {
        throw new Error('generateEntropy: Environment does not support crypto random');
    }
};

// https://github.com/trezor/python-shamir-mnemonic/blob/master/shamir_mnemonic/cipher.py
const BASE_ITERATION_COUNT = 10000;
const ROUND_COUNT = 4;

// https://github.com/trezor/python-shamir-mnemonic/blob/master/shamir_mnemonic/cipher.py
const roundFunction = async (i: number, passphrase: Buffer, e: number, salt: Buffer, r: Buffer) => {
    const data = Buffer.concat([Buffer.from([i]), passphrase]);
    const iterations = Math.floor((BASE_ITERATION_COUNT << e) / ROUND_COUNT);

    // '@noble/hashes/pbkdf2' takes ~ 8sec. in the web build
    // const result = pbkdf2(sha256, data, Buffer.concat([salt, r]), {
    //     c: iterations,
    //     dkLen: r.length,
    // });

    // Nodejs only
    // return crypto.pbkdf2Sync(data, Buffer.concat([salt, r]), iterations, r.length, 'sha256');

    // Nodejs + WebCrypto equivalent
    const { subtle } = crypto as Crypto;
    const key = await subtle.importKey('raw', data, 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
        {
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt: Buffer.concat([salt, r]),
            iterations,
        },
        key,
        r.length * 8,
    );

    return Buffer.from(bits);
};

// https://github.com/trezor/python-shamir-mnemonic/blob/master/shamir_mnemonic/cipher.py
const xor = (a: Buffer, b: Buffer) => {
    if (a.length !== b.length) {
        throw new Error('Buffers must be of equal length to XOR.');
    }
    const result = Buffer.alloc(a.length);
    for (let i = 0; i < a.length; i++) {
        result[i] = a[i] ^ b[i];
    }

    return result;
};

// https://github.com/trezor/python-shamir-mnemonic/blob/master/shamir_mnemonic/cipher.py
// simplified "decrypt" function
const entropyToSeedSlip39 = async (encryptedSecret: Buffer) => {
    const iterationExponent = 1;
    // const identifier = 0;
    // const extendable = true,
    const passphrase = Buffer.from('', 'utf-8'); // empty passphrase
    const salt = Buffer.alloc(0); // extendable: True => no salt

    const half = Math.floor(encryptedSecret.length / 2);
    let l = encryptedSecret.subarray(0, half);
    let r = encryptedSecret.subarray(half);
    for (let round = ROUND_COUNT - 1; round >= 0; round--) {
        const f = await roundFunction(round, passphrase, iterationExponent, salt, r);
        const rr = xor(l, f);
        l = r;
        r = rr;
    }

    return Buffer.concat([r, l]);
};

const getEntropy = (trezorEntropy: string, hostEntropy: string, strength: number) => {
    const internalEntropy = Buffer.from(trezorEntropy, 'hex');
    const externalEntropy = Buffer.from(hostEntropy, 'hex');
    const strengthBytes = Math.floor(strength / 8);

    if (strengthBytes <= 32) {
        const entropy = sha256(Buffer.concat([internalEntropy, externalEntropy]));

        return Buffer.from(entropy.subarray(0, strengthBytes));
    }

    // Extended strength (384/576/768 bits): 3 sub-secrets, each from its own
    // internal-entropy slice plus a 1-byte domain separator. Must match the
    // firmware's reset_device._compute_secret_from_entropy so host and device
    // compute the same secret during the entropy check.
    const subStrength = Math.floor(strengthBytes / 3);
    const parts: Buffer[] = [];
    for (let i = 0; i < 3; i++) {
        const subInternal = internalEntropy.subarray(i * subStrength, (i + 1) * subStrength);
        const subSecret = sha256(Buffer.concat([subInternal, externalEntropy, Buffer.from([i])]));
        parts.push(Buffer.from(subSecret.subarray(0, subStrength)));
    }

    return Buffer.concat(parts);
};

const computeSeed = (type: VerifyEntropyOptions['type'], secret: Buffer) => {
    const BackupType = PROTO.Enum_BackupType;
    if (
        type &&
        [
            BackupType.Slip39_Basic,
            BackupType.Slip39_Advanced,
            BackupType.Slip39_Single_Extendable,
            BackupType.Slip39_Basic_Extendable,
            BackupType.Slip39_Advanced_Extendable,
        ].includes(type)
    ) {
        // use slip39
        return entropyToSeedSlip39(secret);
    }

    // use bip39
    if (secret.length <= 32) {
        return mnemonicToSeed(entropyToMnemonic(secret, [...bip39])).then(seed =>
            Buffer.from(seed),
        );
    }

    // Extended BIP-39 mnemonic (384/576/768 bits): 3 concatenated standard
    // BIP-39 phrases. The device derives every BIP-32 wallet from the FIRST
    // sub-phrase alone (core `storage.device.bip39_base_phrase`), so the seed
    // behind the entropy-check xpubs must come from that phrase only, never
    // from the 36/54/72-word concatenation. Mirrors trezorlib's
    // `_seed_from_entropy`; the other two sub-phrases feed SPHINCS+ only and
    // are outside what this workflow can prove.
    const subLength = Math.floor(secret.length / 3);
    const basePhrase = entropyToMnemonic(Buffer.from(secret.subarray(0, subLength)), [
        ...bip39,
    ]);

    // The base phrase is a standard 12/18/24-word mnemonic, so the ordinary
    // BIP-39 seed derivation applies.
    return mnemonicToSeed(basePhrase).then(seed => Buffer.from(seed));
};

const verifyCommitment = (entropy: string, commitment: string) => {
    const hmacDigest = hmac(sha256, Buffer.from(entropy, 'hex'), Buffer.alloc(0));
    if (!Buffer.from(hmacDigest).equals(Buffer.from(commitment, 'hex'))) {
        throw new Error('Invalid entropy commitment');
    }
};

type VerifyEntropyOptions = {
    type?: PROTO.Enum_BackupType; // ResetDevice.backup_type
    strength?: number; // ResetDevice.strength
    commitment?: string; // entropy_commitment received from previous EntropyRequest
    hostEntropy: string; // host_entropy used in previous EntropyAck
    trezorEntropy?: string; // prev_entropy received from current EntropyRequest, after ResetDeviceContinue
    xpubs: Record<string, string>; // <Bip43 path, xpub>
};

export const verifyEntropy = async ({
    type,
    strength,
    trezorEntropy,
    hostEntropy,
    commitment,
    xpubs,
}: VerifyEntropyOptions) => {
    try {
        if (!trezorEntropy || !commitment || !strength || Object.keys(xpubs).length < 1) {
            throw new Error('Missing verifyEntropy data');
        }

        verifyCommitment(trezorEntropy, commitment);
        // compute seed
        const secret = getEntropy(trezorEntropy, hostEntropy, strength);
        const seed = await computeSeed(type, secret);

        // derive xpubs and compare with FW results
        const node = bip32.fromSeed(seed);
        Object.keys(xpubs).forEach(path => {
            const pubKey = node.derivePath(path);
            const xpub = pubKey.neutered().toBase58();
            if (xpub !== xpubs[path]) {
                throw new Error('verifyEntropy xpub mismatch');
            }
        });

        return { success: true as const };
    } catch (error) {
        return { success: false as const, error: error.message };
    }
};
