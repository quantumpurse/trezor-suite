import { type MiddlewareAPI } from 'redux';

import { isLocalBalanceHistoryCoin } from '@suite-common/graph';
import { accountsActions, discoveryActions, transactionsActions } from '@suite-common/wallet-core';

import * as graphActions from 'src/actions/wallet/graphActions';
import { type Action, type AppState, type Dispatch } from 'src/types/suite';

export const graphMiddleware =
    (api: MiddlewareAPI<Dispatch, AppState>) =>
    (next: Dispatch) =>
    (action: Action): Action => {
        next(action);
        const {
            wallet: { accounts: currentAccounts, selectedAccount },
        } = api.getState();

        if (accountsActions.updateSelectedAccount.match(action)) {
            // fetch graph data for selected account and range if needed
            if (action.payload.account) {
                api.dispatch(
                    graphActions.updateGraphData({
                        accounts: [action.payload.account],
                    }),
                );
            }
        }

        if (
            action.type === discoveryActions.updateDiscovery.type &&
            action.payload.status.status === 'complete'
        ) {
            api.dispatch(
                graphActions.updateGraphData({
                    accounts: currentAccounts,
                }),
            );
        }

        if (
            (transactionsActions.addTransaction.match(action) ||
                transactionsActions.removeTransaction.match(action)) &&
            selectedAccount.status === 'loaded' &&
            selectedAccount.account?.key === action.payload.account.key &&
            isLocalBalanceHistoryCoin(action.payload.account.symbol)
        ) {
            api.dispatch(
                graphActions.updateGraphData({
                    accounts: [action.payload.account],
                }),
            );
        }

        return action;
    };
