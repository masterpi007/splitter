import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ReceiptItems } from '../components/ReceiptItems';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReceiptItem, DiscountType } from '../types';
import { roundNumber, calculateDiscountAmount, calculateBillGoc, distributeByShares, absorbIntoPayerItem, toLocalDatetimeInput, parseDatetimeLocal, parseDecimal } from '../utils/balances';
import { YouBadge } from '../components/YouBadge';
import { ShareControl } from '../components/ShareControl';
import { AmountInput } from '../components/AmountInput';
import { MemberSelect, memberAvatarUrl } from '../components/MemberSelect';

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

  const [splitMode, setSplitMode] = useState<'items' | 'shares' | 'group' | 'settlement'>('items');
  const [settleTo, setSettleTo] = useState('');
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

      if (expense.splitType === 'settlement') {
        setSplitMode('settlement');
        setSettleTo(expense.splits[0]?.memberId ?? '');
      } else if (expense.splitType === 'group') {
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
          // Amount-paid model: Total = subtotal − discount. Recompute from the
          // (pre-discount) items so a legacy expense that stored the pre-discount
          // amount — which made the payer's share balloon — loads as amount-paid
          // and re-saves correctly. No-op for expenses already stored this way.
          if (expense.discount) {
            const subtotal = expense.items.reduce((s, i) => s + i.amount, 0);
            const discAmt = (expense.discountType || 'percentage') === 'flat'
              ? expense.discount
              : subtotal * (expense.discount / 100);
            setTotalAmount(Math.max(0, roundNumber(subtotal - discAmt, 2)));
          }
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
  // re-accept the new amounts — but only when the edit changes what was
  // agreed to (amount, payer, split type). Date/description/tag edits
  // keep everyone's acceptance; per-row amount changes still reset that
  // row via buildSplit.
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
  // Preview rows show the same largest-remainder allocation that gets saved,
  // so the visible amounts always sum exactly to the total.
  const sharePreview = distributeByShares(totalAmount, Object.entries(memberShares) as [string, number][], 2);
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

    // Payer absorbs the rounding remainder so the splits sum exactly to the
    // Total (= amount actually paid). totalAmount is kept at subtotal − discount
    // (see the discount/items handlers and the load effect), so the items above
    // — already discounted proportionally — sum to it and this diff is ~0.
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
    if (newItems.length > 0 && totalAmount > 0) {
      // The stored total is authoritative: non-payer item changes are
      // absorbed by the payer's item so items keep summing to the bill.
      // Editing or removing the payer's own row is an explicit choice —
      // then the total follows the items instead.
      const changed = newItems.find((n) => {
        const o = items.find((i) => i.id === n.id);
        return !o || o.amount !== n.amount;
      });
      const removedPayerItem = items.some(
        (o) => o.memberId === paidBy && !newItems.some((n) => n.id === o.id),
      );
      const payerEdited = removedPayerItem || changed?.memberId === paidBy;
      if (!payerEdited) {
        const target = calculateBillGoc(totalAmount, discount, discountType);
        const balanced = absorbIntoPayerItem(newItems, paidBy, target);
        if (balanced) {
          setItems(balanced);
          return;
        }
      }
    }
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

  // The Total field holds the amount actually paid = subtotal − discount, so
  // expense.amount (= Total) always equals the sum of the discounted splits.
  // handleItemsChange keeps it in sync on item edits; this mirrors that for
  // when the discount value or unit changes (or is cleared).
  const syncTotalToDiscount = (nextDiscount: number | undefined, nextType: DiscountType) => {
    if (items.length === 0) return;
    const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
    const discAmt = nextType === 'flat'
      ? (nextDiscount ?? 0)
      : subtotal * ((nextDiscount ?? 0) / 100);
    setTotalAmount(Math.max(0, roundNumber(subtotal - discAmt, 2)));
  };

  const handleTotalChange = (value: string) => {
    const parsed = parseDecimal(value);
    if (!isNaN(parsed) && parsed >= 0) {
      const newBillGoc = calculateBillGoc(parsed, discount, discountType);
      const currentBillGoc = items.reduce((sum, i) => sum + i.amount, 0);
      const diff = roundNumber(newBillGoc - currentBillGoc, 2);

      if (Math.abs(diff) > 0.001) {
        // Payer item absorbs the change (created if missing) so items keep
        // summing exactly to the bill.
        const balanced = absorbIntoPayerItem(items, paidBy, newBillGoc);
        if (!balanced) {
          setError('Other items already exceed this total');
          return;
        }
        setItems(balanced);
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

    if (!description.trim() && splitMode !== 'settlement') {
      setError('Description is required');
      return;
    }

    if (!paidBy) {
      setError('Select who paid');
      return;
    }

    if (splitMode === 'settlement') {
      if (totalAmount <= 0) { setError('Amount must be greater than 0'); return; }
      if (!settleTo) { setError('Select who receives the money'); return; }
      if (settleTo === paidBy) { setError('Sender and recipient must be different'); return; }
    } else if (splitMode === 'items') {
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
      // What members agreed to is the money and its attribution. Only when
      // one of those moves does an admin edit void the sign-off ledger;
      // otherwise (date, description, tags, receipt) acceptances survive.
      const newSplitType = splitMode === 'items' ? 'exact' : splitMode;
      const materialChange =
        Math.abs(expense.amount - totalAmount) > 0.01 ||
        expense.paidBy !== paidBy ||
        expense.splitType !== newSplitType;
      const wipeAcceptance = adminWipeAcceptance && materialChange;
      if (splitMode === 'settlement') {
        const oldSplit = expense.splits[0];
        // Recipient keeps their confirmation only when nothing that matters
        // changed (same recipient, same amount); otherwise they re-confirm.
        const unchanged =
          oldSplit &&
          oldSplit.memberId === settleTo &&
          Math.abs(oldSplit.amount - totalAmount) < 0.01;
        const fromName = group.members.find((m) => m.id === paidBy)?.name ?? 'Unknown';
        const toName = group.members.find((m) => m.id === settleTo)?.name ?? 'Unknown';
        await updateExpense(expense.id, {
          description: description.trim() || `Settlement: ${fromName} → ${toName}`,
          amount: totalAmount,
          paidBy,
          splitType: 'settlement',
          splits: [{
            memberId: settleTo,
            value: totalAmount,
            amount: totalAmount,
            signedOff: unchanged ? oldSplit.signedOff : settleTo === currentUser?.id,
            signedAt: unchanged ? oldSplit.signedAt : settleTo === currentUser?.id ? now : undefined,
          }],
          receiptDate: receiptDate || undefined,
        });
        navigate('/expenses');
        return;
      }
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
          ...(wipeAcceptance
            ? { signedOffBy: currentUser ? [{ memberId: currentUser.id, signedAt: now }] : [] }
            : {}),
        });
        navigate('/expenses');
        return;
      }
      // Build a single split row honoring the editor's role:
      //   - admin (not payer) making a material change: force re-acceptance
      //     from the payer + every participant; admin auto-signs only their
      //     own row.
      //   - otherwise: payer auto-signs, others reset only when their
      //     amount changed.
      const buildSplit = (
        memberId: string,
        value: number,
        amount: number,
        oldSplit: { amount: number; signedOff: boolean; signedAt?: string; previousAmount?: number } | undefined,
      ) => {
        if (wipeAcceptance) {
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
          // Unassigned items belong to the payer — persist that assignment.
          items: items.map((i) => ({ ...i, memberId: i.memberId ?? paidBy })),
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
          Changing the amount, payer or split will reset acceptance — the payer and every participant will need to accept again. Date and description edits keep acceptances.
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
            {splitMode === 'settlement' ? 'From (sender)' : 'Paid by'}
          </label>
          <MemberSelect
            members={group.members}
            value={paidBy}
            onChange={(id) => {
              if (canOnlyAssign || canOnlyEditOwnItems) return;
              setPaidBy(id);
              if (settleTo === id) setSettleTo('');
            }}
            placeholder="Select who paid"
          />
        </div>

        {/* 3b. Settlement recipient */}
        {splitMode === 'settlement' && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              To (recipient)
            </label>
            <MemberSelect
              members={group.members}
              value={settleTo}
              onChange={(id) => {
                if (canOnlyAssign || canOnlyEditOwnItems) return;
                setSettleTo(id);
              }}
              placeholder="Select who receives the money"
              excludeId={paidBy}
            />
          </div>
        )}

        {/* 4. Split between - member chips */}
        {!canOnlyEditOwnItems && splitMode !== 'group' && splitMode !== 'settlement' && (
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
                    className="flex flex-col items-center gap-1 w-14 cursor-grab active:cursor-grabbing select-none"
                  >
                    <img
                      src={memberAvatarUrl(member)}
                      alt=""
                      className={`w-11 h-11 rounded-full bg-gray-700 transition-all ${
                        isIncluded ? 'ring-2 ring-cyan-500' : 'opacity-40 grayscale'
                      }`}
                    />
                    <span className={`text-xs truncate max-w-full ${isYou ? 'text-amber-400 font-medium' : isIncluded ? 'text-gray-200' : 'text-gray-500'}`}>
                      {isYou ? 'You' : member.name}
                    </span>
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
            <AmountInput
              value={totalAmount || undefined}
              disabled={canOnlyAssign || canOnlyEditOwnItems}
              onCommit={(n) => {
                if (splitMode === 'shares' || splitMode === 'settlement') {
                  setTotalAmount(n !== null && n >= 0 ? n : 0);
                } else if (n !== null) {
                  handleTotalChange(String(n));
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
              <AmountInput
                autoFocus
                value={discount}
                onCommit={(n) => {
                  const raw = n ?? undefined;
                  const next = discountType === 'flat'
                    ? (raw && raw > 0 ? raw : undefined)
                    : (raw && raw > 0 && raw <= 100 ? raw : undefined);
                  setDiscount(next);
                  syncTotalToDiscount(next, discountType);
                }}
                placeholder="0"
                className="flex-1 min-w-0 bg-transparent px-3 py-2 text-right text-sm text-gray-100"
              />
              <select
                value={discountType}
                onChange={(e) => {
                  const nextType = e.target.value as DiscountType;
                  setDiscountType(nextType);
                  syncTotalToDiscount(discount, nextType);
                }}
                className="flex-shrink-0 bg-gray-800 border-l border-gray-700 px-2 py-2 text-gray-100 text-sm"
              >
                <option value="percentage">%</option>
                <option value="flat">K</option>
              </select>
              <button
                type="button"
                onClick={() => { setDiscount(undefined); setShowDiscountInput(false); syncTotalToDiscount(undefined, discountType); }}
                className="px-2 py-2 text-gray-600 hover:text-red-400 text-sm"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {/* 7. Split mode toggle - payer only; settlements keep their type */}
        {isPayer && splitMode !== 'settlement' && (
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
                const memberAmount = sharePreview.get(memberId) ?? 0;

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
                  : splitMode === 'settlement'
                    ? totalAmount <= 0 || !settleTo || settleTo === paidBy
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
