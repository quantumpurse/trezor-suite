import { type AccountType, type NetworkType } from '@suite-common/wallet-config';

export const ACCOUNTS_MODULE_PREFIX = '@common/wallet-core/accounts';

export const formattedAccountTypeMap: Partial<
    Record<NetworkType, Partial<Record<AccountType, string>>>
> = {
    bitcoin: {
        normal: 'SegWit',
        taproot: 'Taproot',
        segwit: 'Legacy SegWit',
        legacy: 'Legacy',
    },
    cardano: {
        legacy: 'Legacy',
        ledger: 'Ledger',
    },
    ethereum: {
        legacy: 'Legacy',
        ledger: 'Ledger',
    },
    solana: {
        ledger: 'Ledger',
    },
    ckb: {
        normal: 'ECDSA',
        // All 12 SPHINCS+ variants share one display label — the variant
        // detail is surfaced in AccountTypeSelect's secondary text.
        sphincsPlus128Sha2S: 'SPHINCS+',
        sphincsPlus128Sha2F: 'SPHINCS+',
        sphincsPlus128ShakeS: 'SPHINCS+',
        sphincsPlus128ShakeF: 'SPHINCS+',
        sphincsPlus192Sha2S: 'SPHINCS+',
        sphincsPlus192Sha2F: 'SPHINCS+',
        sphincsPlus192ShakeS: 'SPHINCS+',
        sphincsPlus192ShakeF: 'SPHINCS+',
        sphincsPlus256Sha2S: 'SPHINCS+',
        sphincsPlus256Sha2F: 'SPHINCS+',
        sphincsPlus256ShakeS: 'SPHINCS+',
        sphincsPlus256ShakeF: 'SPHINCS+',
    },
};
