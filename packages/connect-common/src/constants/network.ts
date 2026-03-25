export const TYPES = {
    bitcoin: 'Bitcoin',
    ckb: 'Nervos CKB',
    ethereum: 'Ethereum',
    stellar: 'Stellar',
    cardano: 'Cardano',
    ripple: 'Ripple',
    tezos: 'Tezos',
    tron: 'Tron',
    binance: 'Binance',
    solana: 'Solana',
} as const;

export type NetworkType = keyof typeof TYPES;

export const MODULES = [
    'cardano',
    'ckb',
    'ethereum',
    'monero',
    'ripple',
    'solana',
    'stellar',
    'tezos',
    'tron',
] as const;

export type ModuleName = (typeof MODULES)[number];
