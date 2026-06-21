import {
    DEFAULT_SPHINCS_PLUS_VARIANT,
    SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT,
    SPHINCS_PLUS_VARIANTS,
    getSphincsShortName,
    getSphincsVariantInfo,
    isSphincsPlusAccountType,
    sphincsLevelFromAccountType,
    sphincsVariantFromAccountType,
} from '../ckbSphincsPlus';

describe('ckbSphincsPlus variant catalog', () => {
    // Golden table matching quantum-purse/key-vault-wasm (fips205 crate) and
    // trezor-firmware/crypto/sphincsplus_dispatch.c. Any drift here means
    // host-built witness placeholder will not match what the firmware signs.
    const GOLDEN = [
        { id: 48, name: 'sha2-128f', n: 16, sig: 17088 },
        { id: 49, name: 'sha2-128s', n: 16, sig: 7856 },
        { id: 50, name: 'sha2-192f', n: 24, sig: 35664 },
        { id: 51, name: 'sha2-192s', n: 24, sig: 16224 },
        { id: 52, name: 'sha2-256f', n: 32, sig: 49856 },
        { id: 53, name: 'sha2-256s', n: 32, sig: 29792 },
        { id: 54, name: 'shake-128f', n: 16, sig: 17088 },
        { id: 55, name: 'shake-128s', n: 16, sig: 7856 },
        { id: 56, name: 'shake-192f', n: 24, sig: 35664 },
        { id: 57, name: 'shake-192s', n: 24, sig: 16224 },
        { id: 58, name: 'shake-256f', n: 32, sig: 49856 },
        { id: 59, name: 'shake-256s', n: 32, sig: 29792 },
    ] as const;

    it('contains all 12 variants in the expected order', () => {
        expect(SPHINCS_PLUS_VARIANTS).toHaveLength(GOLDEN.length);
        GOLDEN.forEach((g, i) => {
            const v = SPHINCS_PLUS_VARIANTS[i];
            expect(v.id).toBe(g.id);
            expect(v.name).toBe(g.name);
            expect(v.spxN).toBe(g.n);
            expect(v.publicKeyBytes).toBe(g.n * 2);
            expect(v.signatureBytes).toBe(g.sig);
            // witness-lock bytes = 5-byte all-in-one header + pubkey + signature.
            expect(v.witnessLockBytes).toBe(5 + g.n * 2 + g.sig);
        });
    });

    it('defaults to sha2-128s (id 49)', () => {
        expect(DEFAULT_SPHINCS_PLUS_VARIANT).toBe(49);
        const info = getSphincsVariantInfo(DEFAULT_SPHINCS_PLUS_VARIANT);
        expect(info?.name).toBe('sha2-128s');
    });

    it('looks variants up by id', () => {
        expect(getSphincsVariantInfo(49)?.name).toBe('sha2-128s');
        expect(getSphincsVariantInfo(58)?.name).toBe('shake-256f');
        expect(getSphincsVariantInfo(0)).toBeUndefined();
    });
});

describe('SPHINCS+ account-type mapping', () => {
    // Each account type must map to exactly one variant and vice versa.
    it('has 12 account types, one per variant', () => {
        expect(Object.keys(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT)).toHaveLength(12);
        expect(new Set(Object.values(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT)).size).toBe(12);
    });

    it('maps each account type to the expected variant ID', () => {
        // Reproduce the table here so a wrong commit shows up as a diff in
        // the test file, not silently in the implementation.
        expect(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT).toEqual({
            sphincsPlus128Sha2S: 49,
            sphincsPlus128Sha2F: 48,
            sphincsPlus128ShakeS: 55,
            sphincsPlus128ShakeF: 54,
            sphincsPlus192Sha2S: 51,
            sphincsPlus192Sha2F: 50,
            sphincsPlus192ShakeS: 57,
            sphincsPlus192ShakeF: 56,
            sphincsPlus256Sha2S: 53,
            sphincsPlus256Sha2F: 52,
            sphincsPlus256ShakeS: 59,
            sphincsPlus256ShakeF: 58,
        });
    });

    it('variant IDs from the map exist in the variant catalog', () => {
        const variantIds = Object.values(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT);
        expect(variantIds).toHaveLength(12);
        for (const variantId of variantIds) {
            expect(getSphincsVariantInfo(variantId)).toBeDefined();
        }
    });

    it('isSphincsPlusAccountType accepts all 12 types and rejects others', () => {
        const accountTypes = Object.keys(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT);
        expect(accountTypes).toHaveLength(12);
        for (const type of accountTypes) {
            expect(isSphincsPlusAccountType(type)).toBe(true);
        }
        expect(isSphincsPlusAccountType('normal')).toBe(false);
        expect(isSphincsPlusAccountType('segwit')).toBe(false);
        expect(isSphincsPlusAccountType(undefined)).toBe(false);
        // Object.prototype member names must not pass through the prototype chain.
        expect(isSphincsPlusAccountType('toString')).toBe(false);
        expect(isSphincsPlusAccountType('constructor')).toBe(false);
        expect(isSphincsPlusAccountType('hasOwnProperty')).toBe(false);
        expect(isSphincsPlusAccountType('__proto__')).toBe(false);
    });

    it('sphincsVariantFromAccountType returns ID or undefined', () => {
        expect(sphincsVariantFromAccountType('sphincsPlus192Sha2F')).toBe(50);
        expect(sphincsVariantFromAccountType('normal')).toBeUndefined();
        expect(sphincsVariantFromAccountType(undefined)).toBeUndefined();
        expect(sphincsVariantFromAccountType('toString')).toBeUndefined();
        expect(sphincsVariantFromAccountType('constructor')).toBeUndefined();
    });

    it('sphincsLevelFromAccountType extracts 128/192/256', () => {
        expect(sphincsLevelFromAccountType('sphincsPlus128Sha2S')).toBe(128);
        expect(sphincsLevelFromAccountType('sphincsPlus192ShakeF')).toBe(192);
        expect(sphincsLevelFromAccountType('sphincsPlus256Sha2F')).toBe(256);
        expect(sphincsLevelFromAccountType('normal')).toBeUndefined();
        expect(sphincsLevelFromAccountType('toString')).toBeUndefined();
    });

    it('getSphincsShortName builds the compact display name', () => {
        expect(getSphincsShortName('sphincsPlus128Sha2S')).toBe('SHA2_128s');
        expect(getSphincsShortName('sphincsPlus192ShakeF')).toBe('SHAKE_192f');
        expect(getSphincsShortName('sphincsPlus256Sha2F')).toBe('SHA2_256f');
        expect(getSphincsShortName('normal')).toBeUndefined();
        expect(getSphincsShortName(undefined)).toBeUndefined();
        expect(getSphincsShortName('toString')).toBeUndefined();
    });
});
