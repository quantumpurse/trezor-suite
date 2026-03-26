import coinsJSON from '@trezor/connect-data/files/coins.json';

import { toHardened } from '../../utils/pathUtils';
import {
    getAllNetworks,
    getCoinInfo,
    getCoinName,
    getUniqueNetworks,
    parseCoinsJson,
} from '../coinInfo';

describe('data/coinInfo', () => {
    beforeAll(() => {
        parseCoinsJson(coinsJSON);
    });

    it('getUniqueNetworks', () => {
        const inputs = [
            getCoinInfo('btc'),
            getCoinInfo('ltc'),
            getCoinInfo('btc'),
            getCoinInfo('ltc'),
            getCoinInfo('ltc'),
        ];
        const result = [getCoinInfo('btc'), getCoinInfo('ltc')];
        expect(getUniqueNetworks(inputs)).toEqual(result);
    });

    it('bitcoin network blocktime', () => {
        const bitcoinNetworks = getAllNetworks().filter(({ type }) => type === 'bitcoin');
        bitcoinNetworks.forEach(network => {
            expect(network.blockTime).toBeGreaterThan(0);
        });
    });

    it('returns CKB as misc network', () => {
        expect(getCoinInfo('ckb')).toMatchObject({
            name: 'Nervos CKB',
            shortcut: 'CKB',
            type: 'misc',
        });
    });

    it('resolves CKB coin name from path', () => {
        expect(getCoinName([toHardened(44), toHardened(309), toHardened(0)])).toBe('Nervos CKB');
    });
});
