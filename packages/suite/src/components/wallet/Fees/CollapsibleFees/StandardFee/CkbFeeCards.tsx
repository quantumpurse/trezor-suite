import { Translation } from '@suite/intl';
import { selectAreFeesLoading, useDisplayBaseCurrency } from '@suite-common/wallet-core';
import { getFeeUnits } from '@suite-common/wallet-utils';
import { Text } from '@trezor/components';

import { BaseCurrencyValue } from 'src/components/suite/BaseCurrencyValue';
import { useSelector } from 'src/hooks/suite';

import { FeeCard } from './FeeCard';
import { FeeCardsWrapper } from './StandardFee.styles';
import { feeLevelTranslationMap } from './constants';
import { type FeeOptionType } from './hooks/useNetworkFeeOptions';
import { useFeesContext } from '../../context/FeesContext';

type CkbFeeCardsProps = {
    feeOptions: FeeOptionType[];
};

export const CkbFeeCards = ({ feeOptions }: CkbFeeCardsProps) => {
    const { networkType, networkSymbol, changeFeeLevel, selectedFeeLevel } = useFeesContext();
    const areFeesLoading = useSelector(state => selectAreFeesLoading(state, networkSymbol));
    const { shallDisplayBaseCurrency } = useDisplayBaseCurrency(networkSymbol);

    if (!selectedFeeLevel) {
        return null;
    }

    return (
        <FeeCardsWrapper data-testid="@wallet/fee-details">
            {feeOptions.map(fee => (
                <FeeCard
                    data-testid={`@fee-card/${fee.value}-card`}
                    key={fee.value}
                    value={fee.value}
                    isSelected={selectedFeeLevel.label === fee.value}
                    changeFeeLevel={changeFeeLevel}
                    isLoading={areFeesLoading}
                    topLeftChild={
                        <span data-testid={`@fee-card/${fee.value}`}>
                            <Translation id={feeLevelTranslationMap[fee.value]} />
                        </span>
                    }
                    bottomLeftChild={
                        shallDisplayBaseCurrency && (
                            <BaseCurrencyValue
                                disableHiddenPlaceholder
                                amount={fee?.networkAmount ?? ''}
                                symbol={networkSymbol}
                                showApproximationIndicator
                            />
                        )
                    }
                    bottomRightChild={
                        <Text intent="neutral" priority="secondary">
                            {fee.feePerUnit} {getFeeUnits(networkType)}
                        </Text>
                    }
                />
            ))}
        </FeeCardsWrapper>
    );
};
