import { useState } from 'react';
import { ReceiptItem, Member } from '../types';
import { useApp } from '../context/AppContext';
import { roundNumber, formatCurrency, evaluateAmountExpression, sanitizeAmountExpression } from '../utils/balances';

interface ReceiptItemsProps {
  items: ReceiptItem[];
  members: Member[];
  currency: string;
  discountAmount?: number;
  billGoc?: number;
  onChange: (items: ReceiptItem[]) => void;
  payerId?: string;
  selectedItemId?: string | null;
  onItemSelect?: (itemId: string) => void;
  assignOnly?: boolean;
  editableItemIds?: Set<string>;
}

export function ReceiptItems({ items, members, currency, discountAmount, billGoc, onChange, payerId, selectedItemId, onItemSelect, assignOnly = false, editableItemIds }: ReceiptItemsProps) {
  const { currentUser } = useApp();
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const [dragOverAddButton, setDragOverAddButton] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const handleDragOver = (e: React.DragEvent, itemId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverItemId(itemId);
  };

  const handleDragLeave = () => {
    setDragOverItemId(null);
  };

  const handleDrop = (e: React.DragEvent, itemId: string) => {
    e.preventDefault();
    const memberId = e.dataTransfer.getData('text/plain');
    const item = items.find(i => i.id === itemId);

    // In assignOnly mode, can only assign to unassigned items
    if (assignOnly && item?.memberId) {
      setDragOverItemId(null);
      return;
    }

    if (memberId) {
      onChange(items.map(item =>
        item.id === itemId ? { ...item, memberId } : item
      ));
    }

    setDragOverItemId(null);
  };

  const handleAddButtonDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverAddButton(true);
  };

  const handleAddButtonDragLeave = () => {
    setDragOverAddButton(false);
  };

  const handleAddButtonDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // Cannot add items in assignOnly mode
    if (assignOnly) {
      setDragOverAddButton(false);
      return;
    }

    const memberId = e.dataTransfer.getData('text/plain');

    if (memberId) {
      const newItem: ReceiptItem = {
        id: crypto.randomUUID(),
        description: '',
        amount: 0,
        memberId,
      };
      onChange([...items, newItem]);
    }

    setDragOverAddButton(false);
  };

  const handleRemoveAssignment = (itemId: string) => {
    onChange(items.map(item =>
      item.id === itemId ? { ...item, memberId: undefined } : item
    ));
  };

  const handleAmountFocus = (itemId: string, amount: number) => {
    setEditingId(itemId);
    setEditingValue(amount.toString());
  };

  const handleAmountBlur = (itemId: string) => {
    if (editingId === itemId) {
      // Accepts arithmetic ("12+3*2") as well as plain numbers.
      const newAmount = evaluateAmountExpression(editingValue) ?? 0;
      onChange(items.map(item =>
        item.id === itemId ? { ...item, amount: Math.max(0, newAmount) } : item
      ));
      setEditingId(null);
      setEditingValue('');
    }
  };

  const handleAmountChange = (value: string) => {
    setEditingValue(sanitizeAmountExpression(value));
  };

  const handleDescriptionChange = (itemId: string, description: string) => {
    onChange(items.map(item =>
      item.id === itemId ? { ...item, description } : item
    ));
  };

  const handleRemoveItem = (itemId: string) => {
    onChange(items.filter(item => item.id !== itemId));
  };

  const handleAddItem = () => {
    const newItem: ReceiptItem = {
      id: crypto.randomUUID(),
      description: '',
      amount: 0,
    };
    onChange([...items, newItem]);
  };

  return (
    <div className="space-y-2">
      {/* Items */}
      {items.map(item => {
        const isOver = dragOverItemId === item.id;
        const assignedMember = item.memberId ? members.find(m => m.id === item.memberId) : null;
        const isEditing = editingId === item.id;
        const isSelected = selectedItemId === item.id;

        const showDiscount = (discountAmount ?? 0) > 0 && (billGoc ?? 0) > 0;
        const itemDiscountAmount = showDiscount ? roundNumber(discountAmount! * (item.amount / billGoc!), 2) : 0;
        const itemFinalAmount = showDiscount ? roundNumber(item.amount - itemDiscountAmount, 2) : 0;

        return (
          <div
            key={item.id}
            onDragOver={(e) => handleDragOver(e, item.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, item.id)}
            className={`flex flex-col gap-1 p-2 rounded-lg transition-all ${
              isSelected
                ? 'bg-yellow-900/50 border-2 border-yellow-500'
                : isOver
                ? 'bg-cyan-900/50 border-2 border-cyan-500 border-dashed'
                : 'bg-gray-800'
            }`}
          >
          <div className="flex items-center gap-2">
            {/* Assigned member or empty drop zone (clickable to select) */}
            <div className="w-20 flex-shrink-0">
              {assignedMember ? (
                <button
                  type="button"
                  onClick={() => !assignOnly && handleRemoveAssignment(item.id)}
                  className={`px-2 py-1 text-white text-xs rounded-full truncate max-w-full transition-colors ${
                    item.memberId === payerId ? 'bg-green-600' : 'bg-cyan-600'
                  } ${assignOnly ? 'cursor-default' : 'hover:bg-red-500'}`}
                  title={assignOnly ? undefined : "Click to remove"}
                >
                  {currentUser && assignedMember.id === currentUser.id ? `[${assignedMember.name}]` : assignedMember.name}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onItemSelect?.(item.id)}
                  className={`w-full h-7 rounded-full border-2 border-dashed transition-colors ${
                    isSelected
                      ? 'border-yellow-500 bg-yellow-900/30'
                      : isOver
                      ? 'border-cyan-500'
                      : 'border-gray-600 hover:border-gray-400'
                  }`}
                  title="Click to select, then tap a member"
                />
              )}
            </div>

            {/* Description - editable */}
            <input
              type="text"
              value={item.description}
              onChange={(e) => handleDescriptionChange(item.id, e.target.value)}
              placeholder="Item description"
              disabled={editableItemIds ? !editableItemIds.has(item.id) : assignOnly}
              className="flex-1 min-w-0 bg-transparent border-none text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 rounded px-1 disabled:opacity-50"
            />

            {/* Amount - editable */}
            <div className="flex items-center gap-1">
              <input
                type="text"
                inputMode="text"
                value={isEditing ? editingValue : item.amount.toString()}
                onChange={(e) => handleAmountChange(e.target.value)}
                onFocus={() => handleAmountFocus(item.id, item.amount)}
                onBlur={() => handleAmountBlur(item.id)}
                disabled={assignOnly}
                className="w-16 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-right text-sm text-gray-100 disabled:opacity-50"
              />
              <span className="text-xs text-gray-400">{currency}</span>
            </div>

            {/* Remove button */}
            {!assignOnly && (
              <button
                type="button"
                onClick={() => handleRemoveItem(item.id)}
                className="p-1 text-gray-500 hover:text-red-400"
                title="Remove item"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </div>
          {showDiscount && (
            <p className="text-xs text-orange-400 pl-[5.5rem]">
              -{formatCurrency(itemDiscountAmount, currency)} → Pay {formatCurrency(itemFinalAmount, currency)}
            </p>
          )}
          </div>
        );
      })}


      {/* Add item button - also a drop zone */}
      {!assignOnly && (
        <button
          type="button"
          onClick={handleAddItem}
          onDragOver={handleAddButtonDragOver}
          onDragLeave={handleAddButtonDragLeave}
          onDrop={handleAddButtonDrop}
          className={`w-full py-2 border-2 border-dashed rounded-lg text-sm transition-all ${
            dragOverAddButton
              ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300'
              : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'
          }`}
        >
          + Add item
        </button>
      )}
    </div>
  );
}
