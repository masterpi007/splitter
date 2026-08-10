import { useState } from 'react';
import { useApp } from '../context/AppContext';
import { ExpenseCard } from '../components/ExpenseCard';
import { formatCurrency } from '../utils/balances';

export function PendingActions() {
  const { group, expenses, currentUser, signOffExpense } = useApp();
  const [signingAll, setSigningAll] = useState(false);

  if (!group) return null;

  if (!currentUser) {
    return (
      <div>
        <h2 className="text-xl font-bold mb-6">Pending Actions</h2>
        <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 text-center">
          <p className="text-yellow-200">
            Select your name from the dropdown above to see your pending actions
          </p>
        </div>
      </div>
    );
  }

  // Expenses where current user needs to sign off
  const toSignOff = expenses.filter((e) =>
    !e.tags?.includes('deleted') &&
    e.splits.some((s) => s.memberId === currentUser.id && !s.signedOff)
  );

  // Calculate total pending amount for user
  const toSignOffAmount = toSignOff.reduce((sum, e) => {
    const userSplit = e.splits.find((s) => s.memberId === currentUser.id && !s.signedOff);
    return sum + (userSplit?.amount || 0);
  }, 0);

  // Expenses current user paid, waiting for others to sign
  const awaitingOthers = expenses.filter(
    (e) =>
      !e.tags?.includes('deleted') &&
      e.paidBy === currentUser.id &&
      e.splits.some((s) => !s.signedOff && s.memberId !== currentUser.id)
  );

  // Incomplete expenses - current user is payer and has unassigned items
  const incomplete = expenses.filter(
    (e) =>
      !e.tags?.includes('deleted') &&
      e.paidBy === currentUser.id &&
      e.items?.some((item) => !item.memberId)
  );

  // Calculate total unassigned amount
  const incompleteAmount = incomplete.reduce((sum, e) => {
    const unassignedSum = e.items
      ?.filter((item) => !item.memberId)
      .reduce((s, item) => s + item.amount, 0) || 0;
    return sum + unassignedSum;
  }, 0);

  return (
    <div className="space-y-8">
      {/* Incomplete section - only show if there are incomplete expenses */}
      {incomplete.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">
            Incomplete ({incomplete.length})
            {incompleteAmount > 0 && (
              <span className="text-orange-400 ml-2">
                {formatCurrency(incompleteAmount, group.currency)}
              </span>
            )}
          </h2>
          <div className="space-y-4">
            {incomplete.map((expense) => {
              const unassignedCount = expense.items?.filter((item) => !item.memberId).length || 0;
              return (
                <div key={expense.id}>
                  <ExpenseCard
                    expense={expense}
                    members={group.members}
                    currency={group.currency}
                  />
                  <p className="text-sm text-orange-400 mt-2 px-4">
                    {unassignedCount} unassigned item{unassignedCount !== 1 ? 's' : ''} - tap Edit to assign
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">
            To Accept ({toSignOff.length})
            {toSignOffAmount > 0 && (
              <span className="text-red-400 ml-2">
                {formatCurrency(toSignOffAmount, group.currency)}
              </span>
            )}
          </h2>
          {toSignOff.length > 0 && (
            <button
              onClick={async () => {
                setSigningAll(true);
                try {
                  // Sequential on purpose: the server stores all group
                  // expenses in one KV record, so parallel sign-offs
                  // overwrite each other (last write wins).
                  let failed = 0;
                  for (const expense of toSignOff) {
                    try {
                      await signOffExpense(expense);
                    } catch {
                      failed++;
                    }
                  }
                  if (failed > 0) {
                    // Some succeeded, some failed — UI will refresh from context
                    console.warn(`${failed} of ${toSignOff.length} sign-offs failed`);
                  }
                } finally {
                  setSigningAll(false);
                }
              }}
              disabled={signingAll}
              className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {signingAll ? 'Accepting...' : `Accept All (${toSignOff.length})`}
            </button>
          )}
        </div>
        {toSignOff.length === 0 ? (
          <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 text-center">
            <p className="text-green-200">You're all caught up!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {toSignOff.map((expense) => (
              <ExpenseCard
                key={expense.id}
                expense={expense}
                members={group.members}
                currency={group.currency}
                showSignOff
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4">
          Awaiting Others ({awaitingOthers.length})
        </h2>
        {awaitingOthers.length === 0 ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
            <p className="text-gray-400">No expenses waiting for others</p>
          </div>
        ) : (
          <div className="space-y-4">
            {awaitingOthers.map((expense) => {
              const pendingMembers = expense.splits
                .filter((s) => !s.signedOff && s.memberId !== currentUser.id)
                .map((s) => {
                  const member = group.members.find((m) => m.id === s.memberId);
                  return member?.name || 'Unknown';
                });

              return (
                <div key={expense.id}>
                  <ExpenseCard
                    expense={expense}
                    members={group.members}
                    currency={group.currency}
                  />
                  <p className="text-sm text-orange-400 mt-2 px-4">
                    Waiting for: {pendingMembers.join(', ')}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
