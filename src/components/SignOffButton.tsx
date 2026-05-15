import { useState } from 'react';
import { Expense } from '../types';
import { useApp } from '../context/AppContext';

interface SignOffButtonProps {
  expense: Expense;
  compact?: boolean;
}

export function SignOffButton({ expense, compact = false }: SignOffButtonProps) {
  const { signOffExpense } = useApp();
  const [loading, setLoading] = useState(false);
  const isSettlement = expense.splitType === 'settlement';

  const handleSignOff = async () => {
    setLoading(true);
    try {
      await signOffExpense(expense);
    } finally {
      setLoading(false);
    }
  };

  const buttonText = isSettlement
    ? loading ? 'Confirming...' : 'Confirm'
    : loading ? 'Accepting...' : 'Accept';

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        handleSignOff();
      }}
      disabled={loading}
      className={`text-white rounded-lg font-medium disabled:opacity-50 ${
        compact ? 'py-1 px-3 text-sm' : 'w-full py-2 px-4'
      } ${
        isSettlement
          ? 'bg-green-600 hover:bg-green-700'
          : 'bg-cyan-600 hover:bg-cyan-700'
      }`}
    >
      {buttonText}
    </button>
  );
}
