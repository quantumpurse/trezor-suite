import { memo } from 'react';

import styled from 'styled-components';

import { Translation } from '@suite/intl';
import {
    type NetworkAccount,
    type NetworkSymbol,
    type NetworkType,
} from '@suite-common/wallet-config';
import {
    getAccountTypeName,
    getAccountTypeTech,
    getSphincsShortName,
    sphincsLevelFromAccountType,
} from '@suite-common/wallet-utils';
import { Column, Paragraph, Select, Text } from '@trezor/components';
import { spacings, typography } from '@trezor/theme';

import { AccountTypeDescription } from './AccountTypeDescription';

const WORDS_BY_LEVEL: Record<number, number> = {
    128: 36,
    192: 54,
    256: 72,
};

type FlatOption = {
    value: NetworkAccount;
    label: string;
};

type GroupedOption = {
    label: string;
    options: FlatOption[];
};

const buildCkbOptions = (accountTypes: NetworkAccount[]): Array<FlatOption | GroupedOption> => {
    const flat: FlatOption[] = [];
    const buckets: Record<128 | 192 | 256, FlatOption[]> = { 128: [], 192: [], 256: [] };

    for (const a of accountTypes) {
        const level = sphincsLevelFromAccountType(a.accountType);
        const option: FlatOption = { value: a, label: a.accountType };
        if (level === undefined) {
            flat.push(option);
        } else {
            buckets[level].push(option);
        }
    }

    const groups: GroupedOption[] = ([128, 192, 256] as const)
        .filter(level => buckets[level].length > 0)
        .map(level => ({
            label: `${level}-bit | ${WORDS_BY_LEVEL[level]}-word mnemonic`,
            options: buckets[level],
        }));

    return [...flat, ...groups];
};

const LabelWrapper = styled.div`
    display: flex;
    align-items: baseline;
`;

const TypeInfo = styled.div`
    display: flex;
    flex: 1;
    margin-left: 1ch;
    color: ${({ theme }) => theme.contentSecondary};
    ${typography['body-xs']}
`;

interface AccountTypeSelectProps {
    accountTypes: NetworkAccount[];
    networkType: NetworkType;
    symbol: NetworkSymbol;
    onSelectAccountType: (account: NetworkAccount) => void;
    selectedAccountType?: NetworkAccount;
}

const AccountTypeSelectComponent = ({
    selectedAccountType,
    accountTypes,
    networkType,
    symbol,
    onSelectAccountType,
}: AccountTypeSelectProps) => {
    const buildAccountTypeOption = (account: NetworkAccount): FlatOption => ({
        value: account,
        label: account.accountType,
    });

    const formatLabel = (option: FlatOption) => {
        const { accountType } = option.value;

        const sphincsName = getSphincsShortName(accountType);
        if (sphincsName) {
            return <Text typographyStyle="body-md">{sphincsName}</Text>;
        }

        const accountTypeName = getAccountTypeName({
            path: option.value.bip43Path,
            accountType,
            networkType,
        });

        return (
            <LabelWrapper>
                {accountTypeName && <Translation id={accountTypeName} />}
                <TypeInfo>
                    <Translation
                        id={getAccountTypeTech(option.value.bip43Path, networkType, accountType)}
                    />
                </TypeInfo>
            </LabelWrapper>
        );
    };

    const formatGroupLabel = (group: { label?: string }) => (
        <Text typographyStyle="body-xs" intent="neutral" priority="secondary">
            {group.label}
        </Text>
    );

    const options =
        networkType === 'ckb'
            ? buildCkbOptions(accountTypes)
            : accountTypes.map(buildAccountTypeOption);

    // the default, 'normal' account type is expected to be the first one
    const defaultAccountType = accountTypes[0];
    const value = buildAccountTypeOption(selectedAccountType ?? defaultAccountType);

    const bip43PathToDescribe = selectedAccountType?.bip43Path ?? defaultAccountType.bip43Path;

    return (
        <Column alignItems="center" gap={spacings.md}>
            <Select
                data-testid="@add-account-type/select"
                label={<Translation id="TR_ACCOUNT_TYPE" />}
                isSearchable={false}
                isClearable={false}
                value={value}
                options={options}
                formatOptionLabel={formatLabel}
                formatGroupLabel={formatGroupLabel}
                onChange={(option: FlatOption) => onSelectAccountType(option.value)}
                openMenuOnFocus={false}
            />
            <Paragraph intent="neutral" priority="secondary" typographyStyle="body-sm">
                <AccountTypeDescription
                    bip43Path={bip43PathToDescribe}
                    accountType={selectedAccountType?.accountType || 'normal'}
                    networkType={networkType}
                    symbol={symbol}
                />
            </Paragraph>
        </Column>
    );
};

export const AccountTypeSelect = memo(AccountTypeSelectComponent);
