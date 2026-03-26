import {
    Address,
    type Client as CccClient,
    ClientPublicMainnet,
    ClientPublicTestnet,
} from '@ckb-ccc/core';

import type {
    AccountBalanceHistory,
    AccountInfo,
    Response,
    Transaction,
    Utxo,
} from '@trezor/blockchain-link-types';
import { MESSAGES, RESPONSES } from '@trezor/blockchain-link-types/src/constants';
import { CustomError } from '@trezor/blockchain-link-types/src/constants/errors';
import type * as MessageTypes from '@trezor/blockchain-link-types/src/messages';

import { BaseWorker, CONTEXT, type ContextType } from '../baseWorker';

type Context = ContextType<CccClient>;
type Request<T> = T & Context;

// CKB has 8 decimal places (1 CKB = 10^8 shannons)
const CKB_DECIMALS = 8;
const DEFAULT_PAGE_SIZE = 25;

type ClientTransactionResponse = NonNullable<Awaited<ReturnType<CccClient['getTransaction']>>>;
type TransactionFetcher = (hash: string) => Promise<ClientTransactionResponse | undefined>;
type BlockTimestampFetcher = (blockNum: number) => Promise<number | undefined>;
type AccountHistoryTransaction = Transaction & { blockTime: number };

const normalizeTxHash = (hash: string) => (hash.startsWith('0x') ? hash : `0x${hash}`);
const trimHexPrefix = (hash: string) => hash.replace(/^0x/, '');

const createTransactionFetcher = (client: CccClient): TransactionFetcher => {
    const txCache = new Map<string, Awaited<ReturnType<typeof client.getTransaction>>>();

    return async hash => {
        const normalizedHash = normalizeTxHash(hash);
        const cached = txCache.get(normalizedHash);
        if (cached !== undefined) {
            return cached ?? undefined;
        }

        const result = await client.getTransaction(normalizedHash);
        txCache.set(normalizedHash, result);

        return result ?? undefined;
    };
};

const createBlockTimestampFetcher = (client: CccClient): BlockTimestampFetcher => {
    const blockTimestampCache = new Map<number, number>();

    return async (blockNum: number) => {
        const cached = blockTimestampCache.get(blockNum);
        if (cached !== undefined) {
            return cached;
        }

        try {
            const header = await client.getHeaderByNumber(blockNum);
            if (header) {
                // CKB timestamp is in milliseconds, convert to seconds
                const timestamp = Number(header.timestamp) / 1000;
                blockTimestampCache.set(blockNum, timestamp);

                return timestamp;
            }
        } catch {
            // ignore header fetch failures
        }

        return undefined;
    };
};

const aggregateTransactions = (
    transactions: AccountHistoryTransaction[],
    groupBy = 3600,
): AccountBalanceHistory[] => {
    const result: AccountBalanceHistory[] = [];
    let index = 0;

    while (index < transactions.length) {
        const time = Math.floor(transactions[index].blockTime / groupBy) * groupBy;
        let txsInGroup = index;
        let received = BigInt(0);
        let sent = BigInt(0);
        let sentToSelf = BigInt(0);

        while (
            txsInGroup < transactions.length &&
            transactions[txsInGroup].blockTime < time + groupBy
        ) {
            const {
                type,
                amount,
                fee,
                details: { totalInput, totalOutput },
            } = transactions[txsInGroup];

            if (type === 'recv') {
                received += BigInt(amount);
            } else if (type === 'sent') {
                sent += BigInt(amount) + BigInt(fee);
            } else if (type === 'self') {
                sentToSelf += BigInt(totalOutput);
                sent += BigInt(totalInput);
                received += BigInt(totalOutput);
            }

            txsInGroup++;
        }

        result.push({
            time,
            txs: txsInGroup - index,
            received: received.toString(),
            sent: sent.toString(),
            sentToSelf: sentToSelf.toString(),
            rates: {},
        });

        index = txsInGroup;
    }

    return result;
};

const mapTransaction = async ({
    txResponse,
    fetchTx,
    getBlockTimestamp,
    ownLockScript,
}: {
    txResponse: ClientTransactionResponse;
    fetchTx: TransactionFetcher;
    getBlockTimestamp: BlockTimestampFetcher;
    ownLockScript?: Awaited<ReturnType<typeof Address.fromString>>['script'];
}): Promise<Transaction> => {
    const txObj = txResponse.transaction;

    let myInputSum = BigInt(0);
    let myOutputSum = BigInt(0);
    let totalInputSum = BigInt(0);
    let totalOutputSum = BigInt(0);

    const vin: Transaction['details']['vin'] = [];
    const vout: Transaction['details']['vout'] = [];

    for (let i = 0; i < txObj.inputs.length; i++) {
        const input = txObj.inputs[i];
        const prevHash = String(input.previousOutput.txHash);
        const prevIndex = Number(input.previousOutput.index);

        if (/^0x0+$/.test(prevHash)) {
            vin.push({
                n: i,
                addresses: [],
                isAddress: false,
                coinbase: 'cellbase',
            });
            continue;
        }

        try {
            const prevTxResponse = await fetchTx(prevHash);
            const prevOutput = prevTxResponse?.transaction.outputs[prevIndex];

            if (!prevOutput) {
                vin.push({
                    n: i,
                    txid: trimHexPrefix(prevHash),
                    vout: prevIndex,
                    addresses: [],
                    isAddress: false,
                });
                continue;
            }

            const value = BigInt(prevOutput.capacity);
            const isOwn = ownLockScript ? prevOutput.lock.eq(ownLockScript) : undefined;
            totalInputSum += value;

            if (isOwn) {
                myInputSum += value;
            }

            vin.push({
                n: i,
                txid: trimHexPrefix(prevHash),
                vout: prevIndex,
                addresses: [],
                isAddress: true,
                ...(typeof isOwn === 'boolean' ? { isOwn } : {}),
                value: value.toString(),
            });
        } catch {
            vin.push({
                n: i,
                txid: trimHexPrefix(prevHash),
                vout: prevIndex,
                addresses: [],
                isAddress: false,
            });
        }
    }

    for (let i = 0; i < txObj.outputs.length; i++) {
        const output = txObj.outputs[i];
        const value = BigInt(output.capacity);
        const isOwn = ownLockScript ? output.lock.eq(ownLockScript) : undefined;

        totalOutputSum += value;
        if (isOwn) {
            myOutputSum += value;
        }

        vout.push({
            n: i,
            addresses: [],
            isAddress: true,
            ...(typeof isOwn === 'boolean' ? { isOwn } : {}),
            value: value.toString(),
        });
    }

    const fee = totalInputSum > totalOutputSum ? (totalInputSum - totalOutputSum).toString() : '0';

    let type: Transaction['type'] = 'unknown';
    let amount = '0';

    if (ownLockScript) {
        if (
            myInputSum > BigInt(0) &&
            myInputSum === totalInputSum &&
            myOutputSum === totalOutputSum
        ) {
            type = 'self';
            amount = fee;
        } else if (myInputSum > myOutputSum) {
            type = 'sent';
            amount = (myInputSum - myOutputSum).toString();
        } else if (myOutputSum > BigInt(0)) {
            type = 'recv';
            amount = (myOutputSum - myInputSum).toString();
        }
    }

    const blockNum = txResponse.blockNumber ? Number(txResponse.blockNumber) : undefined;
    const blockTime = blockNum ? await getBlockTimestamp(blockNum) : undefined;

    return {
        type,
        txid: trimHexPrefix(String(txObj.hash())),
        blockHeight: blockNum,
        blockHash: txResponse.blockHash ? trimHexPrefix(String(txResponse.blockHash)) : undefined,
        blockTime,
        amount,
        fee,
        targets: [],
        tokens: [],
        internalTransfers: [],
        details: {
            vin,
            vout,
            size: 0,
            totalInput: totalInputSum.toString(),
            totalOutput: totalOutputSum.toString(),
        },
    };
};

const getLockScriptTransactions = async ({
    lockScript,
    client,
    page,
    pageSize,
}: {
    lockScript: Awaited<ReturnType<typeof Address.fromString>>['script'];
    client: CccClient;
    page?: number;
    pageSize: number;
}) => {
    const fetchTx = createTransactionFetcher(client);
    const getBlockTimestamp = createBlockTimestampFetcher(client);
    const transactions: AccountHistoryTransaction[] = [];

    let total = 0;
    const start = Math.max(0, ((page ?? 1) - 1) * pageSize);
    const end = start + pageSize;

    for await (const tx of client.findTransactionsByLock(lockScript, undefined, true, 'desc')) {
        const txResponse = await fetchTx(String(tx.txHash));
        if (!txResponse) {
            continue;
        }

        const blockNum = txResponse.blockNumber ? Number(txResponse.blockNumber) : undefined;
        const blockTime = blockNum ? await getBlockTimestamp(blockNum) : undefined;

        if (!blockTime) {
            continue;
        }

        if (total >= start && total < end) {
            transactions.push(
                await mapTransaction({
                    txResponse,
                    fetchTx,
                    getBlockTimestamp,
                    ownLockScript: lockScript,
                }).then(mappedTransaction => ({
                    ...mappedTransaction,
                    blockTime,
                })),
            );
        }

        total++;

        if (total >= end && page !== undefined) {
            continue;
        }
    }

    return {
        total,
        transactions,
    };
};

const getInfo = async (request: Request<MessageTypes.GetInfo>) => {
    const client = await request.connect();
    const tip = await client.getTip();

    return {
        type: RESPONSES.GET_INFO,
        payload: {
            url: client.url,
            name: 'CKB',
            shortcut: 'CKB',
            decimals: CKB_DECIMALS,
            testnet: client.addressPrefix === 'ckt',
            version: '0.1.0',
            network: client.addressPrefix === 'ckt' ? 'testnet' : 'mainnet',
            blockHeight: Number(tip),
            blockHash: '0x',
        },
    } as const;
};

const getAccountInfo = async (request: Request<MessageTypes.GetAccountInfo>) => {
    const { payload } = request;
    const client = await request.connect();

    // Default empty account state
    const account: AccountInfo = {
        descriptor: payload.descriptor,
        balance: '0',
        availableBalance: '0',
        empty: true,
        history: {
            total: -1,
            unconfirmed: 0,
            transactions: undefined,
        },
    };

    try {
        // Parse CKB address to get lock script
        const address = await Address.fromString(payload.descriptor, client);
        const lockScript = address.script;

        // Get balance (in shannons)
        const balance = await client.getBalanceSingle(lockScript);
        const balanceStr = balance.toString();

        account.balance = balanceStr;
        account.availableBalance = balanceStr;
        account.empty = balance === BigInt(0);

        // Get transaction history if requested.
        // History fetching is best-effort and should not break discovery.
        if (payload.details === 'txs') {
            try {
                const pageSize = payload.pageSize || DEFAULT_PAGE_SIZE;
                const pageIndex = payload.page || 1;
                const { total, transactions } = await getLockScriptTransactions({
                    lockScript,
                    client,
                    page: pageIndex,
                    pageSize,
                });

                account.history = {
                    total,
                    unconfirmed: 0,
                    transactions,
                };
                account.page = {
                    index: pageIndex,
                    size: pageSize,
                    total: Math.ceil(total / pageSize),
                };
            } catch {
                account.history = {
                    total: 0,
                    unconfirmed: 0,
                    transactions: [],
                };
            }
        }
    } catch (error: unknown) {
        // If account doesn't exist or other error, return empty account
        if (
            error instanceof Error &&
            (error.message.includes('not found') || error.message.includes('Unknown'))
        ) {
            return {
                type: RESPONSES.GET_ACCOUNT_INFO,
                payload: account,
            } as const;
        }
        throw error;
    }

    return {
        type: RESPONSES.GET_ACCOUNT_INFO,
        payload: account,
    } as const;
};

const getTransaction = async ({ connect, payload }: Request<MessageTypes.GetTransaction>) => {
    const client = await connect();
    const fetchTx = createTransactionFetcher(client);
    const getBlockTimestamp = createBlockTimestampFetcher(client);
    const txResponse = await fetchTx(payload);

    if (!txResponse) {
        throw new CustomError('Transaction', 'Transaction not found');
    }

    return {
        type: RESPONSES.GET_TRANSACTION,
        payload: await mapTransaction({
            txResponse,
            fetchTx,
            getBlockTimestamp,
        }),
    } as const;
};

const getTransactionHex = (_request: Request<MessageTypes.GetTransactionHex>) => {
    throw new CustomError('worker_runtime', 'getTransactionHex is not supported by the CKB worker');
};

const pushTransaction = async ({ connect, payload }: Request<MessageTypes.PushTransaction>) => {
    const client = await connect();
    // payload.hex contains the serialized transaction
    const txHash = await client.sendTransactionNoCache(JSON.parse(payload.hex));

    return {
        type: RESPONSES.PUSH_TRANSACTION,
        payload: txHash.slice(2), // remove '0x' prefix
    } as const;
};

const getAccountBalanceHistory = async (
    request: Request<MessageTypes.GetAccountBalanceHistory>,
) => {
    const { payload } = request;
    const client = await request.connect();
    const address = await Address.fromString(payload.descriptor, client);
    const lockScript = address.script;

    const { transactions } = await getLockScriptTransactions({
        lockScript,
        client,
        page: undefined,
        pageSize: Number.MAX_SAFE_INTEGER,
    });

    const filteredTransactions = transactions
        .filter(
            ({ blockTime }) =>
                (payload.from || 0) <= blockTime &&
                blockTime <= (payload.to || Number.MAX_SAFE_INTEGER),
        )
        .sort((first, second) => first.blockTime - second.blockTime);

    return {
        type: RESPONSES.GET_ACCOUNT_BALANCE_HISTORY,
        payload: aggregateTransactions(filteredTransactions, payload.groupBy),
    } as const;
};

const estimateFee = async (request: Request<MessageTypes.EstimateFee>) => {
    const client = await request.connect();
    const feeRate = await client.getFeeRate();

    // feeRate is in shannons/KB
    const feePerUnit = feeRate.toString();

    const payload =
        request.payload && Array.isArray(request.payload.blocks)
            ? request.payload.blocks.map(() => ({ feePerUnit }))
            : [{ feePerUnit }];

    return {
        type: RESPONSES.ESTIMATE_FEE,
        payload,
    } as const;
};

// Block subscription via polling
let blockPollInterval: ReturnType<typeof setInterval> | undefined;

const subscribeBlock = async (ctx: Context) => {
    if (!ctx.state.getSubscription('block')) {
        ctx.state.addSubscription('block');

        const client = await ctx.connect();
        let lastTip = Number(await client.getTip());

        blockPollInterval = setInterval(async () => {
            try {
                const currentTip = Number(await client.getTip());
                if (currentTip > lastTip) {
                    lastTip = currentTip;
                    ctx.post({
                        id: -1,
                        type: RESPONSES.NOTIFICATION,
                        payload: {
                            type: 'block',
                            payload: {
                                blockHeight: currentTip,
                                blockHash: '0x',
                            },
                        },
                    });
                }
            } catch {
                // ignore polling errors
            }
        }, 15000); // Poll every 15 seconds
    }

    return { subscribed: true };
};

const unsubscribeBlock = ({ state }: Context) => {
    if (blockPollInterval) {
        clearInterval(blockPollInterval);
        blockPollInterval = undefined;
    }
    state.removeSubscription('block');

    return { subscribed: false };
};

const subscribe = async (request: Request<MessageTypes.Subscribe>) => {
    const { payload } = request;

    switch (payload.type) {
        case 'block':
            return {
                type: RESPONSES.SUBSCRIBE,
                payload: await subscribeBlock(request),
            } as const;
        case 'accounts':
        case 'addresses':
            return {
                type: RESPONSES.SUBSCRIBE,
                payload: { subscribed: false },
            } as const;
        default:
            throw new CustomError('invalid_param', '+type');
    }
};

const unsubscribe = (request: Request<MessageTypes.Unsubscribe>) => {
    const { payload } = request;

    switch (payload.type) {
        case 'block':
            return {
                type: RESPONSES.UNSUBSCRIBE,
                payload: unsubscribeBlock(request),
            } as const;
        case 'accounts':
        case 'addresses':
            return {
                type: RESPONSES.UNSUBSCRIBE,
                payload: { subscribed: false },
            } as const;
        default:
            throw new CustomError('invalid_param', '+type');
    }
};

const getAccountUtxo = async (request: Request<MessageTypes.GetAccountUtxo>) => {
    const descriptor = request.payload;
    const client = await request.connect();
    const fetchTx = createTransactionFetcher(client);
    const tip = Number(await client.getTip());

    try {
        const address = await Address.fromString(descriptor, client);
        const lockScript = address.script;

        // Collect CKB live cells as UTXOs
        const utxos: Utxo[] = [];
        for await (const cell of client.findCellsByLock(lockScript, undefined, true)) {
            const txResponse = await fetchTx(String(cell.outPoint.txHash));
            const blockHeight = txResponse?.blockNumber ? Number(txResponse.blockNumber) : 0;
            const confirmations = blockHeight > 0 ? Math.max(0, tip - blockHeight + 1) : 0;

            utxos.push({
                txid: String(cell.outPoint.txHash).replace(/^0x/, ''),
                vout: Number(cell.outPoint.index),
                amount: cell.cellOutput.capacity.toString(),
                blockHeight,
                address: descriptor,
                path: '',
                confirmations,
            });
        }

        return {
            type: RESPONSES.GET_ACCOUNT_UTXO,
            payload: utxos,
        } as const;
    } catch {
        // Return empty UTXO set on any error (e.g. address parse failure, RPC error)
        return {
            type: RESPONSES.GET_ACCOUNT_UTXO,
            payload: [] as Utxo[],
        } as const;
    }
};

const onRequest = (request: Request<MessageTypes.Message>) => {
    switch (request.type) {
        case MESSAGES.GET_INFO:
            return getInfo(request);
        case MESSAGES.GET_ACCOUNT_INFO:
            return getAccountInfo(request);
        case MESSAGES.GET_ACCOUNT_UTXO:
            return getAccountUtxo(request);
        case MESSAGES.GET_TRANSACTION:
            return getTransaction(request);
        case MESSAGES.GET_TRANSACTION_HEX:
            return getTransactionHex(request);
        case MESSAGES.GET_ACCOUNT_BALANCE_HISTORY:
            return getAccountBalanceHistory(request);
        case MESSAGES.ESTIMATE_FEE:
            return estimateFee(request);
        case MESSAGES.PUSH_TRANSACTION:
            return pushTransaction(request);
        case MESSAGES.SUBSCRIBE:
            return subscribe(request);
        case MESSAGES.UNSUBSCRIBE:
            return unsubscribe(request);
        default:
            throw new CustomError('worker_unknown_request', `+${request.type}`);
    }
};

class CkbWorker extends BaseWorker<CccClient> {
    protected isConnected(client: CccClient | undefined): client is CccClient {
        return client !== undefined;
    }

    async tryConnect(url: string): Promise<CccClient> {
        // Determine if mainnet or testnet based on url or settings
        const isTestnet =
            url.includes('testnet') || this.settings.name?.toLowerCase().includes('tckb');

        const client = isTestnet
            ? new ClientPublicTestnet({ url })
            : new ClientPublicMainnet({ url });

        // Verify connection by fetching tip
        await client.getTip();

        this.post({ id: -1, type: RESPONSES.CONNECTED });

        return client;
    }

    disconnect() {
        if (blockPollInterval) {
            clearInterval(blockPollInterval);
            blockPollInterval = undefined;
        }
        this.cleanup();

        return Promise.resolve();
    }

    async messageHandler(event: { data: MessageTypes.Message }) {
        try {
            if (await super.messageHandler(event)) return true;

            const request: Request<MessageTypes.Message> = {
                ...event.data,
                connect: () => this.connect(),
                post: (data: Response) => this.post(data),
                state: this.state,
            };

            const response = await onRequest(request);
            this.post({ id: event.data.id, ...response });
        } catch (error: unknown) {
            this.errorResponse(event.data.id, error);
        }
    }
}

// export worker factory used in src/index
export default function Ckb() {
    return new CkbWorker();
}

if (CONTEXT === 'worker') {
    // Initialize module if script is running in worker context
    const module = new CkbWorker();
    onmessage = module.messageHandler.bind(module);
}
