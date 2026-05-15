import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ExpenseCard } from '../components/ExpenseCard';
import { getDateKey, formatDateHeader, getTagColor, isDeleted } from '../utils/balances';
import { Expense, Member } from '../types';

export function Expenses() {
  const { group, expenses, currentUser } = useApp();
  const [searchParams] = useSearchParams();
  const expandId = searchParams.get('expand');
  const [filter, setFilter] = useState<'all' | 'mine' | 'deleted'>('all');
  const [sortBy, setSortBy] = useState<'payment' | 'created'>('payment');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  // Scroll to expanded expense on mount
  useEffect(() => {
    if (expandId) {
      const element = document.getElementById(`expense-${expandId}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [expandId]);

  if (!group) return null;

  // Get all unique tags from expenses (exclude 'deleted' system tag)
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    expenses.forEach((e) => e.tags?.forEach((t) => {
      if (t !== 'deleted') tags.add(t);
    }));
    return Array.from(tags).sort();
  }, [expenses]);

  // Apply filters
  let filteredExpenses = expenses;

  // Filter by mine/all/deleted
  if (filter === 'mine') {
    // "Mine" view: show user's expenses (exclude deleted)
    filteredExpenses = filteredExpenses.filter(
      (e) =>
        !isDeleted(e) &&
        (e.paidBy === currentUser?.id ||
          e.splits.some((s) => s.memberId === currentUser?.id))
    );
  } else if (filter === 'deleted') {
    // "Deleted" view: show all deleted expenses from everyone
    filteredExpenses = filteredExpenses.filter((e) => isDeleted(e));
  } else {
    // "All" view: hide deleted expenses
    filteredExpenses = filteredExpenses.filter((e) => !isDeleted(e));
  }

  // Filter by tag (exclude 'deleted' from tag filter options)
  if (selectedTag) {
    filteredExpenses = filteredExpenses.filter((e) =>
      e.tags?.includes(selectedTag)
    );
  }

  const getDateForSort = (e: Expense) =>
    sortBy === 'payment' ? (e.receiptDate ?? e.createdAt) : e.createdAt;

  const sortedExpenses = [...filteredExpenses].sort(
    (a, b) => new Date(getDateForSort(b)).getTime() - new Date(getDateForSort(a)).getTime()
  );

  // Group expenses by day
  const groupedExpenses = useMemo(() => {
    const groups: { dateKey: string; expenses: Expense[] }[] = [];
    let currentDateKey = '';
    let currentGroup: Expense[] = [];

    sortedExpenses.forEach((expense) => {
      const dateKey = getDateKey(getDateForSort(expense));
      if (dateKey !== currentDateKey) {
        if (currentGroup.length > 0) {
          groups.push({ dateKey: currentDateKey, expenses: currentGroup });
        }
        currentDateKey = dateKey;
        currentGroup = [expense];
      } else {
        currentGroup.push(expense);
      }
    });

    if (currentGroup.length > 0) {
      groups.push({ dateKey: currentDateKey, expenses: currentGroup });
    }

    return groups;
  }, [sortedExpenses]);

const getMemberName = (id: string, members: Member[]) =>
    members.find((m) => m.id === id)?.name || 'Unknown';

  const exportToCSV = () => {
    if (!group) return;

    // CSV header
    const headers = ['Date', 'Description', 'Amount', 'Currency', 'Paid By', 'Participant', 'Share', 'Status', 'Tags'];

    // Build CSV rows - one row per split
    const rows: string[][] = [];

    sortedExpenses.forEach((expense) => {
      const date = new Date(getDateForSort(expense)).toISOString().split('T')[0];
      const payer = getMemberName(expense.paidBy, group.members);
      const tags = expense.tags?.join(', ') || '';

      // Export assigned splits
      expense.splits.forEach((split) => {
        const participant = getMemberName(split.memberId, group.members);
        const status = split.signedOff ? 'Accepted' : 'Pending';

        rows.push([
          date,
          expense.description,
          expense.amount.toString(),
          group.currency,
          payer,
          participant,
          split.amount.toString(),
          status,
          tags,
        ]);
      });

      // Export unclaimed items with empty participant
      expense.items?.filter(item => !item.memberId).forEach((item) => {
        rows.push([
          date,
          item.description || expense.description,
          expense.amount.toString(),
          group.currency,
          payer,
          '', // Empty participant for unclaimed items
          item.amount.toString(),
          'Unclaimed',
          tags,
        ]);
      });
    });

    // Convert to CSV string
    const escapeCSV = (str: string) => {
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const csvContent = [
      headers.map(escapeCSV).join(','),
      ...rows.map((row) => row.map(escapeCSV).join(',')),
    ].join('\n');

    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.name.replace(/[^a-zA-Z0-9]/g, '_')}_expenses_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
<div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold">All Transactions</h2>
        <div className="flex gap-2">
          {expenses.length > 0 && (
            <button
              onClick={exportToCSV}
              className="bg-gray-700 text-gray-300 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-600"
            >
              Export CSV
            </button>
          )}
          <Link
            to="/add"
            className="bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            + Add
          </Link>
        </div>
      </div>

      {currentUser && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                filter === 'all'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-gray-700 text-gray-300'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilter('mine')}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                filter === 'mine'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-gray-700 text-gray-300'
              }`}
            >
              Yours
            </button>
            <button
              onClick={() => setFilter('deleted')}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                filter === 'deleted'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-300'
              }`}
            >
              Trash
            </button>
          </div>
          <button
            onClick={() => setSortBy(prev => prev === 'payment' ? 'created' : 'payment')}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            {sortBy === 'payment' ? 'Paid' : 'Added'} ↓
          </button>
        </div>
      )}

      {/* Tag filter */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setSelectedTag(null)}
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              selectedTag === null
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            All tags
          </button>
          {allTags.map((tag) => {
            const color = getTagColor(tag);
            return (
              <button
                key={tag}
                onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                className={`px-3 py-1 rounded-full text-xs font-medium ${
                  selectedTag === tag
                    ? 'bg-cyan-600 text-white'
                    : `${color.bg} ${color.text} ${color.hoverBg}`
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {groupedExpenses.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p>No transactions yet</p>
          <Link to="/add" className="text-cyan-400 font-medium mt-2 inline-block">
            Add your first transaction
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedExpenses.map(({ dateKey, expenses: dayExpenses }) => (
            <div key={dateKey}>
              <h3 className="text-sm font-medium text-gray-400 mb-3">
                {formatDateHeader(dateKey)}
              </h3>
              <div className="space-y-3">
                {dayExpenses.map((expense) => {
                  const canSignOff = currentUser
                    ? expense.splits.some((s) => s.memberId === currentUser.id && !s.signedOff)
                    : false;
                  return (
                    <div
                      key={expense.id}
                      id={`expense-${expense.id}`}
                    >
                      <ExpenseCard
                        expense={expense}
                        members={group.members}
                        currency={group.currency}
                        showSignOff={canSignOff}
                        initialExpanded={expense.id === expandId}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
