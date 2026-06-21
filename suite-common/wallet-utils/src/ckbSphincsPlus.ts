// Shared metadata for all 12 SLH-DSA (SPHINCS+) variants used by the
// quantum-purse CKB lock script. Kept in wallet-utils so that onboarding,
// account creation, and the CKB signer all see the exact same values.

export type SphincsHashFamily = 'sha2' | 'shake';
export type SphincsSpeedProfile = 'small' | 'fast';
export type SphincsSecurityLevel = 128 | 192 | 256;

export interface SphincsVariantInfo {
    id: number; // Protocol variant ID (48-59).
    name: string; // e.g. "sha2-128s".
    securityLevel: SphincsSecurityLevel;
    hashFamily: SphincsHashFamily;
    speedProfile: SphincsSpeedProfile;
    spxN: 16 | 24 | 32; // Security parameter n, in bytes.
    publicKeyBytes: 32 | 48 | 64;
    signatureBytes: number;
    witnessLockBytes: number; // header(5) + pk + signature.
}

function variant(
    id: number,
    name: string,
    securityLevel: SphincsSecurityLevel,
    hashFamily: SphincsHashFamily,
    speedProfile: SphincsSpeedProfile,
    spxN: 16 | 24 | 32,
    signatureBytes: number,
): SphincsVariantInfo {
    const publicKeyBytes = (spxN * 2) as 32 | 48 | 64;

    return {
        id,
        name,
        securityLevel,
        hashFamily,
        speedProfile,
        spxN,
        publicKeyBytes,
        signatureBytes,
        witnessLockBytes: 5 + publicKeyBytes + signatureBytes,
    };
}

// Signature sizes come straight from sphincsplus_dispatch.c (firmware) and
// match fips205 Rust crate. Keep this table the single source of truth.
export const SPHINCS_PLUS_VARIANTS: readonly SphincsVariantInfo[] = [
    variant(48, 'sha2-128f', 128, 'sha2', 'fast', 16, 17088),
    variant(49, 'sha2-128s', 128, 'sha2', 'small', 16, 7856),
    variant(50, 'sha2-192f', 192, 'sha2', 'fast', 24, 35664),
    variant(51, 'sha2-192s', 192, 'sha2', 'small', 24, 16224),
    variant(52, 'sha2-256f', 256, 'sha2', 'fast', 32, 49856),
    variant(53, 'sha2-256s', 256, 'sha2', 'small', 32, 29792),
    variant(54, 'shake-128f', 128, 'shake', 'fast', 16, 17088),
    variant(55, 'shake-128s', 128, 'shake', 'small', 16, 7856),
    variant(56, 'shake-192f', 192, 'shake', 'fast', 24, 35664),
    variant(57, 'shake-192s', 192, 'shake', 'small', 24, 16224),
    variant(58, 'shake-256f', 256, 'shake', 'fast', 32, 49856),
    variant(59, 'shake-256s', 256, 'shake', 'small', 32, 29792),
];

const byId = new Map(SPHINCS_PLUS_VARIANTS.map(v => [v.id, v]));

export const getSphincsVariantInfo = (id: number): SphincsVariantInfo | undefined => byId.get(id);

export const DEFAULT_SPHINCS_PLUS_VARIANT = 49; // sha2-128s

// Mapping between CKB SPHINCS+ account type identifiers (used in
// `AccountType` / `networksConfig.accountTypes`) and their FIPS 205 variant
// IDs. Each account type encodes the security level + hash family + speed
// profile. A copy lives in `packages/connect/src/utils/coinInfoUtils.ts`
// (connect cannot import wallet-utils); keep the two in sync manually.
export const SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT = {
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
} as const;

export const isSphincsPlusAccountType = (accountType: string | undefined): boolean =>
    accountType !== undefined && Object.hasOwn(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT, accountType);

export const sphincsVariantFromAccountType = (
    accountType: string | undefined,
): number | undefined => {
    if (
        accountType === undefined ||
        !Object.hasOwn(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT, accountType)
    ) {
        return undefined;
    }

    return (SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT as Record<string, number>)[accountType];
};

export const sphincsLevelFromAccountType = (
    accountType: string | undefined,
): SphincsSecurityLevel | undefined => {
    const variantId = sphincsVariantFromAccountType(accountType);
    if (variantId === undefined) return undefined;
    const info = getSphincsVariantInfo(variantId);

    return info?.securityLevel;
};

/**
 * Compact display name used in UI to tell the 12 SPHINCS+ variants apart
 * without spelling out "Quantum-Safe" every time. `sha2-128s` → `SHA2_128s`,
 * `shake-192f` → `SHAKE_192f`. Returns `undefined` for non-SPHINCS+ account
 * types.
 */
export const getSphincsShortName = (accountType: string | undefined): string | undefined => {
    const variantId = sphincsVariantFromAccountType(accountType);
    if (variantId === undefined) return undefined;
    const info = getSphincsVariantInfo(variantId);
    if (!info) return undefined;
    const [family, levelProfile] = info.name.split('-');

    return `${family.toUpperCase()}_${levelProfile}`;
};
