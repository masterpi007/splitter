import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { calculateBalances, formatCurrency, formatRelativeTime } from '../utils/balances';
import { YouBadge } from '../components/YouBadge';

export function Dashboard() {
  const { group, expenses, currentUser } = useApp();

  if (!group) {
    return (
      <div className="max-w-md mx-auto mt-8">
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 text-center space-y-3">
          <h2 className="text-lg font-semibold text-gray-100">No active group</h2>
          <p className="text-sm text-gray-400">Sign in, then create or join a group to start using Splitter.</p>
          <Link
            to="/groups"
            className="inline-block px-4 py-2 bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg text-sm font-medium"
          >
            Open groups
          </Link>
        </div>
      </div>
    );
  }

  const balances = calculateBalances(expenses, group.members);
  const currentUserBalance = currentUser
    ? balances.find((b) => b.memberId === currentUser.id)
    : null;

  const pendingForUser = currentUser
    ? expenses.filter((e) =>
        !e.tags?.includes('deleted') &&
        e.splits.some(
          (s) => s.memberId === currentUser.id && !s.signedOff
        )
      )
    : [];

  const waitingForOthers = currentUser
    ? expenses.filter(
        (e) =>
          !e.tags?.includes('deleted') &&
          e.paidBy === currentUser.id &&
          e.splits.some((s) => !s.signedOff && s.memberId !== currentUser.id)
      )
    : [];

  // Calculate total pending amounts
  const toSignOffAmount = currentUser
    ? pendingForUser.reduce((sum, e) => {
        const userSplit = e.splits.find((s) => s.memberId === currentUser.id && !s.signedOff);
        return sum + (userSplit?.amount || 0);
      }, 0)
    : 0;

  const awaitingOthersAmount = currentUser
    ? waitingForOthers.reduce((sum, e) => {
        const othersUnsigned = e.splits
          .filter((s) => !s.signedOff && s.memberId !== currentUser.id)
          .reduce((s, split) => s + split.amount, 0);
        return sum + othersUnsigned;
      }, 0)
    : 0;

  // Incomplete expenses - current user is payer and has unassigned items
  const incomplete = currentUser
    ? expenses.filter(
        (e) =>
          !e.tags?.includes('deleted') &&
          e.paidBy === currentUser.id &&
          e.items?.some((item) => !item.memberId)
      )
    : [];

  const incompleteAmount = incomplete.reduce((sum, e) => {
    const unassignedSum = e.items
      ?.filter((item) => !item.memberId)
      .reduce((s, item) => s + item.amount, 0) || 0;
    return sum + unassignedSum;
  }, 0);

  return (
    <div className="space-y-6">
      <div className="text-center py-6">
        <h2 className="text-2xl font-bold text-gray-100">{group.name}</h2>
        <p className="text-gray-400">{group.members.length} members</p>
      </div>

      {!currentUser ? (
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 text-center">
          <p className="text-yellow-200">
            Select your name from the dropdown above to get started
          </p>
        </div>
      ) : (
        <>
          <div className="bg-gray-800 rounded-lg shadow-sm border border-gray-700 p-6 text-center">
            <p className="text-sm text-gray-400 mb-1">Your balance</p>
            <p className="text-3xl font-bold">
              <span
                className={
                  currentUserBalance && currentUserBalance.signedBalance > 0.01
                    ? 'text-green-400'
                    : currentUserBalance && currentUserBalance.signedBalance < -0.01
                    ? 'text-red-400'
                    : 'text-gray-400'
                }
              >
                {formatCurrency(currentUserBalance?.signedBalance ?? 0, group.currency)}
              </span>
              {currentUserBalance && Math.abs(currentUserBalance.pendingBalance) > 0.01 && (
                <span className={`text-xl ml-1 opacity-50 ${currentUserBalance.pendingBalance > 0 ? 'text-green-500' : 'text-red-400'}`}>
                  ({currentUserBalance.pendingBalance > 0 ? '+' : ''}{formatCurrency(currentUserBalance.pendingBalance, group.currency)})
                </span>
              )}
            </p>
          </div>

          {incomplete.length > 0 && (
            <Link
              to="/pending"
              className="block w-full bg-gray-800 rounded-lg shadow-sm border border-orange-700 p-4 text-center hover:border-orange-500"
            >
              <p className="text-2xl font-bold text-orange-400">
                {incomplete.length}
              </p>
              <p className="text-sm text-gray-400">Incomplete</p>
              {incompleteAmount > 0 && (
                <p className="text-xs text-orange-400 mt-1">
                  {formatCurrency(incompleteAmount, group.currency)} unassigned
                </p>
              )}
            </Link>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Link
              to="/pending"
              className="bg-gray-800 rounded-lg shadow-sm border border-gray-700 p-4 text-center hover:border-cyan-500 flex flex-col items-center gap-1"
            >
              <svg className="w-5 h-5 text-cyan-500 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              <p className="text-2xl font-bold text-cyan-400">{pendingForUser.length}</p>
              <p className="text-sm text-gray-400">To accept</p>
              {toSignOffAmount > 0 && (
                <p className="text-xs text-red-400">{formatCurrency(toSignOffAmount, group.currency)}</p>
              )}
            </Link>
            <Link
              to="/pending"
              className="bg-gray-800 rounded-lg shadow-sm border border-gray-700 p-4 text-center hover:border-orange-500 flex flex-col items-center gap-1"
            >
              <svg className="w-5 h-5 text-orange-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-2xl font-bold text-orange-400">{waitingForOthers.length}</p>
              <p className="text-sm text-gray-400">Awaiting others</p>
              {awaitingOthersAmount > 0 && (
                <p className="text-xs text-green-400">{formatCurrency(awaitingOthersAmount, group.currency)}</p>
              )}
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Link
              to="/add"
              className="bg-cyan-600 text-white rounded-lg p-4 text-center font-medium hover:bg-cyan-700"
            >
              Add Transaction
            </Link>
            <Link
              to="/balances"
              className="bg-gray-800 border border-cyan-500 text-cyan-400 rounded-lg p-4 text-center font-medium hover:bg-cyan-900/30"
            >
              View Balances
            </Link>
          </div>
        </>
      )}

      <div className="bg-gray-800 rounded-lg shadow-sm border border-gray-700 p-4">
        <h3 className="font-medium mb-3">Recent Activity</h3>
        {expenses.length === 0 ? (
          <p className="text-gray-400 text-sm">No transactions yet</p>
        ) : (
          <div className="space-y-2">
            {expenses
              .slice(-5)
              .reverse()
              .map((expense) => {
                const payer = group.members.find((m) => m.id === expense.paidBy);
                return (
                  <Link
                    key={expense.id}
                    to={`/expenses?expand=${expense.id}`}
                    className="flex justify-between text-sm py-2 border-b border-gray-700 last:border-0 hover:bg-gray-700/50 -mx-2 px-2 rounded"
                  >
                    <div>
                      <p className="font-medium">{expense.description}</p>
                      <p className="text-gray-400 text-xs flex items-center gap-1 flex-wrap">
                        by <span className="text-gray-200">{payer?.name || 'Unknown'}</span>
                        {currentUser && payer?.id === currentUser.id && (
                          <YouBadge />
                        )}
                        <span className="mx-1">•</span>
                        {formatRelativeTime(expense.createdAt)}
                      </p>
                    </div>
                    <p className="font-medium">
                      {formatCurrency(expense.amount, group.currency)}
                    </p>
                  </Link>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
