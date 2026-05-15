import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Expense, Member } from '../types';
import { calculateBillGoc, calculateDiscountAmount, formatCurrency, formatRelativeTime, getTagColor, isDeleted, isGroupAccepted } from '../utils/balances';
import { SignOffButton } from './SignOffButton';
import { useApp } from '../context/AppContext';
import { ConfirmDialog } from './ConfirmDialog';
import { YouBadge } from './YouBadge';

interface ExpenseCardProps {
  expense: Expense;
  members: Member[];
  currency: string;
  showSignOff?: boolean;
  onDelete?: () => void;
  initialExpanded?: boolean;
}

export function ExpenseCard({
  expense,
  members,
  currency,
  showSignOff = false,
  onDelete,
  initialExpanded = false,
}: ExpenseCardProps) {
  const { group, currentUser, updateExpense, claimExpenseItem, deleteExpense, tagsByFrequency } = useApp();
  const navigate = useNavigate();

  const openExpenseView = () => {
    navigate(`/tx/${expense.id}`);
  };

  // Tag suggestions: the group-wide frequency-sorted list (memoized in the
  // provider so it's computed once per expenses update, not once per card),
  // minus the tags already on this expense.
  const tagSuggestions = useMemo(() => {
    const existing = new Set(expense.tags ?? []);
    return tagsByFrequency.filter((t) => !existing.has(t));
  }, [tagsByFrequency, expense.tags]);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [showReceipt, setShowReceipt] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const [claimingItemId, setClaimingItemId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = async () => {
    if (onDelete) {
      onDelete();
    } else {
      setShowDeleteConfirm(true);
    }
  };

  const handleConfirmDelete = async () => {
    setShowDeleteConfirm(false);
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteExpense(expense);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  const payer = members.find((m) => m.id === expense.paidBy);
  const creator = members.find((m) => m.id === expense.createdBy);
  const isGroupMode = expense.splitType === 'group';
  // For group-mode the whole expense flips to "Accepted" once > 50% of active
  // members have signed off. For other types, every split must be signed.
  const allSigned = isGroupMode
    ? isGroupAccepted(expense, members)
    : expense.splits.every((s) => s.signedOff);
  const isSettlement = expense.splitType === 'settlement';
  const expenseDeleted = isDeleted(expense);

  // Check if expense has unassigned items (incomplete)
  const hasUnassignedItems = expense.items?.some((item) => !item.memberId) ?? false;

  // Items stats for display
  const unclaimedCount = expense.items?.filter((item) => !item.memberId).length ?? 0;
  const unclaimedAmount = expense.items
    ?.filter((item) => !item.memberId)
    .reduce((sum, item) => sum + item.amount, 0) ?? 0;

  // For settlements, get the recipient (the person in splits)
  const recipient = isSettlement ? members.find((m) => m.id === expense.splits[0]?.memberId) : null;

  const getMemberName = (id: string) => {
    const member = members.find((m) => m.id === id);
    const name = member?.name || 'Unknown';
    if (currentUser && id === currentUser.id) {
      return (
        <>
          {name}
          <YouBadge />
        </>
      );
    }
    return name;
  };

  const userSplit = currentUser
    ? expense.splits.find((s) => s.memberId === currentUser.id)
    : null;

  // Payer can edit/delete, creator can edit (to assign items), participants
  // can edit (to claim/sign their share), and group admins can edit/delete
  // anything in the group — admin edits force re-acceptance from payer +
  // participants (handled in EditExpense).
  const isPayer = currentUser && currentUser.id === expense.paidBy;
  const isCreator = currentUser && currentUser.id === expense.createdBy;
  const isParticipantInSplits = currentUser && expense.splits.some(s => s.memberId === currentUser.id);
  const isParticipantInItems = currentUser && expense.items?.some(item => item.memberId === currentUser.id);
  const isParticipant = isPayer || isCreator || isParticipantInSplits || isParticipantInItems;
  const isAdmin = !!(currentUser && group?.admins.includes(currentUser.id));
  const canDelete = isPayer || isCreator || isAdmin;
  const canEditTags = isParticipant || isAdmin;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={openExpenseView}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openExpenseView();
        }
      }}
      className={`bg-gray-800 rounded-lg shadow-sm border p-4 cursor-pointer transition-all duration-150 ${
        expenseDeleted
          ? 'border-gray-700 hover:shadow-[0_0_0_1px_rgba(55,65,81,0.45),0_10px_30px_rgba(55,65,81,0.12)]'
          : allSigned
          ? 'border-green-700 hover:shadow-[0_0_0_1px_rgba(21,128,61,0.5),0_10px_30px_rgba(21,128,61,0.18)]'
          : 'border-yellow-700 hover:shadow-[0_0_0_1px_rgba(161,98,7,0.45),0_10px_30px_rgba(161,98,7,0.14)]'
      } hover:-translate-y-0.5 ${expenseDeleted ? 'opacity-60' : ''}`}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex-1">
          {isSettlement ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-900 text-green-300">
                  Settlement
                </span>
                {canDelete && !expenseDeleted && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete();
                    }}
                    disabled={deleting}
                    className="text-red-400 text-xs hover:text-red-300 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting...' : 'Delete'}
                  </button>
                )}
              </div>
              <p className="text-sm mt-2">
                <span className="text-gray-100">{getMemberName(payer?.id ?? '')}</span>
                <span className="text-gray-500 mx-2">paid</span>
                <span className="text-gray-100">{getMemberName(recipient?.id ?? '')}</span>
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                {isGroupMode && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-400 text-gray-900">
                    Group
                  </span>
                )}
                <h3 className="font-medium text-gray-100">
                  {expense.description}
                </h3>
              </div>
              <p className="text-sm text-gray-400">
                Paid by <span className="text-gray-200">{getMemberName(payer?.id ?? '')}</span>
                {creator && creator.id !== expense.paidBy && (
                  <span className="text-gray-500"> (added by {getMemberName(creator.id)})</span>
                )}
              </p>
            </>
          )}
          {/* Tags - only show for non-settlements, hide 'deleted' system tag */}
          {!isSettlement && <div className="flex flex-wrap items-center gap-1 mt-1">
            {expense.tags?.filter((t) => t !== 'deleted').map((tag) => {
              const color = getTagColor(tag);
              return canEditTags ? (
                <button
                  key={tag}
                  onClick={async (e) => {
                    e.stopPropagation();
                    const newTags = expense.tags?.filter((t) => t !== tag) || [];
                    await updateExpense(expense.id, { tags: newTags });
                  }}
                  className={`text-xs px-2 py-0.5 rounded-full ${color.bg} ${color.text} hover:bg-red-900 hover:text-red-300`}
                  title="Click to remove"
                >
                  {tag} ×
                </button>
              ) : (
                <span
                  key={tag}
                  className={`text-xs px-2 py-0.5 rounded-full ${color.bg} ${color.text}`}
                >
                  {tag}
                </span>
              );
            })}
            {canEditTags && !editingTags && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingTags(true);
                }}
                className="text-xs text-gray-500 hover:text-gray-300 min-h-[28px] px-1.5 flex items-center"
              >
                + tag
              </button>
            )}
            {editingTags && (
              <>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={async (e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && tagInput.trim()) {
                        setSavingTags(true);
                        const newTags = [...(expense.tags || []), tagInput.trim().toLowerCase()];
                        await updateExpense(expense.id, { tags: [...new Set(newTags)] });
                        setTagInput('');
                        setSavingTags(false);
                      } else if (e.key === 'Escape') {
                        setEditingTags(false);
                        setTagInput('');
                      }
                    }}
                    placeholder="add tag"
                    className="w-20 text-xs bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-gray-100"
                    autoFocus
                    disabled={savingTags}
                  />
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (tagInput.trim()) {
                        setSavingTags(true);
                        const newTags = [...(expense.tags || []), tagInput.trim().toLowerCase()];
                        await updateExpense(expense.id, { tags: [...new Set(newTags)] });
                        setTagInput('');
                        setSavingTags(false);
                      }
                      setEditingTags(false);
                    }}
                    className="text-xs text-green-400"
                    disabled={savingTags}
                  >
                    {savingTags ? '...' : 'OK'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingTags(false);
                      setTagInput('');
                    }}
                    className="text-xs text-gray-500"
                  >
                    ×
                </button>
                </div>
                {/* Existing group tags, frequency-sorted. Tap to add; editor
                    stays open for batch tagging. */}
                {tagSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1 w-full">
                    {tagSuggestions.map((tag) => {
                      const color = getTagColor(tag);
                      return (
                        <button
                          key={tag}
                          onClick={async (e) => {
                            e.stopPropagation();
                            setSavingTags(true);
                            const newTags = [...(expense.tags || []), tag];
                            await updateExpense(expense.id, { tags: [...new Set(newTags)] });
                            setSavingTags(false);
                          }}
                          disabled={savingTags}
                          className={`text-xs px-2 py-0.5 rounded-full ${color.bg} ${color.text} opacity-60 hover:opacity-100 disabled:opacity-40`}
                          title={`Add tag "${tag}"`}
                        >
                          + {tag}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>}
        </div>
        <div className="text-right">
          <p className="font-semibold text-lg">
            {formatCurrency(expense.amount, currency)}
          </p>
          <div className="flex items-center justify-end gap-2 mt-1">
            {expense.receiptUrl && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowReceipt(true);
                }}
                className="text-cyan-400 hover:text-cyan-300"
                title="View receipt"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
            <span
              className={`text-xs px-2 py-0.5 rounded-full ${
                expenseDeleted
                  ? 'bg-red-900 text-red-300'
                  : hasUnassignedItems
                  ? 'bg-orange-900 text-orange-300'
                  : allSigned
                  ? 'bg-green-900 text-green-300'
                  : 'bg-yellow-900 text-yellow-300'
              }`}
            >
              {expenseDeleted ? 'Deleted' : hasUnassignedItems ? 'Incomplete' : allSigned ? 'Accepted' : 'Pending'}
            </span>
          </div>
        </div>
      </div>

      {/* Settlement: simple confirmation status */}
      {isSettlement ? (
        <div className="mt-3 pt-3 border-t border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`w-2 h-2 rounded-full ${
                allSigned ? 'bg-green-500' : 'bg-yellow-500'
              }`}
            />
            {allSigned ? (
              <span className="text-green-400">Confirmed by recipient</span>
            ) : (
              <span className="text-yellow-400">
                Awaiting confirmation from {getMemberName(recipient?.id ?? '')}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-gray-700">
          {/* Collapsed view: show only user's split */}
          {!expanded && userSplit && (
            <div
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
            >
              {(() => {
                // For payer, show only their assigned items amount (exclude unclaimed)
                const isUserPayer = currentUser && currentUser.id === expense.paidBy;
                const userDisplayAmount = isUserPayer && unclaimedAmount > 0
                  ? userSplit.amount - unclaimedAmount
                  : userSplit.amount;

                return (
                  <div className="flex justify-between items-center text-sm">
                    <span className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          userSplit.signedOff ? 'bg-green-500' : 'bg-yellow-500'
                        }`}
                      />
                      Your share
                      {userSplit.signedOff && (
                        <span className="text-xs text-green-400 font-medium">Accepted</span>
                      )}
                      {(expense.splits.length > 1 || unclaimedAmount > 0) && unclaimedAmount > 0 && (
                        <span className="text-xs text-gray-500">· {formatCurrency(unclaimedAmount, currency)} unclaimed</span>
                      )}
                    </span>
                    <span className="flex items-center gap-1 text-gray-400">
                      {formatCurrency(userDisplayAmount, currency)}
                      {(expense.splits.length > 1 || unclaimedAmount > 0) && (
                        <svg className="w-4 h-4 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      )}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Collapsed view: no user split, show summary */}
          {!expanded && !userSplit && (
            <div
              className="cursor-pointer flex justify-between items-center"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
            >
              <p className="text-sm text-gray-400">
                {expense.splits.length} participant{expense.splits.length !== 1 ? 's' : ''}
              </p>
              <svg className="w-4 h-4 text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          )}

          {/* Expanded view: unified participants + items */}
          {expanded && (
            <div>
              <div
                className="flex justify-between items-center mb-2 cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(false);
                }}
              >
                <p className="text-xs text-gray-500">
                  Split ({
                    expense.splitType === 'shares' ? 'by shares' :
                    expense.splitType === 'group' ? 'across whole group' :
                    expense.splitType
                  })
                  {expense.splitType !== 'shares' && expense.splitType !== 'group' && expense.discount && (
                    <span className="ml-1">
                      · −{formatCurrency(calculateDiscountAmount(expense.discount, expense.discountType, calculateBillGoc(expense.amount, expense.discount, expense.discountType)), currency)}
                    </span>
                  )}
                  {expense.splitType === 'group' && (() => {
                    const active = members.filter((m) => !m.removedAt);
                    const activeIds = new Set(active.map((m) => m.id));
                    let signed = 0;
                    for (const entry of expense.signedOffBy ?? []) {
                      if (activeIds.has(entry.memberId)) signed++;
                    }
                    const threshold = Math.floor(active.length / 2) + 1;
                    return (
                      <span className="ml-1">
                        · {signed}/{active.length} signed (accepted at {threshold})
                      </span>
                    );
                  })()}
                </p>
                <svg className="w-4 h-4 text-cyan-500 rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              <div className="space-y-1">
                {expense.splits.map((split) => {
                  const isPayer = split.memberId === expense.paidBy;
                  const memberItems = expense.items?.filter(item => item.memberId === split.memberId) || [];
                  const displayAmount = isPayer && unclaimedAmount > 0
                    ? split.amount - unclaimedAmount
                    : split.amount;
                  const isMe = currentUser && split.memberId === currentUser.id;
                  const hasMultipleItems = memberItems.length > 1;
                  const singleItem = memberItems.length === 1 ? memberItems[0] : null;

                  return (
                    <div key={split.memberId} className={isMe ? 'font-medium' : ''}>
                      {/* Single item: compact inline view */}
                      {singleItem ? (
                        <div className="flex items-center gap-2 text-sm">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${split.signedOff ? 'bg-green-500' : 'bg-yellow-500'}`} />
                          <span className="flex-shrink-0">{getMemberName(split.memberId)}</span>
                          {split.signedOff && <span className="text-xs text-green-400">✓</span>}
                          {singleItem.description && <span className="text-gray-500 truncate">{singleItem.description}</span>}
                          <span className="text-gray-400">({formatCurrency(singleItem.amount, currency)})</span>
                          {isMe && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                setClaimingItemId(singleItem.id);
                                await claimExpenseItem(expense.id, singleItem.id, false);
                                setClaimingItemId(null);
                              }}
                              disabled={claimingItemId === singleItem.id}
                              className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded bg-gray-600 text-gray-300 hover:bg-gray-500 disabled:opacity-50 flex-shrink-0"
                              title="Unclaim item"
                            >
                              {claimingItemId === singleItem.id ? (
                                <span className="text-xs">...</span>
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              )}
                            </button>
                          )}
                        </div>
                      ) : (
                        /* Multiple items or no items: header + nested */
                        <>
                          <div className="flex items-center gap-2 text-sm">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${split.signedOff ? 'bg-green-500' : 'bg-yellow-500'}`} />
                            <span>{getMemberName(split.memberId)}</span>
                            {split.signedOff && <span className="text-xs text-green-400">✓</span>}
                            <span className="text-gray-300">{formatCurrency(displayAmount, currency)}</span>
                          </div>
                          {hasMultipleItems && (
                            <div className="ml-4 space-y-0.5">
                              {memberItems.map((item) => (
                                <div key={item.id} className="flex items-center gap-2 text-xs text-gray-400">
                                  <span className="truncate">{item.description}</span>
                                  <span>({formatCurrency(item.amount, currency)})</span>
                                  {isMe && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        setClaimingItemId(item.id);
                                        await claimExpenseItem(expense.id, item.id, false);
                                        setClaimingItemId(null);
                                      }}
                                      disabled={claimingItemId === item.id}
                                      className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded bg-gray-600 text-gray-300 hover:bg-gray-500 disabled:opacity-50 flex-shrink-0"
                                      title="Unclaim item"
                                    >
                                      {claimingItemId === item.id ? (
                                        <span className="text-xs">...</span>
                                      ) : (
                                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                      )}
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                {/* Unclaimed items */}
                {unclaimedCount > 0 && (
                  <div>
                    {unclaimedCount === 1 ? (
                      /* Single unclaimed: compact */
                      <div className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />
                        <span className="text-orange-400 flex-shrink-0">Unclaimed</span>
                        {expense.items?.find(i => !i.memberId)?.description && <span className="text-gray-500 truncate">{expense.items?.find(i => !i.memberId)?.description}</span>}
                        <span className="text-orange-400">({formatCurrency(unclaimedAmount, currency)})</span>
                        {currentUser && (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              const item = expense.items?.find(i => !i.memberId);
                              if (item) {
                                setClaimingItemId(item.id);
                                await claimExpenseItem(expense.id, item.id, true);
                                setClaimingItemId(null);
                              }
                            }}
                            disabled={!!claimingItemId}
                            className="text-xs px-1.5 py-0.5 rounded bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50 flex-shrink-0"
                          >
                            Claim
                          </button>
                        )}
                      </div>
                    ) : (
                      /* Multiple unclaimed: header + nested */
                      <>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" />
                          <span className="text-orange-400">Unclaimed</span>
                          <span className="text-orange-300">{formatCurrency(unclaimedAmount, currency)}</span>
                        </div>
                        <div className="ml-4 mt-1 space-y-1">
                          {expense.items?.filter(item => !item.memberId).map((item) => {
                            const isClaiming = claimingItemId === item.id;
                            return (
                              <div
                                key={item.id}
                                className="flex items-center gap-2 text-xs text-gray-400"
                              >
                                <span className="truncate">{item.description}</span>
                                <span>({formatCurrency(item.amount, currency)})</span>
                                {currentUser && (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      setClaimingItemId(item.id);
                                      await claimExpenseItem(expense.id, item.id, true);
                                      setClaimingItemId(null);
                                    }}
                                    disabled={isClaiming}
                                    className="text-xs px-1.5 py-0.5 rounded bg-cyan-700 text-cyan-100 hover:bg-cyan-600 disabled:opacity-50"
                                  >
                                    {isClaiming ? '...' : 'Claim'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Collapsed items indicator - only when not expanded and has unclaimed */}
          {!expanded && unclaimedCount > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-700">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(true);
                }}
                className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1"
              >
                {unclaimedCount} unclaimed item{unclaimedCount !== 1 ? 's' : ''}
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      {showSignOff && userSplit && !userSplit.signedOff && !isSettlement && userSplit.previousAmount !== undefined && (
        <div className="mt-3 pt-3 border-t border-gray-700">
          <div className="p-2 bg-orange-900/30 border border-orange-700 rounded-lg text-sm">
            <p className="text-orange-200 font-medium">Amount changed</p>
            <p className="text-orange-400">
              {formatCurrency(userSplit.previousAmount, currency)} → {formatCurrency(userSplit.amount, currency)}
              {userSplit.amount > userSplit.previousAmount && (
                <span className="text-red-400 ml-1">
                  (+{formatCurrency(userSplit.amount - userSplit.previousAmount, currency)})
                </span>
              )}
              {userSplit.amount < userSplit.previousAmount && (
                <span className="text-green-400 ml-1">
                  (-{formatCurrency(userSplit.previousAmount - userSplit.amount, currency)})
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {canDelete && !isSettlement && !expenseDeleted && (
        <div className="mt-3 pt-3 border-t border-gray-700">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDelete();
            }}
            disabled={deleting}
            className="text-red-400 text-sm hover:text-red-300 disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete transaction'}
          </button>
          {deleteError && <p className="text-red-400 text-xs mt-1">{deleteError}</p>}
        </div>
      )}

      <div className="flex justify-between items-center mt-3">
        <p className="text-xs text-gray-500">
          {formatRelativeTime(expense.receiptDate ?? expense.createdAt)}
        </p>
        {showSignOff && userSplit && !userSplit.signedOff && (
          <SignOffButton expense={expense} compact />
        )}
      </div>

      {/* Receipt modal */}
      {showReceipt && expense.receiptUrl && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            setShowReceipt(false);
          }}
        >
          <div className="relative max-w-full max-h-full">
            <img
              src={expense.receiptUrl}
              alt="Receipt"
              className="max-w-full max-h-[80vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowReceipt(false);
              }}
              className="absolute top-2 right-2 bg-gray-900/70 text-gray-300 rounded-full p-2 hover:bg-gray-900"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete transaction"
        message={`Are you sure you want to delete "${expense.description}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
