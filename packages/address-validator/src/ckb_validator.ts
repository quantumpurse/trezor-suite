import { bech32, bech32m } from '@scure/base';

import { addressType } from './crypto/utils';
import type { Currency } from './currency-types';

const ADDRESS_BECH32_LIMIT = 1023;

export const isValidAddress = (address: string, _currency?: Currency, networkType?: string): boolean => {
    const hrp = networkType === 'testnet' ? 'ckt' : 'ckb';

    let decoded;
    try {
        decoded = bech32m.decode(address as `${string}1${string}`, ADDRESS_BECH32_LIMIT);
    } catch {
        try {
            decoded = bech32.decode(address as `${string}1${string}`, ADDRESS_BECH32_LIMIT);
        } catch {
            return false;
        }
    }

    if (decoded.prefix !== hrp || decoded.words.length < 1) {
        return false;
    }

    return true;
};

export const getAddressType = (address: string, currency?: Currency, networkType?: string) => {
    if (isValidAddress(address, currency, networkType)) {
        return addressType.ADDRESS;
    }

    return undefined;
};
