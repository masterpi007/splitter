import { useEffect, useState } from 'react';
import { evaluateAmountExpression, sanitizeAmountExpression, formatNumber, roundNumber } from '../utils/balances';

interface AmountInputProps {
  /** Committed numeric value; 0/undefined renders as an empty field. */
  value: number | undefined;
  /**
   * Fires with the evaluated number on every valid keystroke, or null when
   * the field is cleared. Invalid/incomplete input (e.g. a half-typed
   * equation like "12+") fires nothing — the parent keeps its last value.
   */
  onCommit: (value: number | null) => void;
  className?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

// Money input that accepts plain numbers ("10.5", "10,5") and arithmetic
// ("25+13*2", "(45-5)/4"). Keeps the raw text as its own state so decimal
// separators and equations survive typing (a number-controlled input would
// re-render "10," back to "10"); collapses to the evaluated number on
// blur/Enter. While an equation is being typed, shows a live "= result" hint.
export function AmountInput({
  value,
  onCommit,
  className = '',
  placeholder = '0',
  autoFocus,
  disabled,
}: AmountInputProps) {
  const [text, setText] = useState(value ? String(value) : '');
  const [focused, setFocused] = useState(false);

  // Adopt external value when not editing (e.g. item edits recompute totals).
  useEffect(() => {
    if (!focused) setText(value ? String(value) : '');
  }, [value, focused]);

  const evaluated = evaluateAmountExpression(text);
  const isEquation = /(?!^)-|[+*/()]/.test(text);

  const handleChange = (raw: string) => {
    const s = sanitizeAmountExpression(raw);
    setText(s);
    if (s.trim() === '') {
      onCommit(null);
      return;
    }
    const n = evaluateAmountExpression(s);
    // Money is stored at 2-decimal precision everywhere; commit the same,
    // so an expression like 100/3 can't smuggle in endless decimals.
    if (n !== null && n >= 0) onCommit(roundNumber(n, 2));
  };

  const collapse = () => {
    setFocused(false);
    const n = evaluateAmountExpression(text);
    if (n !== null && n >= 0) setText(n ? String(roundNumber(n, 2)) : '');
  };

  return (
    <>
      <input
        type="text"
        inputMode="text"
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={collapse}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        className={className}
      />
      {focused && isEquation && evaluated !== null && (
        <span className="shrink-0 text-xs text-cyan-400 pr-1 self-center whitespace-nowrap">
          = {formatNumber(evaluated)}
        </span>
      )}
    </>
  );
}
