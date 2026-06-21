type CoinInfoLike = {
    shortcut: string;
    blockchainLink?: {
        type: string;
    };
};

export const isCkbCoin = (coinInfo?: CoinInfoLike) => {
    if (!coinInfo) {
        return false;
    }

    return (
        coinInfo.blockchainLink?.type === 'ckb' ||
        coinInfo.shortcut === 'CKB' ||
        coinInfo.shortcut === 'tCKB'
    );
};

// CKB SPHINCS+ account type → FIPS 205 variant ID. A copy is kept here to avoid
// `@trezor/connect` depending on `@suite-common/wallet-utils`; this copy and the
// one in suite-common/wallet-utils/src/ckbSphincsPlus.ts are kept in sync manually.
const SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT: Record<string, number> = {
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
};

export const sphincsVariantFromAccountType = (accountType?: string): number | undefined =>
    accountType !== undefined && Object.hasOwn(SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT, accountType)
        ? SPHINCS_PLUS_ACCOUNT_TYPE_TO_VARIANT[accountType]
        : undefined;
