import { useCallback } from 'react';

import { useTranslation } from '@suite/intl';
import { type AccountType, type NetworkSymbol, getNetwork } from '@suite-common/wallet-config';
import { getSphincsShortName, getTitleForCoinjoinAccount } from '@suite-common/wallet-utils';

export interface GetDefaultAccountLabelParams {
    accountType: AccountType;
    symbol: NetworkSymbol;
    index?: number;
}

export const useDefaultAccountLabel = () => {
    const { translationString } = useTranslation();

    const getDefaultAccountLabel = useCallback(
        ({ accountType, symbol, index = 0 }: GetDefaultAccountLabelParams): string => {
            if (accountType === 'coinjoin') {
                return translationString(getTitleForCoinjoinAccount(symbol));
            }

            const displayedAccountNumber = index + 1;
            const baseLabel = translationString('LABELING_ACCOUNT', {
                networkName: getNetwork(symbol).name,
                index: displayedAccountNumber,
            });

            const sphincsTag = getSphincsShortName(accountType);
            if (sphincsTag) {
                return `${baseLabel} · ${sphincsTag}`;
            }

            return baseLabel;
        },
        [translationString],
    );

    return {
        getDefaultAccountLabel,
    };
};
