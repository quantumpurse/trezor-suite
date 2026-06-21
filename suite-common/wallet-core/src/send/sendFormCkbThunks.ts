import { ccc } from '@ckb-ccc/core';

import { createThunk } from '@suite-common/redux-utils';
import {
    type Account,
    AddressDisplayOptions,
    type ExternalOutput,
    type PrecomposedLevels,
    type PrecomposedTransaction,
} from '@suite-common/wallet-types';
import {
    DEFAULT_SPHINCS_PLUS_VARIANT,
    formatNetworkAmount,
    getExternalComposeOutput,
    getSphincsVariantInfo,
    isSphincsPlusAccountType,
    isTestnet,
    sphincsVariantFromAccountType,
} from '@suite-common/wallet-utils';
import TrezorConnect, { type FeeLevel } from '@trezor/connect';

import { SEND_MODULE_PREFIX } from './sendFormConstants';
import {
    type ComposeFeeLevelsError,
    type ComposeTransactionThunkArguments,
    type SignTransactionError,
    type SignTransactionThunkArguments,
} from './sendFormTypes';
import { selectNetworkBlockchainInfo } from '../blockchain/blockchainReducer';
import { selectAddressDisplayType } from '../settings/walletSettingsReducer';

type CkbClient = ccc.ClientPublicMainnet | ccc.ClientPublicTestnet;
type TrezorCkbDevice = SignTransactionThunkArguments['device'];

// secp256k1 recoverable signature length (the WitnessArgs lock field size).
const CKB_SIGNATURE_PLACEHOLDER_SIZE = 65;

class TrezorCkbSignError extends Error {
    constructor(
        message: string,
        readonly errorCode?: SignTransactionError['errorCode'],
    ) {
        super(message);
    }
}

export const normalizeTrezorCkbSignature = (sigHex: string): string => {
    const sig = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;

    if (sig.length !== 130) {
        throw new Error('Unexpected CKB signature length returned by Trezor.');
    }

    return sig;
};

const createCkbClient = (symbol: Account['symbol'], url?: string): CkbClient => {
    const config = url ? { url } : undefined;

    return isTestnet(symbol)
        ? new ccc.ClientPublicTestnet(config)
        : new ccc.ClientPublicMainnet(config);
};

export const ensureCkbInputWitnesses = (tx: ccc.Transaction) => {
    while (tx.witnesses.length < tx.inputs.length) {
        tx.witnesses.push('0x');
    }
};

const mapCellDepToTrezor = (
    cellDep: ccc.CellDep,
): { outPoint: { txHash: string; index: number }; depType: 'code' | 'dep_group' } => ({
    outPoint: {
        txHash: cellDep.outPoint.txHash,
        index: Number(cellDep.outPoint.index),
    },
    depType: cellDep.depType === 'depGroup' ? 'dep_group' : 'code',
});

const mapCccTransactionToTrezor = (
    tx: ccc.Transaction,
): {
    version: 0;
    cellDeps: Array<{
        outPoint: { txHash: string; index: number };
        depType: 'code' | 'dep_group';
    }>;
    headerDeps: string[];
    inputs: Array<{ since: string; previousOutput: { txHash: string; index: number } }>;
    outputs: Array<{
        capacity: string;
        lock: {
            codeHash: string;
            hashType: 'type' | 'data' | 'data1' | 'data2';
            args: string;
        };
        type?: {
            codeHash: string;
            hashType: 'type' | 'data' | 'data1' | 'data2';
            args: string;
        };
    }>;
    outputsData: string[];
} => ({
    version: 0,
    cellDeps: tx.cellDeps.map(mapCellDepToTrezor),
    headerDeps: tx.headerDeps.map(String),
    inputs: tx.inputs.map(input => ({
        since: input.since.toString(),
        previousOutput: {
            txHash: input.previousOutput.txHash,
            index: Number(input.previousOutput.index),
        },
    })),
    outputs: tx.outputs.map(output => ({
        capacity: output.capacity.toString(),
        lock: {
            codeHash: output.lock.codeHash,
            hashType: output.lock.hashType,
            args: output.lock.args,
        },
        ...(output.type
            ? {
                  type: {
                      codeHash: output.type.codeHash,
                      hashType: output.type.hashType,
                      args: output.type.args,
                  },
              }
            : {}),
    })),
    outputsData: tx.outputsData.map(String),
});

// SPHINCS+ lock-script cell_dep per network. These reference the on-chain
// cells holding the SPHINCS+ lock script code.
const CKB_SPHINCS_PLUS_CELL_DEPS: Record<
    'Mainnet' | 'Testnet',
    { txHash: string; index: number; depType: 'code' | 'dep_group' }
> = {
    Mainnet: {
        txHash: '0x4598d00df2f3dc8bc40eee38689a539c94f6cc3720b7a2a6746736daa60f500a',
        index: 0,
        depType: 'code',
    },
    Testnet: {
        txHash: '0x631d9a6049fb1fc3790e89d9daf35abe535b5e754cd8c3404319319710f0b106',
        index: 0,
        depType: 'code',
    },
};

const isSphincsPlus = (account: Account) => isSphincsPlusAccountType(account.accountType);

// Variant is derived from the account type (e.g. `sphincsPlus192Sha2S` → 51);
// the default guards a malformed legacy record from breaking signing.
const getAccountSphincsVariant = (account: Account): number =>
    sphincsVariantFromAccountType(account.accountType) ?? DEFAULT_SPHINCS_PLUS_VARIANT;

// Witness-lock size = header(5) + pubkey(2*spx_n) + signature, pulled from the
// shared variant table so it never drifts from the firmware side.
const getSphincsPlusWitnessSize = (variant: number): number => {
    const info =
        getSphincsVariantInfo(variant) ?? getSphincsVariantInfo(DEFAULT_SPHINCS_PLUS_VARIANT);

    return info!.witnessLockBytes;
};

class TrezorCkbSigner extends ccc.Signer {
    private readonly addressPromise: Promise<ccc.Address>;

    constructor(
        client: CkbClient,
        private readonly account: Account,
        private readonly device?: TrezorCkbDevice,
        private readonly chunkify = false,
    ) {
        super(client);

        this.addressPromise = ccc.Address.fromString(account.descriptor, client);
    }

    get type() {
        return ccc.SignerType.CKB;
    }

    get signType() {
        return ccc.SignerSignType.CkbSecp256k1;
    }

    async connect() {}

    isConnected() {
        return Promise.resolve(true);
    }

    getInternalAddress() {
        return Promise.resolve(this.account.descriptor);
    }

    async getAddressObjs() {
        return [await this.addressPromise];
    }

    async prepareTransaction(txLike: ccc.TransactionLike) {
        const tx = ccc.Transaction.from(txLike);
        const { script } = await this.getRecommendedAddressObj();

        ensureCkbInputWitnesses(tx);

        if (isSphincsPlus(this.account)) {
            const sigSize = getSphincsPlusWitnessSize(getAccountSphincsVariant(this.account));
            await tx.prepareSighashAllWitness(script, sigSize, this.client);

            // Add the SPHINCS+ lock cell_dep manually (not a ccc KnownScript).
            // completeFeeBy may call this repeatedly, so guard against duplicates.
            const networkKey = isTestnet(this.account.symbol) ? 'Testnet' : 'Mainnet';
            const dep = CKB_SPHINCS_PLUS_CELL_DEPS[networkKey];
            const cccDepType = dep.depType === 'dep_group' ? 'depGroup' : 'code';
            const alreadyAdded = tx.cellDeps.some(
                d =>
                    d.outPoint.txHash === dep.txHash &&
                    BigInt(d.outPoint.index) === BigInt(dep.index) &&
                    d.depType === cccDepType,
            );
            if (!alreadyAdded) {
                tx.cellDeps.push(
                    ccc.CellDep.from({
                        outPoint: { txHash: dep.txHash, index: dep.index },
                        depType: cccDepType,
                    }),
                );
            }
        } else {
            await tx.prepareSighashAllWitness(script, 65, this.client);
            await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.Secp256k1Blake160);
        }

        return tx;
    }

    async signOnlyTransaction(txLike: ccc.TransactionLike) {
        if (!this.device) {
            throw new Error('Trezor device is required to sign a CKB transaction.');
        }

        const tx = ccc.Transaction.from(txLike);
        const { script } = await this.getRecommendedAddressObj();

        const signHashInfo = await tx.getSignHashInfo(script, this.client);

        if (!signHashInfo) {
            return tx;
        }

        const sphincsPlus = isSphincsPlus(this.account);
        const variant = sphincsPlus ? getAccountSphincsVariant(this.account) : undefined;
        const lockSize = sphincsPlus
            ? getSphincsPlusWitnessSize(variant!)
            : CKB_SIGNATURE_PLACEHOLDER_SIZE;

        // Forward the witness vector ccc already built so the device hashes the
        // exact sighash_all preimage of the broadcast transaction.
        const signingWitnessArgs = tx.getWitnessArgsAt(signHashInfo.position);
        const witnesses = tx.witnesses.map((raw, index) =>
            index === signHashInfo.position
                ? {
                      witnessArgs: {
                          lockSize,
                          inputType: signingWitnessArgs?.inputType,
                          outputType: signingWitnessArgs?.outputType,
                      },
                  }
                : { raw },
        );
        // Suite composes single-group transactions: every input is in the group.
        const signGroupInputIndices = tx.inputs.map((_, index) => index);

        const device = {
            path: this.device.path,
            instance: this.device.instance,
            state: this.device.state,
            useEmptyPassphrase: this.device.useEmptyPassphrase,
        };
        const network = isTestnet(this.account.symbol) ? 'Testnet' : 'Mainnet';
        const witness = tx.getWitnessArgsAt(signHashInfo.position) ?? ccc.WitnessArgs.from({});

        if (sphincsPlus) {
            const response = await TrezorConnect.ckbSphincsPlusSignTransaction({
                device,
                accountIndex: this.account.index,
                variant,
                transaction: mapCccTransactionToTrezor(tx),
                witnesses,
                signGroupInputIndices,
                network,
                chunkify: this.chunkify,
            });

            if (!response.success) {
                throw new TrezorCkbSignError(response.error.message, response.error.code);
            }

            // Host self-check that the device hashed the same raw tx body
            // (inputs/outputs/cell_deps) we authorized. ccc tx.hash() excludes
            // witnesses; witness integrity is enforced by CKB consensus on-chain.
            const hostTxHash = tx.hash().toLowerCase();
            const deviceTxHash = (
                response.payload.tx_hash.startsWith('0x')
                    ? response.payload.tx_hash
                    : `0x${response.payload.tx_hash}`
            ).toLowerCase();
            if (hostTxHash !== deviceTxHash) {
                throw new TrezorCkbSignError(
                    'CKB SPHINCS+: device-reported tx hash does not match host-computed hash',
                );
            }

            const sigHex = response.payload.signature.startsWith('0x')
                ? response.payload.signature.slice(2)
                : response.payload.signature;

            // Parity with the ECDSA path (normalizeTrezorCkbSignature): the lock
            // must be exactly the size reserved in the sighash, otherwise the
            // broadcast witness differs from what was signed and the tx is
            // rejected on-chain. Fail fast with a clear error instead.
            const sigBytes = sigHex.length / 2;
            if (sigBytes !== lockSize) {
                throw new TrezorCkbSignError(
                    `CKB SPHINCS+: device returned lock of ${sigBytes} bytes, expected ${lockSize}`,
                );
            }

            witness.lock = `0x${sigHex}`;
            tx.setWitnessArgsAt(signHashInfo.position, witness);

            return tx;
        }

        const response = await TrezorConnect.ckbSignTransaction({
            device,
            path: this.account.path,
            transaction: mapCccTransactionToTrezor(tx),
            witnesses,
            signGroupInputIndices,
            network,
            chunkify: this.chunkify,
        });

        if (!response.success) {
            throw new TrezorCkbSignError(response.error.message, response.error.code);
        }

        witness.lock = `0x${normalizeTrezorCkbSignature(response.payload.signature)}`;
        tx.setWitnessArgsAt(signHashInfo.position, witness);

        return tx;
    }
}

const buildCkbTransaction = async ({
    recipientAddress,
    signer,
    amount,
    feeRate,
    shouldSendMax,
}: {
    recipientAddress: string;
    signer: TrezorCkbSigner;
    amount?: string;
    feeRate?: string;
    shouldSendMax: boolean;
}) => {
    const recipient = await ccc.Address.fromString(recipientAddress, signer.client);
    const tx = ccc.Transaction.from({
        outputs: [
            shouldSendMax
                ? { lock: recipient.script }
                : { lock: recipient.script, capacity: amount! },
        ],
    });

    if (shouldSendMax) {
        await tx.completeInputsAll(signer);
        await tx.completeFeeChangeToOutput(signer, 0, feeRate);

        return tx;
    }

    await tx.completeFeeBy(signer, feeRate);

    return tx;
};

const createCkbAmountError = (
    error: 'AMOUNT_IS_NOT_ENOUGH' | 'AMOUNT_IS_TOO_LOW',
): PrecomposedTransaction => ({
    type: 'error',
    error,
    errorMessage: { id: error },
});

const isCkbSendMaxOutput = (output: ExternalOutput) =>
    output.type === 'send-max' || output.type === 'send-max-noaddress';

const isCkbKnownAddressOutput = (
    output: ExternalOutput,
): output is Extract<ExternalOutput, { type: 'payment' | 'send-max' }> =>
    output.type === 'payment' || output.type === 'send-max';

const getCkbRecipientAddress = (account: Account, output: ExternalOutput) =>
    ('address' in output ? output.address : undefined) ?? account.descriptor;

const getCkbMinimumOutputCapacity = (lock: ccc.Script) =>
    ccc.CellOutput.from({ lock }, '0x').capacity;

const composeCkbTransaction = async ({
    output,
    feeLevel,
    recipientAddress,
    signer,
}: {
    output: ExternalOutput;
    feeLevel: FeeLevel;
    recipientAddress: string;
    signer: TrezorCkbSigner;
}): Promise<PrecomposedTransaction> => {
    const recipient = await ccc.Address.fromString(recipientAddress, signer.client);
    const minimumCapacity = getCkbMinimumOutputCapacity(recipient.script);
    const shouldSendMax = isCkbSendMaxOutput(output);
    const amount = shouldSendMax ? undefined : output.amount;

    if (amount !== undefined && BigInt(amount) <= 0n) {
        return createCkbAmountError('AMOUNT_IS_NOT_ENOUGH');
    }

    if (amount !== undefined && BigInt(amount) < minimumCapacity) {
        return createCkbAmountError('AMOUNT_IS_TOO_LOW');
    }

    try {
        const tx = await buildCkbTransaction({
            recipientAddress,
            signer,
            amount,
            feeRate: feeLevel.feePerUnit,
            shouldSendMax,
        });
        const recipientOutput = tx.getOutput(0);

        if (!recipientOutput) {
            throw new Error('Failed to build the recipient CKB output.');
        }

        const composedAmount = recipientOutput.cellOutput.capacity;
        if (composedAmount < minimumCapacity) {
            return createCkbAmountError('AMOUNT_IS_TOO_LOW');
        }

        const fee = await tx.getFee(signer.client);
        const payloadData = {
            type: 'nonfinal' as const,
            totalSpent: (composedAmount + fee).toString(),
            max: shouldSendMax ? composedAmount.toString() : undefined,
            fee: fee.toString(),
            feePerByte: feeLevel.feePerUnit,
            bytes: tx.toBytes().length + 4,
            inputs: [],
        };

        if (isCkbKnownAddressOutput(output)) {
            return {
                ...payloadData,
                type: 'final',
                inputs: [],
                outputsPermutation: [0],
                outputs: [
                    {
                        address: output.address,
                        amount: composedAmount.toString(),
                        script_type: 'PAYTOADDRESS',
                    },
                ],
            };
        }

        return payloadData;
    } catch (error) {
        if (
            error instanceof ccc.ErrorTransactionInsufficientCapacity ||
            error instanceof ccc.ErrorTransactionInsufficientCoin
        ) {
            return createCkbAmountError('AMOUNT_IS_NOT_ENOUGH');
        }

        throw error;
    }
};

const composeCkbTransactions = async ({
    feeLevels,
    output,
    recipientAddress,
    signer,
}: {
    feeLevels: FeeLevel[];
    output: ExternalOutput;
    recipientAddress: string;
    signer: TrezorCkbSigner;
}) => {
    const transactions: PrecomposedTransaction[] = [];

    for (const feeLevel of feeLevels) {
        transactions.push(
            await composeCkbTransaction({
                output,
                feeLevel,
                recipientAddress,
                signer,
            }),
        );
    }

    return transactions;
};

export const composeCkbTransactionFeeLevelsThunk = createThunk<
    PrecomposedLevels,
    ComposeTransactionThunkArguments,
    { rejectValue: ComposeFeeLevelsError }
>(
    `${SEND_MODULE_PREFIX}/composeCkbTransactionFeeLevelsThunk`,
    async ({ formState, composeContext }, { getState, rejectWithValue }) => {
        const { account, network, feeInfo } = composeContext;
        const composeOutputs = getExternalComposeOutput(formState, account, network);
        if (!composeOutputs) {
            return rejectWithValue({
                error: 'fee-levels-compose-failed',
                message: 'Unable to compose output.',
            });
        }

        const { output } = composeOutputs;
        const blockchain = selectNetworkBlockchainInfo(getState(), account.symbol);
        const predefinedLevels = feeInfo.levels.filter(l => l.label !== 'custom');
        if (formState.selectedFee === 'custom') {
            predefinedLevels.push({
                label: 'custom',
                feePerUnit: formState.feePerUnit,
                blocks: -1,
            });
        }

        if (predefinedLevels.length === 0) {
            return rejectWithValue({
                error: 'fee-levels-compose-failed',
                message: 'No CKB fee levels are available.',
            });
        }

        const signer = new TrezorCkbSigner(
            createCkbClient(account.symbol, blockchain.url),
            account,
        );
        // Use the account descriptor while the destination is still incomplete.
        const recipientAddress = getCkbRecipientAddress(account, output);

        try {
            const resultLevels: PrecomposedLevels = {};
            const response = await composeCkbTransactions({
                feeLevels: predefinedLevels,
                output,
                recipientAddress,
                signer,
            });
            response.forEach((tx, index) => {
                const feeLabel = predefinedLevels[index].label as FeeLevel['label'];
                resultLevels[feeLabel] = tx;
            });

            const hasAtLeastOneValid = response.some(r => r.type !== 'error');
            if (!hasAtLeastOneValid && !resultLevels.custom) {
                return rejectWithValue({
                    error: 'fee-levels-compose-failed',
                    message: 'Not enough CKB balance to cover the transaction.',
                });
            }

            Object.keys(resultLevels).forEach(key => {
                const tx = resultLevels[key];
                if (tx.type !== 'error' && tx.max) {
                    tx.max = formatNetworkAmount(tx.max, account.symbol);
                }
            });

            return resultLevels;
        } catch (error) {
            return rejectWithValue({
                error: 'fee-levels-compose-failed',
                message:
                    error instanceof Error ? error.message : 'Failed to compose CKB transaction.',
            });
        }
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
        { getState, rejectWithValue },
    ) => {
        const addressDisplayType = selectAddressDisplayType(getState());
        const blockchain = selectNetworkBlockchainInfo(getState(), selectedAccount.symbol);

        const [firstOutput] = formState.outputs;
        const [recipientOutput] = precomposedTransaction.outputs;
        const recipientAddress =
            'address' in recipientOutput ? recipientOutput.address : firstOutput.address;
        const shouldSendMax = formState.setMaxOutputId === 0;
        const amount = shouldSendMax ? undefined : String(recipientOutput.amount);
        const feeRate = precomposedTransaction.feePerByte;

        if (!recipientAddress || (!shouldSendMax && !amount)) {
            return rejectWithValue({
                error: 'sign-transaction-failed',
                message: 'Missing recipient address or amount.',
            });
        }

        try {
            const signer = new TrezorCkbSigner(
                createCkbClient(selectedAccount.symbol, blockchain.url),
                selectedAccount,
                device,
                addressDisplayType === AddressDisplayOptions.CHUNKED,
            );

            const tx = await buildCkbTransaction({
                recipientAddress,
                signer,
                amount,
                feeRate,
                shouldSendMax,
            });
            const signedTx = await signer.signTransaction(tx);

            return { serializedTx: ccc.stringify(signedTx) };
        } catch (error) {
            if (error instanceof TrezorCkbSignError) {
                return rejectWithValue({
                    error: 'sign-transaction-failed',
                    errorCode: error.errorCode,
                    message: error.message,
                });
            }

            return rejectWithValue({
                error: 'sign-transaction-failed',
                message:
                    error instanceof Error ? error.message : 'Failed to build CKB transaction.',
            });
        }
    },
);
