export const selectBackupTypes = [
    'shamir-single',
    'shamir-advanced',
    '12-words',
    '24-words',
    'sphincs-plus-128',
    'sphincs-plus-192',
    'sphincs-plus-256',
] as const;

export type BackupType = (typeof selectBackupTypes)[number];
