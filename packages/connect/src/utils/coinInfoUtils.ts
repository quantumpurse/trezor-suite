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
