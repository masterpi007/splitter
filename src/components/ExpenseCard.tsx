import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Expense, Member } from '../types';
import { calculateBillGoc, calculateDiscountAmount, formatCurrency, formatRelativeTime, getTagColor, isDeleted, isGroupAccepted } from '../utils/balances';
import { SignOffButton } from './SignOffButton';
import { useApp } from '../context/AppContext';
import { ConfirmDialog } from './ConfirmDialog';


interface ExpenseCardProps {
  expense: Expense;
  members: Member[];
  currency: string;
  showSignOff?: boolean;
  onDelete?: () => void;
  initialExpanded?: boolean;
  /** One-time swipe-discovery nudge: briefly peeks the action column. */
  swipeHint?: boolean;
  /** Flash a bright ring for ~1s (used when arriving from a deep link). */
  highlight?: boolean;
}

export function ExpenseCard({
  expense,
  members,
  currency,
  showSignOff = false,
  onDelete,
  initialExpanded = false,
  swipeHint = false,
  highlight = false,
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
    if (currentUser && id === currentUser.id) {
      return <span className="text-amber-400 font-medium">You</span>;
    }
    return members.find((m) => m.id === id)?.name || 'Unknown';
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

  // Swipe-left reveals Edit/Delete under the card (touch devices). Desktop
  // reaches the same actions through the transaction detail page.
  const canSwipeEdit = !expenseDeleted && (isParticipant || isAdmin);
  const canSwipeDelete = !!canDelete && !expenseDeleted;
  // Actions stack vertically in a single 64px-wide column.
  const actionWidth = canSwipeEdit || canSwipeDelete ? 64 : 0;
  const [swipeX, setSwipeX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const startOffset = useRef(0);
  const swipedRef = useRef(false);

  // Pointer events cover both touch and mouse drags. touch-action: pan-y on
  // the card keeps vertical scrolling native while horizontal drags reach us.
  const onPointerDown = (e: React.PointerEvent) => {
    if (actionWidth === 0) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    touchStart.current = { x: e.clientX, y: e.clientY };
    startOffset.current = swipeX;
    swipedRef.current = false;
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!touchStart.current) return;
    const dx = e.clientX - touchStart.current.x;
    const dy = e.clientY - touchStart.current.y;
    if (!swipedRef.current && Math.abs(dy) > Math.abs(dx)) return; // vertical scroll wins
    if (Math.abs(dx) > 8 && !swipedRef.current) {
      swipedRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setSwipeX(Math.min(0, Math.max(-actionWidth, startOffset.current + dx)));
  };
  const onPointerEnd = () => {
    if (!touchStart.current) return;
    touchStart.current = null;
    setDragging(false);
    setSwipeX((x) => (x < -actionWidth / 2 ? -actionWidth : 0));
  };

  // One-time discovery nudge: peek the actions open and snap back so users
  // learn the swipe exists. Runs once per browser (localStorage flag).
  useEffect(() => {
    if (!swipeHint || actionWidth === 0) return;
    if (localStorage.getItem('splitter.swipeHintShown')) return;
    localStorage.setItem('splitter.swipeHintShown', '1');
    const open = setTimeout(() => setSwipeX(-actionWidth), 700);
    const close = setTimeout(() => setSwipeX(0), 1900);
    return () => {
      clearTimeout(open);
      clearTimeout(close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipeHint, actionWidth]);

  // Border color of the card's current state, reused by the deep-link flash
  // so the glow matches the border instead of always being cyan.
  const [stateColor, stateGlow] = expenseDeleted
    ? ['#4b5563', 'rgba(75,85,99,0.55)']
    : !allSigned
    ? ['#eab308', 'rgba(234,179,8,0.5)']
    : isSettlement
    ? ['#22d3ee', 'rgba(34,211,238,0.5)']
    : ['#9ca3af', 'rgba(156,163,175,0.45)'];

  // Deep-link arrival flash: bright ring for ~1s, then back to normal. The
  // 700ms transition on the card class does the fade-out.
  const [highlighted, setHighlighted] = useState(highlight);
  useEffect(() => {
    if (!highlight) return;
    setHighlighted(true);
    const t = setTimeout(() => setHighlighted(false), 1000);
    return () => clearTimeout(t);
  }, [highlight]);

  const handleCardClick = () => {
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    if (swipeX !== 0) {
      setSwipeX(0);
      return;
    }
    openExpenseView();
  };

  return (
    <div className="relative overflow-hidden rounded-lg">
      {/* Action layer — only exists while the card is being dragged or held
          open, and stacks Edit above Delete as icon buttons. */}
      {actionWidth > 0 && (dragging || swipeX < 0) && (
        <div className="absolute inset-y-0 right-0 flex flex-col w-16">
          {canSwipeEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/edit/${expense.id}`);
              }}
              title="Edit"
              className="flex-1 flex items-center justify-center bg-cyan-700 text-white"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
              </svg>
            </button>
          )}
          {canSwipeDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setSwipeX(0);
                handleDelete();
              }}
              disabled={deleting}
              title="Delete"
              className="flex-1 flex items-center justify-center bg-red-600 text-white disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      )}
    <div
      role="link"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openExpenseView();
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // Only set a transform while swiping — a permanent transform would turn
      // this div into the containing block for the fixed-position modals.
      style={{
        touchAction: 'pan-y',
        // Inline so it beats the Tailwind shadow classes deterministically:
        // the deep-link flash glows in the card's own state color.
        ...(highlighted
          ? {
              borderColor: stateColor,
              boxShadow: `0 0 0 2px ${stateColor}, 0 0 26px 4px ${stateGlow}`,
            }
          : {}),
        ...(swipeX !== 0 || dragging
          ? { transform: `translateX(${swipeX}px)`, transition: dragging ? 'none' : 'transform 200ms ease' }
          : {}),
      }}
      className={`${dragging ? 'select-none ' : ''}relative rounded-lg shadow-sm border p-4 cursor-pointer transition-all ${highlighted ? 'duration-150' : 'duration-700'} ${
        // Pending (yellow) outranks the type colors — an unaccepted
        // settlement is still pending first, cyan second. Hover brightens the
        // border, lifts the background a step, and spreads a glow; no
        // translate, which would clip against the swipe container's overflow.
        expenseDeleted
          ? 'bg-gray-800 border-gray-800 hover:border-gray-600 hover:bg-gray-700/60 hover:shadow-[0_0_18px_rgba(55,65,81,0.4)]'
          : !allSigned
          ? 'bg-gray-800 border-yellow-800 hover:border-yellow-500 hover:bg-gray-700/60 hover:shadow-[0_0_18px_rgba(202,138,4,0.4)]'
          : isSettlement
          ? 'bg-gray-800 border-cyan-800 hover:border-cyan-400 hover:bg-gray-700/60 hover:shadow-[0_0_18px_rgba(8,145,178,0.45)]'
          : 'bg-gray-800 border-gray-700 hover:border-gray-400 hover:bg-gray-700/60 hover:shadow-[0_0_18px_rgba(156,163,175,0.35)]'
      } ${expenseDeleted ? 'opacity-60' : ''}`}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex-1">
          {isSettlement ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-900 text-green-300">
                  Settlement
                </span>
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

      {deleteError && <p className="text-red-400 text-xs mt-2">{deleteError}</p>}

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
        message={`Permanently delete "${expense.description}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
    </div>
  );
}
