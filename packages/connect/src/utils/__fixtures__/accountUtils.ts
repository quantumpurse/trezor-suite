import { getBitcoinNetwork, getEthereumNetwork, getMiscNetwork } from '../../data/coinInfo';
import type { getAccountLabel, isUtxoBased } from '../accountUtils';
import { toHardened } from '../pathUtils';

export const getAccountLabelFixtures: TestFixtures<typeof getAccountLabel> = [
    {
        description: 'Legacy',
        input: [[44], getBitcoinNetwork('btc')!],
        output: 'legacy account #1',
    },
    {
        description: 'ckb',
        input: [[toHardened(44), toHardened(309), toHardened(0)], getMiscNetwork('ckb')!],
        output: 'account #1',
    },
];

export const isUtxoBasedFixtures: TestFixtures<typeof isUtxoBased> = [
    {
        description: 'btc',
        input: [getBitcoinNetwork('btc')!],
        output: true,
    },
    {
        description: 'ada',
        input: [getMiscNetwork('ada')!],
        output: true,
    },
    {
        description: 'ckb',
        input: [getMiscNetwork('ckb')!],
        output: true,
    },
    {
        description: 'eth',
        input: [getEthereumNetwork('eth')!],
        output: false,
    },
];
