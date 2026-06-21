import { Translation } from '@suite/intl';
import { selectSelectedDevice } from '@suite-common/device';
import { type BackupType } from '@suite-common/suite-types';
import { Badge } from '@trezor/components';
import { DeviceModelInternal, getFirmwareVersion } from '@trezor/device-utils';
import { spacings } from '@trezor/theme';

import { OptionWithContent } from './OptionWithContent';
import { useLayoutSize, useSelector } from '../../../../hooks/suite';

const RecommendedTag = () => {
    const { isBelowTablet } = useLayoutSize();

    return (
        <Badge
            intent="neutral"
            margin={{ left: spacings.xs }}
            size={isBelowTablet ? 'small' : undefined}
        >
            <Translation id="TR_ONBOARDING_SPHINCS_PLUS_RECOMMENDED" />
        </Badge>
    );
};

type SphincsPlusOptionsProps = {
    selected: BackupType;
    onSelect: (value: BackupType) => void;
};

export const SphincsPlusOptions = ({ onSelect, selected }: SphincsPlusOptionsProps) => {
    const device = useSelector(selectSelectedDevice);
    const deviceModel = device?.features?.internal_model;
    const firmwareVersion = getFirmwareVersion(device);

    const isDeviceSupported = deviceModel === DeviceModelInternal.T3W1;
    const isFirmwareSupported = isDeviceSupported && firmwareVersion !== '';

    return (
        <>
            <OptionWithContent
                onSelect={onSelect}
                selected={selected}
                value="sphincs-plus-128"
                disabled={!isFirmwareSupported}
                tags={isFirmwareSupported ? <RecommendedTag /> : undefined}
            >
                <Translation id="TR_ONBOARDING_SPHINCS_PLUS_128_DESCRIPTION" />
            </OptionWithContent>

            <OptionWithContent
                onSelect={onSelect}
                selected={selected}
                value="sphincs-plus-192"
                disabled={!isFirmwareSupported}
                tags={undefined}
            >
                <Translation id="TR_ONBOARDING_SPHINCS_PLUS_192_DESCRIPTION" />
            </OptionWithContent>

            <OptionWithContent
                onSelect={onSelect}
                selected={selected}
                value="sphincs-plus-256"
                disabled={!isFirmwareSupported}
                tags={undefined}
            >
                <Translation id="TR_ONBOARDING_SPHINCS_PLUS_256_DESCRIPTION" />
            </OptionWithContent>
        </>
    );
};
