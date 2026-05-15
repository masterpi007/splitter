import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { formatCurrency, formatRelativeTime, getTagColor, isDeleted } from '../utils/balances';
import { SignOffButton } from '../components/SignOffButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { YouBadge } from '../components/YouBadge';

export function ExpenseView() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { group, expenses, currentUser, deleteExpense } = useApp();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);

  const expense = expenses.find((e) => e.id === id);

  if (!group || !expense) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="mb-4">Transaction not found</p>
        <Link to="/expenses" className="text-cyan-400 hover:text-cyan-300 text-sm">
          ← Back to transactions
        </Link>
      </div>
    );
  }

  const currency = group.currency;
  const isSettlement = expense.splitType === 'settlement';
  const isGroupMode = expense.splitType === 'group';
  const expenseDeleted = isDeleted(expense);

  const getMemberName = (memberId: string) =>
    group.members.find((m) => m.id === memberId)?.name ?? memberId;

  const isPayer = !!(currentUser && currentUser.id === expense.paidBy);
  const isCreator = !!(currentUser && currentUser.id === expense.createdBy);
  const isAdmin = !!(currentUser && group.admins.includes(currentUser.id));
  const canEdit = isPayer || isCreator || isAdmin;

  const userSplit = currentUser
    ? expense.splits.find((s) => s.memberId === currentUser.id)
    : null;

  const userSignedOffInGroup = isGroupMode && currentUser
    ? (expense.signedOffBy ?? []).some((e) => e.memberId === currentUser.id)
    : false;

  const showSignOff = !expenseDeleted && (
    isGroupMode
      ? !userSignedOffInGroup
      : !!(userSplit && !userSplit.signedOff && !isPayer)
  );

  const activeMembers = group.members.filter((m) => !m.removedAt);
  const totalShares = activeMembers.reduce((s, m) => s + (m.share ?? 1), 0);

  const splitRows: { memberId: string; amount: number; signed: boolean }[] = isGroupMode
    ? activeMembers.map((m) => {
        const myShare = m.share ?? 1;
        const amount = totalShares > 0
          ? Math.round((expense.amount * myShare / totalShares) * 100) / 100
          : 0;
        const signed = (expense.signedOffBy ?? []).some((e) => e.memberId === m.id);
        return { memberId: m.id, amount, signed };
      })
    : expense.splits.map((s) => ({ memberId: s.memberId, amount: s.amount, signed: s.signedOff }));

  const splitTypeLabel: Record<string, string> = {
    shares: 'Shares',
    items: 'Items',
    group: 'Group',
    settlement: 'Settlement',
  };

  const handleDelete = async () => {
    setShowDeleteConfirm(false);
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteExpense(expense);
      navigate('/expenses');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-gray-200 text-sm flex items-center gap-1"
        >
          ← Back
        </button>
        <h1 className="text-lg font-semibold text-gray-100">Transaction</h1>
        {canEdit && !expenseDeleted ? (
          <Link
            to={`/edit/${expense.id}`}
            className="text-gray-400 hover:text-cyan-400 transition-colors"
            title="Edit transaction"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </Link>
        ) : (
          <div className="w-5" />
        )}
      </div>

      {expenseDeleted && (
        <div className="mb-4 p-3 bg-amber-900/40 border border-amber-700 rounded-lg text-amber-300 text-sm">
          This transaction has been deleted
        </div>
      )}

      {/* Main card */}
      <div className="bg-gray-800 rounded-lg border border-gray-700 p-5 space-y-5">

        {/* Description + badge */}
        <div className="flex items-start justify-between gap-2">
          <p className="text-xl font-semibold text-gray-100 leading-tight">{expense.description}</p>
          <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${
            isSettlement ? 'bg-green-900 text-green-300' :
            isGroupMode ? 'bg-amber-400 text-gray-900' :
            'bg-gray-700 text-gray-300'
          }`}>
            {splitTypeLabel[expense.splitType] ?? expense.splitType}
          </span>
        </div>

        {/* Amount + meta */}
        <div>
          <p className="text-3xl font-bold text-gray-100">{formatCurrency(expense.amount, currency)}</p>
          <p className="text-sm text-gray-400 mt-1">
            Paid by <span className="text-gray-200">{getMemberName(expense.paidBy)}</span>
            {currentUser && expense.paidBy === currentUser.id && <> <YouBadge /></>}
            <span className="mx-2">·</span>
            {formatRelativeTime(expense.receiptDate ?? expense.createdAt)}
          </p>
        </div>

        {/* Splits table */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Splits</p>
          <div className="space-y-1.5">
            {splitRows.map(({ memberId, amount, signed }) => (
              <div key={memberId} className="flex items-center justify-between text-sm">
                <span className="text-gray-300 flex items-center gap-1">
                  {getMemberName(memberId)}
                  {currentUser && memberId === currentUser.id && <YouBadge />}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-200">{formatCurrency(amount, currency)}</span>
                  <span title={signed ? 'Confirmed' : 'Pending'}>
                    {signed ? '✅' : '⏳'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Tags */}
        {expense.tags && expense.tags.filter(t => t !== 'deleted').length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {expense.tags.filter(t => t !== 'deleted').map((tag) => {
              const colors = getTagColor(tag);
              return (
                <span key={tag} className={`text-xs px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
                  {tag}
                </span>
              );
            })}
          </div>
        )}

        {/* Receipt thumbnail */}
        {expense.receiptUrl && (
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Receipt</p>
            <button onClick={() => setShowReceipt(true)} className="block">
              <img
                src={expense.receiptUrl}
                alt="Receipt"
                className="h-20 rounded-lg border border-gray-600 object-cover hover:opacity-80 transition-opacity"
              />
            </button>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="mt-4 space-y-3">
        {showSignOff && <SignOffButton expense={expense} />}

        {canEdit && !expenseDeleted && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={deleting}
            className="w-full py-2 rounded-lg text-sm font-medium text-red-400 border border-red-800 hover:bg-red-900/20 disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete transaction'}
          </button>
        )}
        {deleteError && <p className="text-red-400 text-xs text-center">{deleteError}</p>}
      </div>

      {/* Receipt modal */}
      {showReceipt && expense.receiptUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setShowReceipt(false)}
        >
          <img
            src={expense.receiptUrl}
            alt="Receipt"
            className="max-w-full max-h-full rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete transaction"
        message={`Are you sure you want to delete "${expense.description}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
