const { bech32, bech32m } = require('@scure/base');
const { addressType } = require('./crypto/utils');

var ADDRESS_BECH32_LIMIT = 1023;

module.exports = {
    isValidAddress: function (address, currency, networkType) {
        var hrp = networkType === 'testnet' ? 'ckt' : 'ckb';

        var decoded;
        try {
            decoded = bech32m.decode(address, ADDRESS_BECH32_LIMIT);
        } catch (_) {
            try {
                decoded = bech32.decode(address, ADDRESS_BECH32_LIMIT);
            } catch (_) {
                return false;
            }
        }

        if (decoded.prefix !== hrp || decoded.words.length < 1) {
            return false;
        }

        return true;
    },

    getAddressType: function (address, currency, networkType) {
        if (this.isValidAddress(address, currency, networkType)) {
            return addressType.ADDRESS;
        }

        return undefined;
    },
};
