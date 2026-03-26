import { bech32m } from 'bech32';

import { createThunk } from '@suite-common/redux-utils';
import {
    type Account,
    AddressDisplayOptions,
    type ExternalOutput,
    type PrecomposedLevels,
    type PrecomposedTransaction,
} from '@suite-common/wallet-types';
import {
    calculateMax,
    formatNetworkAmount,
    getExternalComposeOutput,
    isTestnet,
} from '@suite-common/wallet-utils';
import TrezorConnect, { type FeeLevel } from '@trezor/connect';
import { BigNumber } from '@trezor/utils';

import { SEND_MODULE_PREFIX } from './sendFormConstants';
import {
    type ComposeFeeLevelsError,
    type ComposeTransactionThunkArguments,
    type SignTransactionError,
    type SignTransactionThunkArguments,
} from './sendFormTypes';

// CKB minimum cell capacity: 61 CKB = 6100000000 shannons
// (8 bytes capacity + 32 bytes code_hash + 1 byte hash_type + 20 bytes args = 61 bytes)
const MIN_CELL_CAPACITY = '6100000000';

// Estimated transaction size in bytes for fee calculation
// A typical CKB transfer (1-2 inputs, 2 outputs) is around 700 bytes
const ESTIMATED_TX_SIZE = 700;

// secp256k1_blake160 system cell deps
const MAINNET_SECP256K1_CELL_DEP = {
    outPoint: {
        txHash: '0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c',
        index: 0,
    },
    depType: 'dep_group' as const,
};

const TESTNET_SECP256K1_CELL_DEP = {
    outPoint: {
        txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
        index: 0,
    },
    depType: 'dep_group' as const,
};

// secp256k1_blake160 lock script code_hash (for reference)
// const SECP256K1_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8';

/**
 * Decode a CKB Full Address (CKB2021, bech32m) to extract the lock script components.
 * Format: bech32m(hrp, [0x00 | code_hash(32) | hash_type(1) | args(variable)])
 */
const decodeCkbAddress = (
    address: string,
    expectedPrefix?: 'ckb' | 'ckt',
): { codeHash: string; hashType: string; args: string } => {
    const { prefix, words } = bech32m.decode(address, 1024);
    const data = bech32m.fromWords(words);

    if (expectedPrefix && prefix !== expectedPrefix) {
        throw new Error('Address network does not match the selected account network');
    }

    // Validate full address format (CKB2021)
    if (data[0] !== 0x00) {
        throw new Error('Only CKB full-format (0x00) addresses are supported');
    }
    const codeHash =
        '0x' +
        Array.from(data.slice(1, 33))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    const hashTypeByte = data[33];
    let hashType: string;
    switch (hashTypeByte) {
        case 0x00:
            hashType = 'data';
            break;
        case 0x01:
            hashType = 'type';
            break;
        case 0x02:
            hashType = 'data1';
            break;
        default:
            throw new Error('Unsupported CKB hash type');
    }
    const args =
        '0x' +
        Array.from(data.slice(34))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

    return { codeHash, hashType, args };
};

type CkbUtxos = NonNullable<Account['utxo']>;

type CkbTransactionPlan = {
    adjustedFee: string;
    changeAmount: BigNumber;
    hasChange: boolean;
    selectedUtxos: CkbUtxos;
    totalInput: BigNumber;
    totalSpent: string;
};

const selectUtxosToCover = (utxos: CkbUtxos, totalNeeded: BigNumber) => {
    const sortedUtxos = [...utxos].sort(
        (first, second) =>
            new BigNumber(second.amount).comparedTo(new BigNumber(first.amount)) ?? 0,
    );

    const selectedUtxos: CkbUtxos = [];
    let totalInput = new BigNumber(0);

    for (const utxo of sortedUtxos) {
        selectedUtxos.push(utxo);
        totalInput = totalInput.plus(utxo.amount);
        if (totalInput.gte(totalNeeded)) {
            break;
        }
    }

    if (totalInput.isLessThan(totalNeeded)) {
        return null;
    }

    return { selectedUtxos, totalInput };
};

const buildTransactionPlan = ({
    amount,
    fee,
    utxos,
}: {
    amount: string;
    fee: string;
    utxos: Account['utxo'];
}): CkbTransactionPlan | null => {
    if (!utxos || utxos.length === 0) {
        return null;
    }

    const amountBn = new BigNumber(amount);
    let adjustedFee = new BigNumber(fee);
    const selection = selectUtxosToCover(utxos, amountBn.plus(adjustedFee));

    if (!selection) {
        return null;
    }

    let changeAmount = selection.totalInput.minus(amountBn).minus(adjustedFee);
    if (changeAmount.isGreaterThan(0) && changeAmount.isLessThan(MIN_CELL_CAPACITY)) {
        adjustedFee = adjustedFee.plus(changeAmount);
        changeAmount = new BigNumber(0);
    }

    return {
        adjustedFee: adjustedFee.toString(),
        changeAmount,
        hasChange: changeAmount.gte(MIN_CELL_CAPACITY),
        selectedUtxos: selection.selectedUtxos,
        totalInput: selection.totalInput,
        totalSpent: amountBn.plus(adjustedFee).toString(),
    };
};

/**
 * Calculate CKB transaction fee from fee rate.
 * feeRatePerKB is in shannons/KB from the CKB node.
 */
const calculateCkbFee = (feeRatePerKB: string, txSizeBytes: number): string => {
    const rate = new BigNumber(feeRatePerKB);
    const fee = rate.times(txSizeBytes).dividedBy(1000).integerValue(BigNumber.ROUND_CEIL);

    // Minimum fee of 1000 shannons (0.00001 CKB)
    return BigNumber.max(fee, 1000).toString();
};

/**
 * Convert signature from Trezor format to CKB format.
 *
 * Trezor's secp256k1.sign(compressed=True) returns 65 bytes: [v(1) || r(32) || s(32)]
 * where v = 27 + recovery_id + 4 = 31 + recovery_id (compressed keys add 4).
 *
 * CKB's secp256k1_blake160 lock script expects 65 bytes: [r(32) || s(32) || recovery_id(1)]
 * where recovery_id is 0 or 1, parsed via secp256k1_ecdsa_recoverable_signature_parse_compact.
 */
const convertTrezorSigToCkb = (sigHex: string): string => {
    const sig = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
    // sig is 130 hex chars = 65 bytes: v(2 hex) + r(64 hex) + s(64 hex)
    const v = parseInt(sig.slice(0, 2), 16);
    // v = 31 + recid for compressed, v = 27 + recid for uncompressed
    const recid = v >= 31 ? v - 31 : v - 27;
    const rs = sig.slice(2); // r(32 bytes) || s(32 bytes) = 128 hex chars

    return rs + recid.toString(16).padStart(2, '0');
};

/**
 * Build a serialized WitnessArgs in Molecule format with the given lock (signature).
 * WitnessArgs { lock: BytesOpt, input_type: BytesOpt, output_type: BytesOpt }
 *
 * For secp256k1_blake160, the lock is a 65-byte recoverable ECDSA signature.
 * The signature must already be in CKB format: [r(32) || s(32) || recid(1)].
 */
const buildWitnessArgs = (signatureHex: string): string => {
    // Remove 0x prefix if present
    const sig = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
    const sigBytes = sig.length / 2; // Should be 65

    // Molecule Table layout for WitnessArgs (3 fields):
    // header: full_size(4) + offset_0(4) + offset_1(4) + offset_2(4) = 16 bytes
    // lock: Bytes = length(4) + data(sigBytes)
    // input_type: None (0 bytes)
    // output_type: None (0 bytes)
    const headerSize = 16;
    const lockSize = 4 + sigBytes; // Bytes type: 4-byte length + data
    const fullSize = headerSize + lockSize;

    const offset0 = headerSize;
    const offset1 = headerSize + lockSize;
    const offset2 = offset1; // Both empty

    const toLE32 = (n: number): string => {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, n, true);

        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    };

    return (
        '0x' +
        toLE32(fullSize) +
        toLE32(offset0) +
        toLE32(offset1) +
        toLE32(offset2) +
        toLE32(sigBytes) +
        sig
    );
};

/**
 * Calculate compose result for a CKB transaction at a given fee level.
 */
const calculate = (
    account: Account,
    output: ExternalOutput,
    feeLevel: FeeLevel,
): PrecomposedTransaction => {
    // Calculate fee based on estimated transaction size
    const feeInShannons = calculateCkbFee(feeLevel.feePerUnit, ESTIMATED_TX_SIZE);

    let amount: string;
    let max: string | undefined;

    if (output.type === 'send-max' || output.type === 'send-max-noaddress') {
        const maxAmount = calculateMax(account.availableBalance, feeInShannons);
        max = maxAmount;
        amount = maxAmount;
    } else {
        amount = output.amount;
    }

    // Check if amount is enough
    if (new BigNumber(amount).isLessThanOrEqualTo(0)) {
        return {
            type: 'error',
            error: 'AMOUNT_IS_NOT_ENOUGH',
            errorMessage: { id: 'AMOUNT_IS_NOT_ENOUGH' },
        } as const;
    }

    // Check minimum amount (CKB requires minimum 61 CKB per output cell)
    if (new BigNumber(amount).isLessThan(MIN_CELL_CAPACITY)) {
        return {
            type: 'error',
            error: 'AMOUNT_IS_TOO_LOW',
            errorMessage: { id: 'AMOUNT_IS_TOO_LOW' },
        } as const;
    }

    const plan = buildTransactionPlan({
        amount,
        fee: feeInShannons,
        utxos: account.utxo,
    });

    if (!plan) {
        return {
            type: 'error',
            error: 'AMOUNT_IS_NOT_ENOUGH',
            errorMessage: { id: 'AMOUNT_IS_NOT_ENOUGH' },
        } as const;
    }

    const payloadData = {
        type: 'nonfinal' as const,
        totalSpent: plan.totalSpent,
        max,
        fee: plan.adjustedFee,
        feePerByte: feeLevel.feePerUnit,
        bytes: ESTIMATED_TX_SIZE,
        inputs: [],
    };

    if (output.type === 'send-max' || output.type === 'payment') {
        return {
            ...payloadData,
            type: 'final',
            inputs: [],
            outputsPermutation: [0],
            outputs: [
                {
                    address: output.address,
                    amount,
                    script_type: 'PAYTOADDRESS',
                },
            ],
        };
    }

    return payloadData;
};

export const composeCkbTransactionFeeLevelsThunk = createThunk<
    PrecomposedLevels,
    ComposeTransactionThunkArguments,
    { rejectValue: ComposeFeeLevelsError }
>(
    `${SEND_MODULE_PREFIX}/composeCkbTransactionFeeLevelsThunk`,
    ({ formState, composeContext }, { rejectWithValue }) => {
        const { account, network, feeInfo } = composeContext;
        const composeOutputs = getExternalComposeOutput(formState, account, network);
        if (!composeOutputs) {
            return rejectWithValue({
                error: 'fee-levels-compose-failed',
                message: 'Unable to compose output.',
            });
        }

        const { output } = composeOutputs;
        const predefinedLevels = feeInfo.levels.filter(l => l.label !== 'custom');
        // In case when selectedFee is set to 'custom', construct this FeeLevel from values
        if (formState.selectedFee === 'custom') {
            predefinedLevels.push({
                label: 'custom',
                feePerUnit: formState.feePerUnit,
                blocks: -1,
            });
        }

        // Wrap response into PrecomposedLevels object where key is a FeeLevel label
        const resultLevels: PrecomposedLevels = {};
        const response = predefinedLevels.map(level => calculate(account, output, level));
        response.forEach((tx, index) => {
            const feeLabel = predefinedLevels[index].label as FeeLevel['label'];
            resultLevels[feeLabel] = tx;
        });

        const hasAtLeastOneValid = response.find(r => r.type !== 'error');
        // There is no valid tx in predefinedLevels and there is no custom level
        if (!hasAtLeastOneValid && !resultLevels.custom) {
            const { minFee } = feeInfo;
            const lastKnownFee = predefinedLevels[predefinedLevels.length - 1].feePerUnit;
            let maxFee = new BigNumber(lastKnownFee).minus(1);
            const customLevels: FeeLevel[] = [];
            while (maxFee.gte(minFee)) {
                customLevels.push({ feePerUnit: maxFee.toString(), label: 'custom', blocks: -1 });
                maxFee = maxFee.minus(1);
            }

            const customLevelsResponse = customLevels.map(level =>
                calculate(account, output, level),
            );

            const customValid = customLevelsResponse.findIndex(r => r.type !== 'error');
            if (customValid >= 0) {
                resultLevels.custom = customLevelsResponse[customValid];
            }
        }

        // Format max (calculate sends it as shannons)
        Object.keys(resultLevels).forEach(key => {
            const tx = resultLevels[key];
            if (tx.type !== 'error' && tx.max) {
                tx.max = formatNetworkAmount(tx.max, account.symbol);
            }
        });

        return resultLevels;
    },
);

export const signCkbSendFormTransactionThunk = createThunk<
    { serializedTx: string },
    SignTransactionThunkArguments,
    { rejectValue: SignTransactionError }
>(
    `${SEND_MODULE_PREFIX}/signCkbSendFormTransactionThunk`,
    async (
        { formState, precomposedTransaction, selectedAccount, device },
        { getState, extra, rejectWithValue },
    ) => {
        const {
            selectors: { selectAddressDisplayType },
        } = extra;

        const addressDisplayType = selectAddressDisplayType(getState());
        const testnet = isTestnet(selectedAccount.symbol);

        // 1. Get recipient address and amount
        const recipientAddress = formState.outputs[0].address;
        const amountRaw = precomposedTransaction.outputs[0].amount;
        const amount = String(amountRaw);
        const { fee } = precomposedTransaction;

        if (!recipientAddress || !amount) {
            return rejectWithValue({
                error: 'sign-transaction-failed',
                message: 'Missing recipient address or amount.',
            });
        }

        // 2. Get UTXOs (live cells) from the account
        const utxos = selectedAccount.utxo;
        if (!utxos || utxos.length === 0) {
            return rejectWithValue({
                error: 'sign-transaction-failed',
                message: 'No UTXOs available for this account.',
            });
        }

        const plan = buildTransactionPlan({
            amount,
            fee,
            utxos,
        });

        if (!plan) {
            return rejectWithValue({
                error: 'sign-transaction-failed',
                message: 'Insufficient UTXOs to cover amount and fee.',
            });
        }

        // 5. Decode recipient lock script
        const expectedPrefix = testnet ? 'ckt' : 'ckb';
        const recipientLock = decodeCkbAddress(recipientAddress, expectedPrefix);

        // 6. Decode sender lock script (from account descriptor)
        const senderLock = decodeCkbAddress(selectedAccount.descriptor, expectedPrefix);

        // 7. Build CKB transaction for Trezor signing
        const cellDep = testnet ? TESTNET_SECP256K1_CELL_DEP : MAINNET_SECP256K1_CELL_DEP;

        const inputs = plan.selectedUtxos.map(utxo => ({
            since: '0',
            previousOutput: {
                txHash: utxo.txid.startsWith('0x') ? utxo.txid : `0x${utxo.txid}`,
                index: utxo.vout,
            },
        }));

        const outputs: Array<{
            capacity: string;
            lock: {
                codeHash: string;
                hashType: 'type' | 'data' | 'data1' | 'data2';
                args: string;
            };
        }> = [
            {
                capacity: amount,
                lock: {
                    codeHash: recipientLock.codeHash,
                    hashType: recipientLock.hashType as 'type' | 'data' | 'data1' | 'data2',
                    args: recipientLock.args,
                },
            },
        ];

        // Add change output if needed
        if (plan.hasChange) {
            outputs.push({
                capacity: plan.changeAmount.toString(),
                lock: {
                    codeHash: senderLock.codeHash,
                    hashType: senderLock.hashType as 'type' | 'data' | 'data1' | 'data2',
                    args: senderLock.args,
                },
            });
        }

        const outputsData = outputs.map(() => '0x');

        const transaction = {
            version: 0 as const,
            cellDeps: [cellDep],
            headerDeps: [] as string[],
            inputs,
            outputs,
            outputsData,
        };

        // 8. Sign with Trezor
        const response = await TrezorConnect.ckbSignTransaction({
            device: {
                path: device.path,
                instance: device.instance,
                state: device.state,
                useEmptyPassphrase: device.useEmptyPassphrase,
            },
            path: selectedAccount.path,
            transaction,
            network: testnet ? 'Testnet' : 'Mainnet',
            fee: Number(plan.adjustedFee),
            chunkify: addressDisplayType === AddressDisplayOptions.CHUNKED,
        });

        if (!response.success) {
            return rejectWithValue({
                error: 'sign-transaction-failed',
                errorCode: response.error.code,
                message: response.error.message,
            });
        }

        // 9. Build witnesses
        const { signature } = response.payload;
        const witnesses: string[] = [];

        // Convert signature from Trezor format [v||r||s] to CKB format [r||s||recid]
        const ckbSignature = convertTrezorSigToCkb(signature);

        // First input gets the WitnessArgs with signature
        witnesses.push(buildWitnessArgs(ckbSignature));

        // Additional inputs from the same lock group get empty witnesses
        for (let i = 1; i < plan.selectedUtxos.length; i++) {
            witnesses.push('0x');
        }

        // 10. Build the full signed transaction for broadcasting
        // Use the format expected by the ccc library's sendTransactionNoCache (TransactionLike)
        // NumLike fields accept string | number | bigint; using strings for JSON serialization safety
        const fullTransaction = {
            version: 0,
            cellDeps: [
                {
                    outPoint: {
                        txHash: cellDep.outPoint.txHash,
                        index: cellDep.outPoint.index,
                    },
                    depType: 'depGroup',
                },
            ],
            headerDeps: [] as string[],
            inputs: inputs.map(input => ({
                since: 0,
                previousOutput: {
                    txHash: input.previousOutput.txHash,
                    index: input.previousOutput.index,
                },
            })),
            outputs: outputs.map(output => ({
                capacity: output.capacity,
                lock: {
                    codeHash: output.lock.codeHash,
                    hashType: output.lock.hashType,
                    args: output.lock.args,
                },
            })),
            outputsData,
            witnesses,
        };

        const serializedTx = JSON.stringify(fullTransaction);

        return { serializedTx };
    },
);
