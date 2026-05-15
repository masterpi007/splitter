import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { ReceiptCapture } from '../components/ReceiptCapture';
import { ReceiptItems } from '../components/ReceiptItems';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReceiptItem, ReceiptOCRResult, DiscountType } from '../types';
import { roundNumber, getTagColor, calculateDiscountAmount, calculateBillGoc, distributeByShares, toLocalDatetimeInput, parseDatetimeLocal, parseDecimal, sanitizeDecimalInput } from '../utils/balances';
import { YouBadge } from '../components/YouBadge';
import { ShareControl } from '../components/ShareControl';

export function AddExpense() {
  const navigate = useNavigate();
  const { group, currentUser, createExpense, expenses } = useApp();

  const [description, setDescription] = useState('');
  const [paidBy, setPaidBy] = useState(currentUser?.id || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptDate, setReceiptDate] = useState<string>(() => new Date().toISOString());
  const [items, setItems] = useState<ReceiptItem[]>([]);
  const [discount, setDiscount] = useState<number | undefined>(undefined);
  const [discountType, setDiscountType] = useState<DiscountType>('percentage');
  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [hasManualTotal, setHasManualTotal] = useState(false);
  const [showDiscountInput, setShowDiscountInput] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [splitMode, setSplitMode] = useState<'items' | 'shares' | 'group'>('shares');
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [memberShares, setMemberShares] = useState<Record<string, number>>({});
  const [pendingModeSwitch, setPendingModeSwitch] = useState<'items' | 'shares' | 'group' | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    if (showSuggestions) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSuggestions]);

  const tagSuggestions = useMemo(() => {
    const freq = new Map<string, number>();
    expenses.forEach(e =>
      e.tags?.filter(t => t !== 'deleted').forEach(t =>
        freq.set(t, (freq.get(t) || 0) + 1)
      )
    );
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }, [expenses]);

  const filteredSuggestions = useMemo(() => {
    if (!tagInput.trim()) return [];
    const input = tagInput.toLowerCase().trim();
    return tagSuggestions.filter(tag => tag.startsWith(input) && !tags.includes(tag));
  }, [tagInput, tagSuggestions, tags]);

  const showCreateOption = tagInput.trim() && filteredSuggestions.length === 0 && !tags.includes(tagInput.trim().toLowerCase());

  const hasItems = items.length > 0;

  const totalShares = Object.values(memberShares).reduce((sum, s) => sum + s, 0);
  // Reference share values for the −/+ smart-jump in shares mode: the unique
  // configured shares across the group's active members, ascending.
  const configuredShareValues = useMemo(() => {
    if (!group) return [1];
    return [...new Set(group.members.map((m) => m.share ?? 1))].sort((a, b) => a - b);
  }, [group]);
  // "All" is derived state: on when every group member is selected.
  const allMembersSelected =
    !!group && group.members.length > 0 && selectedMemberIds.size === group.members.length;
  // "Split" when every included member's share equals their configured group
  // share (or 1 if unset) — i.e. nobody has overridden the admin-set weights.
  // Compare with an epsilon: share values reach here via parseDecimal and may
  // carry float drift (e.g. 0.1 + 0.2), so a strict === would misfire.
  const allAtDefaultRates = Object.entries(memberShares).length > 0 &&
    Object.entries(memberShares).every(([memberId, share]) => {
      const rate = group?.members.find(m => m.id === memberId)?.share ?? 1;
      return Math.abs(share - rate) < 1e-9;
    });

  const billGoc = useMemo(() => {
    if (splitMode !== 'items') return totalAmount;
    if (hasManualTotal) return calculateBillGoc(totalAmount, discount, discountType);
    if (items.length > 0) {
      return roundNumber(items.reduce((sum, item) => sum + item.amount, 0), 2);
    }
    return calculateBillGoc(totalAmount, discount, discountType);
  }, [items, totalAmount, discount, discountType, splitMode, hasManualTotal]);

  const discountAmount = useMemo(() => {
    if (splitMode !== 'items') return 0;
    // Always compute discount from the pre-discount subtotal (billGoc)
    return calculateDiscountAmount(discount, discountType, billGoc);
  }, [billGoc, discount, discountType, splitMode]);

  const includedMemberIds = selectedMemberIds;

  const handleItemsChange = (newItems: ReceiptItem[]) => {
    setItems(newItems);
    if (newItems.length === 0) {
      setDiscount(undefined);
      setHasManualTotal(false);
    } else if (!hasManualTotal) {
      const newBillGoc = newItems.reduce((sum, i) => sum + i.amount, 0);
      const newDiscountAmount = discountType === 'flat'
        ? (discount ?? 0)
        : newBillGoc * ((discount ?? 0) / 100);
      setTotalAmount(Math.max(0, roundNumber(newBillGoc - newDiscountAmount, 2)));
    }
  };

  const handleTotalChange = (value: string) => {
    setHasManualTotal(true);
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
        }
      }
      setTotalAmount(parsed);
    } else if (value === '' || value === '0') {
      setTotalAmount(0);
    }
  };

  const executeModeSwitch = (mode: 'items' | 'shares' | 'group') => {
    if (mode === 'shares') {
      setItems([]);
      setDiscount(undefined);
      setDiscountType('percentage');
      setHasManualTotal(false);
      setShowDiscountInput(false);
      const shares: Record<string, number> = {};
      selectedMemberIds.forEach(id => {
        const rate = group?.members.find(m => m.id === id)?.share ?? 1;
        shares[id] = memberShares[id] ?? rate;
      });
      setMemberShares(shares);
    } else if (mode === 'group') {
      // Group mode: no per-member config — the whole group is always the
      // participant, resolved at read time. Clear anything mode-specific.
      setItems([]);
      setDiscount(undefined);
      setDiscountType('percentage');
      setHasManualTotal(false);
      setShowDiscountInput(false);
      setMemberShares({});
    } else {
      // Keep memberShares in memory while in items mode — the user may toggle
      // back and expect their manually-edited shares to still be there. The
      // shares UI only renders entries for the currently selected members, so
      // stale entries for deselected members are harmless.
      const placeholders: ReceiptItem[] = Array.from(selectedMemberIds).map(memberId => ({
        id: crypto.randomUUID(),
        description: '',
        amount: 0,
        memberId,
      }));
      setItems(placeholders);
    }
    setSplitMode(mode);
    setPendingModeSwitch(null);
  };

  const handleSplitModeChange = (mode: 'items' | 'shares' | 'group') => {
    if (mode === splitMode) return;
    const needsConfirm =
      mode === 'shares' ? hasItems :
      mode === 'group' ? (hasItems || Object.keys(memberShares).length > 0) :
      Object.keys(memberShares).length > 0;
    if (needsConfirm) {
      setPendingModeSwitch(mode);
    } else {
      executeModeSwitch(mode);
    }
  };

  const handleReceiptProcessed = (result: ReceiptOCRResult) => {
    setSplitMode('items');
    setItems(result.extracted.items);
    const ocrMemberIds = new Set(result.extracted.items.filter(i => i.memberId).map(i => i.memberId!));
    if (ocrMemberIds.size > 0) setSelectedMemberIds(ocrMemberIds);
    setHasManualTotal(true);

    if (result.extracted.discount && result.extracted.discount > 0) {
      setDiscount(result.extracted.discount);
      setDiscountType('percentage');
      const ocrBillGoc = result.extracted.items.reduce((sum, i) => sum + i.amount, 0);
      const ocrDiscountAmount = ocrBillGoc * (result.extracted.discount / 100);
      setTotalAmount(Math.max(0, roundNumber(ocrBillGoc - ocrDiscountAmount, 2)));
    } else {
      setDiscount(undefined);
      const ocrTotal = result.extracted.items.reduce((sum, i) => sum + i.amount, 0);
      setTotalAmount(ocrTotal);
    }

    if (result.extracted.merchant) {
      setDescription(result.extracted.merchant);
    }
    if (result.extracted.date) {
      setReceiptDate(result.extracted.date);
    }
  };

  const handleReceiptError = (errorMessage: string) => {
    setError(errorMessage);
  };

  const handleClearReceipt = () => {
    setItems([]);
    setDiscount(undefined);
    setDiscountType('percentage');
    setHasManualTotal(false);
    setReceiptDate(new Date().toISOString());
    setDescription('');
    setTotalAmount(0);
  };

  // Bulk select/deselect every member. In shares mode, also populates/clears
  // the per-member share map (using each member's configured share as the
  // default). In items mode, deselecting-all unassigns every item.
  const handleToggleAll = () => {
    if (!group) return;
    const allSelected =
      group.members.length > 0 &&
      selectedMemberIds.size === group.members.length;

    if (allSelected) {
      setSelectedMemberIds(new Set());
      if (splitMode === 'shares') {
        setMemberShares({});
      } else {
        handleItemsChange(items.map(item => ({ ...item, memberId: undefined })));
      }
    } else {
      const allIds = new Set(group.members.map(m => m.id));
      setSelectedMemberIds(allIds);
      if (splitMode === 'shares') {
        // Preserve already-edited share values; fill missing ones with the
        // member's configured default.
        setMemberShares(prev => {
          const next = { ...prev };
          group.members.forEach(m => {
            if (!(m.id in next)) next[m.id] = m.share ?? 1;
          });
          return next;
        });
      }
      // Items mode: selection only — user still assigns items by drag or tap.
    }
  };

  const handleMemberTap = (memberId: string) => {
    const isIncluded = selectedMemberIds.has(memberId);

    if (splitMode === 'shares') {
      // Toggle both selectedMemberIds and memberShares together
      setSelectedMemberIds(prev => {
        const next = new Set(prev);
        if (isIncluded) next.delete(memberId); else next.add(memberId);
        return next;
      });
      setMemberShares(prev => {
        const next = { ...prev };
        if (isIncluded) {
          delete next[memberId];
        } else {
          const rate = group?.members.find(m => m.id === memberId)?.share ?? 1;
          next[memberId] = rate;
        }
        return next;
      });
      return;
    }

    // Items mode: assign to item if a slot is selected
    if (selectedItemId) {
      handleItemsChange(items.map(item =>
        item.id === selectedItemId ? { ...item, memberId } : item
      ));
      // Ensure member is in selectedMemberIds when assigning
      if (!isIncluded) {
        setSelectedMemberIds(prev => new Set(prev).add(memberId));
      }
      setSelectedItemId(null);
      return;
    }

    // Toggle: remove member from all items, or add to selectedMemberIds
    setSelectedMemberIds(prev => {
      const next = new Set(prev);
      if (isIncluded) next.delete(memberId); else next.add(memberId);
      return next;
    });
    if (isIncluded) {
      handleItemsChange(items.map(item =>
        item.memberId === memberId ? { ...item, memberId: undefined } : item
      ));
    }
  };

  const handleItemSelect = (itemId: string) => {
    setSelectedItemId(selectedItemId === itemId ? null : itemId);
  };

  const handleMemberDragStart = (e: React.DragEvent, memberId: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', memberId);
  };

  if (!group) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!description.trim()) { setError('Description is required'); return; }
    if (!paidBy) { setError('Select who paid'); return; }
    if (!currentUser) { setError('Select your name first'); return; }

    if (splitMode === 'items') {
      if (totalAmount <= 0) { setError('Total amount must be greater than 0'); return; }
      if (items.length === 0) { setError('Add at least one item'); return; }
      if (discountType === 'flat' && discount) {
        const bg = items.reduce((sum, i) => sum + i.amount, 0);
        if (discount >= bg) {
          setError('Flat discount must be less than items subtotal');
          return;
        }
      }
    } else if (splitMode === 'group') {
      if (totalAmount <= 0) { setError('Total amount must be greater than 0'); return; }
      if (group.members.length === 0) { setError('Group has no members'); return; }
    } else {
      if (totalAmount <= 0) { setError('Total amount must be greater than 0'); return; }
      if (selectedMemberIds.size === 0) { setError('Add at least one member'); return; }
    }

    setSubmitting(true);

    try {
      if (splitMode === 'items') {
        const splitBillGoc = items.reduce((sum, i) => sum + i.amount, 0);
        const splitDiscountAmount = discountType === 'flat'
          ? (discount ?? 0)
          : splitBillGoc * ((discount ?? 0) / 100);

        const memberTotals = new Map<string, number>();
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

        const splits = Array.from(memberTotals.entries()).map(([memberId, amount]) => ({
          memberId,
          value: amount,
          amount,
          signedOff: memberId === paidBy || memberId === currentUser.id,
          signedAt: (memberId === paidBy || memberId === currentUser.id) ? new Date().toISOString() : undefined,
        }));

        await createExpense({
          description: description.trim(), amount: totalAmount, paidBy,
          createdBy: currentUser.id, splitType: 'exact', splits,
          items, discount,
          discountType: discount ? discountType : undefined,
          tags: tags.length > 0 ? tags : undefined, receiptDate,
        });
      } else if (splitMode === 'group') {
        // Group mode: persist an empty splits[] — the breakdown is derived
        // from the current members + share weights every time the expense
        // is read, so past entries re-weight when the group changes.
        // The payer and creator auto-sign-off (they're obviously aware of
        // the transaction); remaining members accept via the normal flow,
        // and the expense is "accepted" once > 50% have signed.
        const now = new Date().toISOString();
        const signedOffBy = [{ memberId: paidBy, signedAt: now }];
        if (currentUser.id !== paidBy) {
          signedOffBy.push({ memberId: currentUser.id, signedAt: now });
        }
        await createExpense({
          description: description.trim(), amount: totalAmount, paidBy,
          createdBy: currentUser.id, splitType: 'group', splits: [],
          signedOffBy,
          tags: tags.length > 0 ? tags : undefined, receiptDate,
        });
      } else {
        const sharesEntries = Object.entries(memberShares) as [string, number][];
        const distributed = distributeByShares(totalAmount, sharesEntries, 2);
        const splits = sharesEntries.map(([memberId, share]) => {
          const amount = distributed.get(memberId) ?? 0;
          const isAutoSignOff = memberId === paidBy || memberId === currentUser.id;
          return {
            memberId, value: share, amount,
            signedOff: isAutoSignOff,
            signedAt: isAutoSignOff ? new Date().toISOString() : undefined,
          };
        });
        await createExpense({
          description: description.trim(), amount: totalAmount, paidBy,
          createdBy: currentUser.id, splitType: 'shares', splits,
          tags: tags.length > 0 ? tags : undefined, receiptDate,
        });
      }
      navigate('/expenses');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create expense');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Add Transaction</h2>

      <form onSubmit={handleSubmit} className="space-y-6">
        {splitMode === 'items' && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Scan Receipt (optional)
            </label>
            <ReceiptCapture
              onProcessed={handleReceiptProcessed}
              onError={handleReceiptError}
              disabled={hasItems}
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was this transaction for?"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Payment date
          </label>
          <input
            type="datetime-local"
            value={receiptDate ? toLocalDatetimeInput(receiptDate) : ''}
            onChange={(e) => setReceiptDate(e.target.value ? parseDatetimeLocal(e.target.value) : new Date().toISOString())}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Tags (optional)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {tags.map((tag) => {
              const color = getTagColor(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  className={`text-xs px-2 py-1 rounded-full ${color.bg} ${color.text} hover:bg-red-900 hover:text-red-300`}
                >
                  {tag} ×
                </button>
              );
            })}
            <div ref={dropdownRef} className="relative flex items-center gap-1">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => {
                  const value = e.target.value;
                  setTagInput(value);
                  setShowSuggestions(value.trim().length >= 1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (tagInput.trim() && !tags.includes(tagInput.trim().toLowerCase())) {
                      setTags([...tags, tagInput.trim().toLowerCase()]);
                      setTagInput('');
                      setShowSuggestions(false);
                    }
                  } else if (e.key === 'Escape') {
                    setShowSuggestions(false);
                  }
                }}
                placeholder="add tag"
                className="w-24 text-sm bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-100"
              />
              <button
                type="button"
                onClick={() => {
                  if (tagInput.trim() && !tags.includes(tagInput.trim().toLowerCase())) {
                    setTags([...tags, tagInput.trim().toLowerCase()]);
                    setTagInput('');
                    setShowSuggestions(false);
                  }
                }}
                className="text-sm text-cyan-400 hover:text-cyan-300"
              >
                +
              </button>

              {showSuggestions && (filteredSuggestions.length > 0 || showCreateOption) && (
                <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 min-w-[200px] max-h-[200px] overflow-y-auto">
                  {filteredSuggestions.map((tag) => {
                    const color = getTagColor(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setTags([...tags, tag]);
                          setTagInput('');
                          setShowSuggestions(false);
                        }}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-gray-700 flex items-center gap-2"
                      >
                        <span className={`px-2 py-0.5 rounded-full text-xs ${color.bg} ${color.text}`}>
                          {tag}
                        </span>
                      </button>
                    );
                  })}
                  {showCreateOption && (
                    <div className="px-3 py-2 text-sm text-gray-500 italic">
                      Press Enter to add "{tagInput.trim()}"
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Available tags in the group, in descending frequency order.
              Tap to add. Already-selected tags are hidden (they render in the
              row above with their × remove button). */}
          {tagSuggestions.filter((t) => !tags.includes(t)).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tagSuggestions
                .filter((t) => !tags.includes(t))
                .map((tag) => {
                  const color = getTagColor(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setTags([...tags, tag])}
                      className={`text-xs px-2 py-0.5 rounded-full ${color.bg} ${color.text} opacity-60 hover:opacity-100`}
                      title={`Add tag "${tag}"`}
                    >
                      + {tag}
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            Paid by
          </label>
          <select
            value={paidBy}
            onChange={(e) => setPaidBy(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-100"
          >
            <option value="">Select who paid</option>
            {group.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>

        {splitMode !== 'group' && (
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-300">
                Split between
              </label>
              {hasItems && (
                <button
                  type="button"
                  onClick={handleClearReceipt}
                  className="text-sm text-red-400 hover:text-red-300"
                >
                  Clear all
                </button>
              )}
            </div>

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
                    draggable
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
                ? 'Drag to items or "+ Add item" below'
                : 'Tap to add/remove from expense'}
            </p>
          </div>
        )}

        {/* Total + Discount (same row) */}
        <div>
          <div className="flex items-center bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
            <span className="px-3 py-2 text-sm text-gray-500 border-r border-gray-700 whitespace-nowrap">Total</span>
            <input
              type="text" inputMode="decimal"
              value={totalAmount || ''}
              onChange={(e) => {
                const sanitized = sanitizeDecimalInput(e.target.value);
                if (splitMode === 'shares') {
                  setHasManualTotal(true);
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
              className="flex-1 min-w-0 bg-transparent px-3 py-2 text-right text-lg font-semibold text-gray-100"
            />
            <span className="px-2 py-2 text-sm text-gray-500">K</span>
          </div>
          <div className="flex justify-between items-center mt-1">
            <p className="text-xs text-gray-500">
              {discount
                ? `Amount paid · Original: ${billGoc.toLocaleString()}${group.currency}`
                : 'Amount paid'}
            </p>
            {splitMode === 'items' && totalAmount > 0 && !showDiscountInput && !discount && (
              <button
                type="button"
                onClick={() => setShowDiscountInput(true)}
                className="text-xs text-cyan-500 hover:text-cyan-400"
              >
                + Add discount
              </button>
            )}
          </div>
          {splitMode === 'items' && totalAmount > 0 && (showDiscountInput || discount) && (
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

        {/* Split mode toggle */}
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => handleSplitModeChange('items')}
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
            onClick={() => handleSplitModeChange('shares')}
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
            onClick={() => handleSplitModeChange('group')}
            className={`flex-1 text-center py-1.5 text-sm rounded-md transition-colors ${
              splitMode === 'group'
                ? 'bg-cyan-600 text-white font-semibold'
                : 'text-gray-500'
            }`}
          >
            Group
          </button>
        </div>

        {/* Split details */}
        {splitMode === 'group' ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-sm text-gray-300">
            <p className="font-medium text-gray-100 mb-1">
              Split across the whole group ({group.members.length} member{group.members.length === 1 ? '' : 's'})
            </p>
            <p className="text-xs text-gray-500">
              Uses each member's configured share weight. Adding/removing members
              or changing share weights retroactively re-weights this and every
              other group transaction.
            </p>
          </div>
        ) : splitMode === 'items' ? (
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="block text-sm font-medium text-gray-300">Amounts</label>
              {includedMemberIds.size > 0 && (
                <button type="button" onClick={() => {
                  if (items.length === 0) return;
                  const rawTotal = items.reduce((sum, i) => sum + i.amount, 0);
                  const splitAmount = roundNumber(rawTotal / items.length, 2);
                  handleItemsChange(items.map(item => ({ ...item, amount: splitAmount })));
                }} className="text-sm text-cyan-400 hover:text-cyan-300">Split</button>
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
            />
            {hasManualTotal && items.length > 0 && (() => {
              const itemsSum = roundNumber(items.reduce((sum, i) => sum + i.amount, 0), 2);
              const diff = roundNumber(itemsSum - billGoc, 2);
              if (Math.abs(diff) < 0.01) return null;
              return (
                <p className="text-xs text-yellow-400 mt-1">
                  Items: {itemsSum.toLocaleString()}{group.currency} · Expected: {billGoc.toLocaleString()}{group.currency} (diff {diff > 0 ? '+' : ''}{diff}{group.currency})
                </p>
              );
            })()}
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
                      <ShareControl
                        value={share}
                        configuredValues={configuredShareValues}
                        onChange={(v) => setMemberShares(prev => ({ ...prev, [memberId]: v }))}
                      />
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

        <button
          type="submit"
          disabled={
            submitting ||
            (splitMode === 'items'
              ? items.length === 0
              : splitMode === 'group'
                ? totalAmount <= 0 || group.members.length === 0
                : Object.keys(memberShares).length === 0 || totalAmount <= 0)
          }
          className="w-full bg-cyan-600 text-white py-3 rounded-lg font-medium hover:bg-cyan-700 disabled:opacity-50"
        >
          {submitting ? 'Adding...' : 'Add Transaction'}
        </button>
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
        onConfirm={() => pendingModeSwitch && executeModeSwitch(pendingModeSwitch)}
        onCancel={() => setPendingModeSwitch(null)}
      />
    </div>
  );
}
