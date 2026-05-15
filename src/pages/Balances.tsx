import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { BalanceCard } from '../components/BalanceCard';
import { WeeklySpendingChart } from '../components/WeeklySpendingChart';
import {
  calculateBalances,
  calculateSettlements,
  formatCurrency,
} from '../utils/balances';
import { YouBadge } from '../components/YouBadge';

export function Balances() {
  const { group, expenses, currentUser } = useApp();
  const [suggestionsCollapsed, setSuggestionsCollapsed] = useState(true);

  if (!group) return null;

  // Soft-removed members may still carry unsettled balances (e.g. they owe
  // someone at the moment of removal). Including them here keeps the numbers
  // honest; `Math.round(... * 10) !== 0` below hides anyone already at zero.
  const allMembers = [...group.members, ...group.removedMembers];
  const balances = calculateBalances(expenses, allMembers);
  const settlements = calculateSettlements(balances);
  const sortedBalances = [...balances].sort((a, b) => b.signedBalance - a.signedBalance);

  return (
    <div className="space-y-8">
      <section>
        <WeeklySpendingChart expenses={expenses} currentUserId={currentUser?.id ?? null} currency={group.currency} hasUser={!!currentUser} />
      </section>

      <section>
        <h2 className="text-xl font-bold mb-4">Balances</h2>

        {group.members.length === 0 ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
            <p className="text-gray-400">Add members to see balances</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedBalances
              .filter((balance) => Math.round((balance.signedBalance + balance.pendingBalance) * 10) !== 0)
              .map((balance) => {
                // Find suggested settlement where this member is the payer
                const suggestedSettlement = settlements.find(s => s.from === balance.memberId);
                return (
                  <BalanceCard
                    key={balance.memberId}
                    balance={balance}
                    currency={group.currency}
                    isCurrentUser={balance.memberId === currentUser?.id}
                    suggestedSettlement={suggestedSettlement}
                  />
                );
              })}
          </div>
        )}
      </section>

      <section>
        <div className="flex justify-between items-center mb-4">
          <button
            onClick={() => setSuggestionsCollapsed(!suggestionsCollapsed)}
            className="flex items-center gap-2 text-xl font-bold hover:text-gray-300"
          >
            <svg
              className={`w-5 h-5 transition-transform ${suggestionsCollapsed ? '' : 'rotate-90'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Settlement Suggestions
            {settlements.length > 0 && (
              <span className="text-sm font-normal text-gray-400">({settlements.length})</span>
            )}
          </button>
          <Link
            to="/settle"
            className="text-sm text-cyan-400 hover:text-cyan-300"
          >
            + Manual
          </Link>
        </div>

        {!suggestionsCollapsed && (
          <>
            {settlements.length === 0 ? (
              <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 text-center">
                <p className="text-green-200">Everyone is settled up!</p>
              </div>
            ) : (
              <div className="space-y-3">
                {settlements.map((settlement, index) => (
                  <div
                    key={index}
                    className="bg-gray-800 rounded-lg border border-gray-700 p-3 flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate flex items-center gap-1">
                        {settlement.fromName}
                        {settlement.from === currentUser?.id && (
                          <YouBadge />
                        )}
                      </span>
                      <span className="text-gray-500 flex-shrink-0">→</span>
                      <span className="font-medium truncate flex items-center gap-1">
                        {settlement.toName}
                        {settlement.to === currentUser?.id && (
                          <YouBadge />
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="font-semibold">
                        {formatCurrency(settlement.amount, group.currency)}
                      </span>
                      <Link
                        to={`/settle?from=${settlement.from}&to=${settlement.to}&amount=${settlement.amount}`}
                        className="text-sm bg-cyan-600 text-white px-3 py-1 rounded hover:bg-cyan-700"
                      >
                        Settle
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="bg-gray-800 rounded-lg p-4">
        <h3 className="font-medium mb-2">How it works</h3>
        <ul className="text-sm text-gray-400 space-y-1">
          <li>Positive balance = you are owed money</li>
          <li>Negative balance = you owe money</li>
          <li><span className="text-green-500">Accepted</span> = confirmed transactions</li>
          <li><span className="text-yellow-500">Pending</span> = awaiting acceptance</li>
          <li>Settlement suggestions based on accepted balances only</li>
          <li><span className="text-green-400">Settlements</span> = money transfers between members</li>
          <li>Recipients must confirm settlements received</li>
        </ul>
      </section>
    </div>
  );
}
