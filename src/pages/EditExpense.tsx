import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ReceiptItems } from '../components/ReceiptItems';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReceiptItem, DiscountType } from '../types';
import { roundNumber, calculateDiscountAmount, calculateBillGoc, distributeByShares, toLocalDatetimeInput, parseDatetimeLocal, parseDecimal, sanitizeDecimalInput } from '../utils/balances';
import { YouBadge } from '../components/YouBadge';
import { ShareControl } from '../components/ShareControl';

export function EditExpense() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { group, expenses, currentUser, updateExpense } = useApp();

  const expense = expenses.find((e) => e.id === id);

  const [description, setDescription] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [discount, setDiscount] = useState<number | undefined>(undefined);
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [showDiscountInput, setShowDiscountInput] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [receiptDate, setReceiptDate] = useState<string>('');
  const [pendingModeSwitch, setPendingModeSwitch] = useState<'items' | 'shares' | 'group' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [splitMode, setSplitMode] = useState<'items' | 'shares' | 'group'>('items');
  const [memberShares, setMemberShares] = useState<Record<string, number>>({});

  // Initialize form with existing expense data
  useEffect(() => {
    if (expense && group) {
      setDescription(expense.description);
      setPaidBy(expense.paidBy);
      setDiscount(expense.discount);
      setDiscountType(expense.discountType || 'percentage');
      setTotalAmount(expense.amount);
      setReceiptDate(expense.receiptDate ?? expense.createdAt);
      if (expense.discount) setShowDiscountInput(true);

      if (expense.splitType === 'group') {
        setSplitMode('group');
      } else if (expense.splitType === 'shares') {
        setSplitMode('shares');
        const shares: Record<string, number> = {};
        for (const split of expense.splits) {
          shares[split.memberId] = split.value;
        }
        setMemberShares(shares);
      } else {
        setSplitMode('items');
        if (expense.items && expense.items.length > 0) {
          setItems(expense.items);
        } else {
          const convertedItems: ReceiptItem[] = expense.splits.map((split) => ({
            id: crypto.randomUUID(),
            description: '',
            amount: split.amount,
            memberId: split.memberId,
          }));
          setItems(convertedItems);
        }
      }
    }
  }, [expense, group]);

  // Payer can fully edit, creator can only assign unassigned items,
  // participant can edit own items, group admin can edit anything but
  // their structural change re-opens acceptance for the payer + all
  // other participants (the admin auto-accepts only their own row).
  const isPayer = !!(currentUser && expense && currentUser.id === expense.paidBy);
  const isCreator = !!(currentUser && expense && currentUser.id === expense.createdBy);
  const isParticipant = !!(currentUser && expense && (
    expense.items?.some(item => item.memberId === currentUser.id) ||
    expense.splits?.some(s => s.memberId === currentUser.id)
  ));
  const isAdmin = !!(currentUser && group?.admins.includes(currentUser.id));
  const canEdit = isPayer || isCreator || isParticipant || isAdmin;
  // Admin overrides the narrow creator/participant restrictions —
  // an admin who is neither payer nor creator nor participant can
  // still edit the whole transaction.
  const canOnlyAssign = !isAdmin && isCreator && !isPayer;
  const canOnlyEditOwnItems = !isAdmin && isParticipant && !isPayer && !isCreator;
  // Admin (acting in admin capacity, i.e. not also the payer) edits
  // void the existing sign-off ledger so the payer + participants must
  // re-accept the new amounts.
  const adminWipeAcceptance = isAdmin && !isPayer;

  const billGoc = useMemo(() => {
    if (splitMode !== 'items') return totalAmount;
    if (items.length > 0) {
      return roundNumber(items.reduce((sum, item) => sum + item.amount, 0), 2);
    }
    return calculateBillGoc(totalAmount, discount, discountType);
  }, [items, totalAmount, discount, discountType, splitMode]);

  const discountAmount = useMemo(() => {
    if (splitMode !== 'items') return 0;
    return calculateDiscountAmount(discount, discountType, billGoc);
  }, [billGoc, discount, discountType, splitMode]);

  const totalShares = Object.values(memberShares).reduce((sum, s) => sum + s, 0);
  // Reference values for the −/+ smart-jump: unique configured shares on the
  // group's members, ascending.
  const configuredShareValues = useMemo(() => {
    if (!group) return [1];
    return [...new Set(group.members.map((m) => m.share ?? 1))].sort((a, b) => a - b);
  }, [group]);
  // "Split" when every member's share equals their configured group share
  // (or 1 if unset). Epsilon compare — share values come from parseDecimal
  // and may carry float drift (e.g. 0.1 + 0.2), so === would misfire.
  const allAtDefaultRates = Object.entries(memberShares).length > 0 &&
    Object.entries(memberShares).every(([memberId, share]) => {
      const rate = group?.members.find(m => m.id === memberId)?.share ?? 1;
      return Math.abs(share - rate) < 1e-9;
    });

  const includedMemberIds = splitMode === 'items'
    ? new Set(items.filter(i => i.memberId).map(i => i.memberId!))
    : new Set(Object.keys(memberShares));

  const calculateSplits = () => {
    const memberTotals = new Map<string, number>();
    const splitBillGoc = items.reduce((sum, i) => sum + i.amount, 0);
    const splitDiscountAmount = discountType === 'flat'
      ? (discount ?? 0)
      : splitBillGoc * ((discount ?? 0) / 100);

    for (const item of items) {
      if (item.memberId && item.amount > 0) {
        const itemDiscount = splitBillGoc > 0
          ? roundNumber(splitDiscountAmount * item.amount / splitBillGoc, 2)
          : 0;
        const effectiveAmount = roundNumber(item.amount - itemDiscount, 2);
        const current = memberTotals.get(item.memberId) || 0;
        memberTotals.set(item.memberId, roundNumber(current + effectiveAmount, 2));
      }
    }

    if (paidBy && totalAmount > 0) {
      const currentItemsSum = Array.from(memberTotals.values()).reduce((sum, v) => sum + v, 0);
      const diff = roundNumber(totalAmount - currentItemsSum, 2);
      if (Math.abs(diff) > 0.001) {
        const payerCurrent = memberTotals.get(paidBy) || 0;
        memberTotals.set(paidBy, roundNumber(payerCurrent + diff, 2));
      }
    }

    return memberTotals;
  };

  const handleItemsChange = (newItems: ReceiptItem[]) => {
    const newBillGoc = newItems.reduce((sum, i) => sum + i.amount, 0);
    const newDiscountAmount = discountType === 'flat'
      ? (discount ?? 0)
      : newBillGoc * ((discount ?? 0) / 100);
    const newTotal = roundNumber(newBillGoc - newDiscountAmount, 2);
    setItems(newItems);
    setTotalAmount(Math.max(0, newTotal));
    if (newItems.length === 0) {
      setDiscount(undefined);
    }
  };

  const handleTotalChange = (value: string) => {
    const parsed = parseDecimal(value);
    if (!isNaN(parsed) && parsed >= 0) {
      const newBillGoc = calculateBillGoc(parsed, discount, discountType);
      const currentBillGoc = items.reduce((sum, i) => sum + i.amount, 0);
      const diff = roundNumber(newBillGoc - currentBillGoc, 2);

      if (Math.abs(diff) > 0.001) {
        const payerItems = items.filter(i => i.memberId === paidBy);
        if (payerItems.length > 0) {
          const firstPayerItem = payerItems[0];
          const newItemAmount = roundNumber(firstPayerItem.amount + diff, 2);
          if (newItemAmount < 0) {
            setError('Adjustment would make item amount negative');
            return;
          }
          setItems(items.map(item =>
            item.id === firstPayerItem.id ? { ...item, amount: newItemAmount } : item
          ));
        } else if (items.length === 0 || paidBy) {
          const newItem: ReceiptItem = {
            id: crypto.randomUUID(),
            description: '',
            amount: newBillGoc,
            memberId: paidBy || undefined,
          };
          setItems(newItem.amount > 0 ? [...items, newItem] : items);
        }
      }
      setTotalAmount(parsed);
    } else if (value === '' || value === '0') {
      setTotalAmount(0);
    }
  };

  const allMembersSelected =
    !!group && group.members.length > 0 && includedMemberIds.size === group.members.length;

  // Bulk select/deselect every member. Mirrors the per-member-tap rules:
  // shares mode requires isPayer; items mode respects canOnlyAssign
  // (assign-only callers cannot clear existing assignments or create new items).
  const handleToggleAll = () => {
    if (!group) return;
    if (allMembersSelected) {
      if (splitMode === 'shares') {
        if (!isPayer) return;
        setMemberShares({});
      } else {
        if (canOnlyAssign) return;
        handleItemsChange(items.map(item => ({ ...item, memberId: undefined })));
      }
    } else {
      if (splitMode === 'shares') {
        if (!isPayer) return;
        setMemberShares(prev => {
          const next = { ...prev };
          group.members.forEach(m => {
            if (!(m.id in next)) next[m.id] = m.share ?? 1;
          });
          return next;
        });
      } else {
        // Items mode: assign any free slots first, then fall back to creating
        // new zero-amount items (matching handleMemberTap's single-member path).
        const newItems = [...items];
        const freeSlots = newItems
          .map((item, idx) => ({ item, idx }))
          .filter(x => !x.item.memberId);
        const missing = group.members.filter(m => !includedMemberIds.has(m.id));
        for (const m of missing) {
          const slot = freeSlots.shift();
          if (slot) {
            newItems[slot.idx] = { ...newItems[slot.idx], memberId: m.id };
          } else if (!canOnlyAssign) {
            newItems.push({
              id: crypto.randomUUID(),
              description: '',
              amount: 0,
              memberId: m.id,
            });
          }
        }
        handleItemsChange(newItems);
      }
    }
  };

  const handleMemberTap = (memberId: string) => {
    if (splitMode === 'shares') {
      if (!isPayer) return;
      setMemberShares(prev => {
        const newShares = { ...prev };
        if (memberId in newShares) {
          delete newShares[memberId];
        } else {
          const rate = group?.members.find(m => m.id === memberId)?.share ?? 1;
          newShares[memberId] = rate;
        }
        return newShares;
      });
      return;
    }

    if (selectedItemId) {
      const selectedItem = items.find(i => i.id === selectedItemId);
      if (canOnlyAssign && selectedItem?.memberId) {
        setSelectedItemId(null);
        return;
      }
      handleItemsChange(items.map(item =>
        item.id === selectedItemId ? { ...item, memberId } : item
      ));
      setSelectedItemId(null);
      return;
    }

    const isIncluded = includedMemberIds.has(memberId);
    if (isIncluded) {
      if (canOnlyAssign) return;
      handleItemsChange(items.map(item =>
        item.memberId === memberId ? { ...item, memberId: undefined } : item
      ));
    } else {
      const unassignedItem = items.find(item => !item.memberId);
      if (unassignedItem) {
        handleItemsChange(items.map(item =>
          item.id === unassignedItem.id ? { ...item, memberId } : item
        ));
      } else {
        if (canOnlyAssign) return;
        const newItem: ReceiptItem = {
          id: crypto.randomUUID(),
          description: '',
          amount: 0,
          memberId,
        };
        handleItemsChange([...items, newItem]);
      }
    }
  };

  const handleItemSelect = (itemId: string) => {
    setSelectedItemId(selectedItemId === itemId ? null : itemId);
  };

  const handleMemberDragStart = (e: React.DragEvent, memberId: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', memberId);
  };

  if (!group || !expense) {
    return (
      <div className="text-center py-8 text-gray-400">
        Transaction not found
      </div>
    );
  }

  if (!canEdit) {
    return (
      <div className="text-center py-8 text-gray-400">
        You don't have permission to edit this transaction
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!description.trim()) {
      setError('Description is required');
      return;
    }

    if (!paidBy) {
      setError('Select who paid');
      return;
    }

    if (splitMode === 'items') {
      if (totalAmount <= 0) {
        setError('Total amount must be greater than 0');
        return;
      }
      if (items.length === 0) {
        setError('Add at least one item');
        return;
      }
      if (discountType === 'flat' && discount) {
        const bg = items.reduce((sum, i) => sum + i.amount, 0);
        if (discount >= bg) {
          setError('Flat discount must be less than items subtotal');
          return;
        }
      }
    } else if (splitMode === 'group') {
      if (totalAmount <= 0) {
        setError('Total amount must be greater than 0');
        return;
      }
    } else {
      if (totalAmount <= 0) {
        setError('Total amount must be greater than 0');
        return;
      }
      if (Object.keys(memberShares).length === 0) {
        setError('Add at least one member');
        return;
      }
    }

    setSubmitting(true);

    try {
      const now = new Date().toISOString();
      if (splitMode === 'group') {
        // Group-mode persists no splits (computed on read). Member acceptance
        // lives in `signedOffBy`. By default an edit doesn't touch the ledger
        // — but an admin (acting in admin capacity) editing the transaction
        // resets it so participants re-accept; the admin auto-signs only
        // their own entry.
        await updateExpense(expense.id, {
          description: description.trim(),
          amount: totalAmount,
          paidBy,
          splitType: 'group',
          splits: [],
          receiptDate: receiptDate || undefined,
          ...(adminWipeAcceptance
            ? { signedOffBy: currentUser ? [{ memberId: currentUser.id, signedAt: now }] : [] }
            : {}),
        });
        navigate('/expenses');
        return;
      }
      // Build a single split row honoring the editor's role:
      //   - admin (not payer): force re-acceptance from the payer + every
      //     participant; admin auto-signs only their own row.
      //   - payer/creator: payer auto-signs, others reset only when their
      //     amount changed.
      const buildSplit = (
        memberId: string,
        value: number,
        amount: number,
        oldSplit: { amount: number; signedOff: boolean; signedAt?: string; previousAmount?: number } | undefined,
      ) => {
        if (adminWipeAcceptance) {
          const isSelf = memberId === currentUser?.id;
          const amountChanged = !!oldSplit && Math.abs(oldSplit.amount - amount) > 0.01;
          return {
            memberId,
            value,
            amount,
            signedOff: isSelf,
            signedAt: isSelf ? now : undefined,
            previousAmount: amountChanged ? oldSplit.amount : undefined,
          };
        }
        if (memberId === paidBy) {
          return { memberId, value, amount, signedOff: true, signedAt: now };
        }
        if (!oldSplit || Math.abs(oldSplit.amount - amount) > 0.01) {
          return {
            memberId,
            value,
            amount,
            signedOff: false,
            signedAt: undefined,
            previousAmount: oldSplit?.amount,
          };
        }
        return {
          memberId,
          value,
          amount,
          signedOff: oldSplit.signedOff,
          signedAt: oldSplit.signedAt,
          previousAmount: oldSplit.previousAmount,
        };
      };

      if (splitMode === 'items') {
        const memberTotals = calculateSplits();
        const oldSplitsMap = new Map(expense.splits.map((s) => [s.memberId, s]));

        const splits = Array.from(memberTotals.entries()).map(([memberId, amount]) =>
          buildSplit(memberId, amount, amount, oldSplitsMap.get(memberId)),
        );

        await updateExpense(expense.id, {
          description: description.trim(),
          amount: totalAmount,
          paidBy,
          splitType: 'exact',
          splits,
          items,
          discount,
          discountType: discount ? discountType : undefined,
          receiptDate: receiptDate || undefined,
        });
      } else {
        const oldSplitsMap = new Map(expense.splits.map((s) => [s.memberId, s]));

        const sharesEntries = Object.entries(memberShares) as [string, number][];
        const distributed = distributeByShares(totalAmount, sharesEntries, 2);
        const splits = sharesEntries.map(([memberId, share]) => {
          const amount = distributed.get(memberId) ?? 0;
          return buildSplit(memberId, share, amount, oldSplitsMap.get(memberId));
        });

        await updateExpense(expense.id, {
          description: description.trim(),
          amount: totalAmount,
          paidBy,
          splitType: 'shares',
          splits,
          receiptDate: receiptDate || undefined,
        });
      }

      navigate('/expenses');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update expense');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">
        Edit Transaction{' '}
        {isPayer
          ? '(as Payer)'
          : isCreator
            ? '(as Creator)'
            : isAdmin
              ? '(as Admin)'
              : '(as Participant)'}
      </h2>

      {canOnlyEditOwnItems ? (
        <div className="bg-blue-900/30 border border-blue-700 text-blue-200 px-4 py-3 rounded-lg mb-6 text-sm">
          You can edit the description of your own items.
        </div>
      ) : canOnlyAssign ? (
        <div className="bg-blue-900/30 border border-blue-700 text-blue-200 px-4 py-3 rounded-lg mb-6 text-sm">
          You can edit description and assign members to unassigned items.
        </div>
      ) : adminWipeAcceptance ? (
        <div className="bg-yellow-900/30 border border-yellow-700 text-yellow-200 px-4 py-3 rounded-lg mb-6 text-sm">
          Saving will reset acceptance — the payer and every participant will need to accept the new amounts.
        </div>
      ) : (
        <div className="bg-yellow-900/30 border border-yellow-700 text-yellow-200 px-4 py-3 rounded-lg mb-6 text-sm">
          Changing amounts will require affected members to accept again.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 1. Description */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was this transaction for?"
            disabled={canOnlyAssign || canOnlyEditOwnItems}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 disabled:opacity-50"
          />
        </div>

        {/* 2. Payment date */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Payment date
          </label>
          <input
            type="datetime-local"
            value={receiptDate ? toLocalDatetimeInput(receiptDate) : ''}
            onChange={(e) => setReceiptDate(e.target.value ? parseDatetimeLocal(e.target.value) : expense?.createdAt ?? '')}
            disabled={canOnlyAssign || canOnlyEditOwnItems}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 disabled:opacity-50"
          />
        </div>

        {/* 3. Paid by */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Paid by
          </label>
          <select
            value={paidBy}
            onChange={(e) => setPaidBy(e.target.value)}
            disabled={canOnlyAssign || canOnlyEditOwnItems}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100 disabled:opacity-50"
          >
            <option value="">Select who paid</option>
            {group.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        {/* 4. Split between - member chips */}
        {!canOnlyEditOwnItems && splitMode !== 'group' && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Split between
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleToggleAll}
                className={`px-3 py-1.5 rounded-full text-sm select-none transition-colors ${
                  allMembersSelected
                    ? 'bg-cyan-700 text-white hover:bg-red-500 font-semibold'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                All
              </button>
              {group.members.map((member) => {
                const isIncluded = includedMemberIds.has(member.id);
                const isYou = currentUser && member.id === currentUser.id;
                return (
                  <div
                    key={member.id}
                    draggable={splitMode === 'items'}
                    onClick={() => handleMemberTap(member.id)}
                    onDragStart={(e) => handleMemberDragStart(e, member.id)}
                    className={`px-3 py-1.5 rounded-full text-sm cursor-grab active:cursor-grabbing select-none transition-colors ${
                      isIncluded
                        ? 'bg-cyan-600 text-white hover:bg-red-500'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {member.name}{isYou && <> <YouBadge /></>}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {splitMode === 'items'
                ? 'Tap item then tap member, or drag member to item'
                : 'Tap to add/remove from expense'}
            </p>
          </div>
        )}

        {/* 5. Total + Discount (same row) */}
        <div>
          <div className="flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
            <span className="px-3 py-2 text-sm text-gray-500 border-r border-gray-700 whitespace-nowrap">Total</span>
            <input
              type="text" inputMode="decimal"
              value={totalAmount || ''}
              disabled={canOnlyAssign || canOnlyEditOwnItems}
              onChange={(e) => {
                const sanitized = sanitizeDecimalInput(e.target.value);
                if (splitMode === 'shares') {
                  const parsed = parseDecimal(sanitized);
                  if (!isNaN(parsed) && parsed >= 0) {
                    setTotalAmount(parsed);
                  } else if (sanitized === '' || sanitized === '0') {
                    setTotalAmount(0);
                  }
                } else {
                  handleTotalChange(sanitized);
                }
              }}
              placeholder="0"
              className="flex-1 min-w-0 bg-transparent px-3 py-2 text-right text-lg font-semibold text-gray-100 disabled:opacity-50"
            />
            <span className="px-2 py-2 text-sm text-gray-500">K</span>
          </div>
          <div className="flex justify-between items-center mt-1">
            <p className="text-xs text-gray-500">
              {discount
                ? `Amount paid · Original: ${billGoc.toLocaleString()}${group.currency}`
                : 'Amount paid'}
            </p>
            {splitMode === 'items' && totalAmount > 0 && !canOnlyAssign && !canOnlyEditOwnItems && !showDiscountInput && !discount && (
              <button
                type="button"
                onClick={() => setShowDiscountInput(true)}
                className="text-xs text-cyan-500 hover:text-cyan-400"
              >
                + Add discount
              </button>
            )}
          </div>
          {splitMode === 'items' && totalAmount > 0 && !canOnlyAssign && !canOnlyEditOwnItems && (showDiscountInput || discount) && (
            <div className="flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden mt-2">
              <span className="px-3 py-2 text-sm text-gray-500 border-r border-gray-700 whitespace-nowrap">Discount</span>
              <input
                type="text" inputMode="decimal"
                autoFocus
                value={discount || ''}
                onChange={(e) => {
                  const sanitized = sanitizeDecimalInput(e.target.value);
                  const raw = sanitized ? parseDecimal(sanitized) : undefined;
                  if (discountType === 'flat') {
                    setDiscount(raw && raw > 0 ? raw : undefined);
                  } else {
                    setDiscount(raw && raw > 0 && raw <= 100 ? raw : undefined);
                  }
                }}
                placeholder="0"
                className="flex-1 bg-transparent px-3 py-2 text-right text-sm text-gray-100"
              />
              <select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as DiscountType)}
                className="bg-gray-800 border-l border-gray-700 px-2 py-2 text-gray-100 text-sm"
              >
                <option value="percentage">%</option>
                <option value="flat">K</option>
              </select>
              <button
                type="button"
                onClick={() => { setDiscount(undefined); setShowDiscountInput(false); }}
                className="px-2 py-2 text-gray-600 hover:text-red-400 text-sm"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {/* 7. Split mode toggle - payer only */}
        {isPayer && (
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => {
                if (splitMode === 'items') return;
                if (splitMode === 'shares' && Object.keys(memberShares).length > 0) {
                  setPendingModeSwitch('items');
                  return;
                }
                setMemberShares({});
                setDiscount(undefined);
                setDiscountType('percentage');
                setSplitMode('items');
              }}
              className={`flex-1 text-center py-1.5 text-sm rounded-md transition-colors ${
                splitMode === 'items'
                  ? 'bg-cyan-600 text-white font-semibold'
                  : 'text-gray-500'
              }`}
            >
              Items
            </button>
            <button
              type="button"
              onClick={() => {
                if (splitMode === 'shares') return;
                if (splitMode === 'items' && items.length > 0) {
                  setPendingModeSwitch('shares');
                  return;
                }
                setItems([]);
                setDiscount(undefined);
                setDiscountType('percentage');
                setSplitMode('shares');
              }}
              className={`flex-1 text-center py-1.5 text-sm rounded-md transition-colors ${
                splitMode === 'shares'
                  ? 'bg-cyan-600 text-white font-semibold'
                  : 'text-gray-500'
              }`}
            >
              Shares
            </button>
            <button
              type="button"
              onClick={() => {
                if (splitMode === 'group') return;
                if (splitMode === 'items' && items.length > 0) {
                  setPendingModeSwitch('group');
                  return;
                }
                if (splitMode === 'shares' && Object.keys(memberShares).length > 0) {
                  setPendingModeSwitch('group');
                  return;
                }
                setItems([]);
                setMemberShares({});
                setDiscount(undefined);
                setDiscountType('percentage');
                setSplitMode('group');
              }}
              className={`flex-1 text-center py-1.5 text-sm rounded-md transition-colors ${
                splitMode === 'group'
                  ? 'bg-cyan-600 text-white font-semibold'
                  : 'text-gray-500'
              }`}
            >
              Group
            </button>
          </div>
        )}

        {/* 8. Split details */}
        {splitMode === 'group' ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300">
            <p className="font-medium text-gray-100 mb-1">
              Split across the whole group ({group.members.length} member{group.members.length === 1 ? '' : 's'})
            </p>
            <p className="text-xs text-gray-500">
              Shares are recalculated from current members and their share
              weights. Accepted once more than 50% of members sign off.
            </p>
          </div>
        ) : splitMode === 'items' ? (
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-300">Amounts</label>
              {!canOnlyAssign && !canOnlyEditOwnItems && includedMemberIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (items.length === 0) return;
                    const rawTotal = items.reduce((sum, i) => sum + i.amount, 0);
                    const splitAmount = roundNumber(rawTotal / items.length, 2);
                    handleItemsChange(items.map(item => ({ ...item, amount: splitAmount })));
                  }}
                  className="text-sm text-cyan-400 hover:text-cyan-300"
                >
                  Split
                </button>
              )}
            </div>
            <ReceiptItems
              items={items}
              members={group.members}
              currency={group.currency}
              discountAmount={discountAmount}
              billGoc={billGoc}
              onChange={handleItemsChange}
              payerId={paidBy}
              selectedItemId={selectedItemId}
              onItemSelect={handleItemSelect}
              assignOnly={canOnlyAssign || canOnlyEditOwnItems}
              editableItemIds={canOnlyEditOwnItems ? new Set(items.filter(i => i.memberId === currentUser?.id).map(i => i.id)) : undefined}
            />
          </div>
        ) : (
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-300">Shares</label>
              <span className="text-sm text-gray-500 italic">
                {allAtDefaultRates ? 'Split' : `Total: ${totalShares} shares`}
              </span>
            </div>

            <div className="space-y-1">
              {Object.entries(memberShares).map(([memberId, share]) => {
                const member = group.members.find(m => m.id === memberId);
                if (!member) return null;
                const isYou = currentUser && memberId === currentUser.id;
                const percentage = totalShares > 0 ? roundNumber((share / totalShares) * 100) : 0;
                const memberAmount = totalShares > 0 ? roundNumber(totalAmount * share / totalShares, 2) : 0;

                return (
                  <div key={memberId} className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                    <div>
                      <span className="text-sm text-gray-100">
                        {member.name}{isYou && <> <YouBadge /></>}
                      </span>
                      <span className="text-xs text-gray-500 ml-2">{share}/{totalShares} · {percentage}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-green-400 font-medium">{memberAmount.toLocaleString()}{group.currency}</span>
                      {isPayer ? (
                        <ShareControl
                          value={share}
                          configuredValues={configuredShareValues}
                          onChange={(v) => setMemberShares(prev => ({ ...prev, [memberId]: v }))}
                        />
                      ) : (
                        <span className="text-lg font-bold text-white min-w-[22px] text-center">{share}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {totalAmount > 0 && (
              <div className="mt-3 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <div className="flex justify-between text-sm font-semibold">
                  <span className="text-gray-300">Total to split</span>
                  <span className="text-white">{totalAmount.toLocaleString()}{group.currency}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="bg-red-900/30 border border-red-700 text-red-300 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {/* 9. Submit */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex-1 bg-gray-700 text-gray-300 py-3 rounded-lg font-medium hover:bg-gray-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={
              submitting ||
              (splitMode === 'items'
                ? items.length === 0
                : splitMode === 'group'
                  ? totalAmount <= 0
                  : Object.keys(memberShares).length === 0 || totalAmount <= 0)
            }
            className="flex-1 bg-cyan-600 text-white py-3 rounded-lg font-medium hover:bg-cyan-700 disabled:opacity-50"
          >
            {submitting ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={pendingModeSwitch !== null}
        title={
          pendingModeSwitch === 'shares' ? 'Switch to Shares' :
          pendingModeSwitch === 'group' ? 'Switch to Group' :
          'Switch to Items'
        }
        message={
          pendingModeSwitch === 'group'
            ? 'Your current split configuration will be cleared. This cannot be undone.'
            : pendingModeSwitch === 'shares'
              ? 'Your items will be cleared. This cannot be undone.'
              : 'Your shares will be cleared. This cannot be undone.'
        }
        confirmLabel="Clear & Switch"
        destructive
        onConfirm={() => {
          if (pendingModeSwitch === 'group') {
            setItems([]);
            setMemberShares({});
            setDiscount(undefined);
            setDiscountType('percentage');
            setSplitMode('group');
          } else if (pendingModeSwitch === 'items') {
            const placeholders: ReceiptItem[] = Object.keys(memberShares).map(memberId => ({
              id: crypto.randomUUID(),
              description: '',
              amount: 0,
              memberId,
            }));
            setMemberShares({});
            setDiscount(undefined);
            setDiscountType('percentage');
            setItems(placeholders);
            setSplitMode('items');
          } else if (pendingModeSwitch === 'shares') {
            setItems([]);
            setDiscount(undefined);
            setDiscountType('percentage');
            setSplitMode('shares');
          }
          setPendingModeSwitch(null);
        }}
        onCancel={() => setPendingModeSwitch(null)}
      />
    </div>
  );
}
