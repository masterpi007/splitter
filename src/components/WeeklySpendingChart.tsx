import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Expense } from '../types';
import { formatCurrency, formatNumber, calculateWeeklySpending, calculateDailySpending, calculateMonthlySpending, getTagStroke } from '../utils/balances';

interface Props {
  expenses: Expense[];
  currentUserId: string | null;
  currency: string;
  hasUser: boolean;
}

type ViewMode = 'group' | 'user';
type Period = 'day' | 'week' | 'month';

const PERIOD_WIDTH: Record<Period, number> = { day: 40, week: 56, month: 64 };
const CHART_HEIGHT = 170;
const PAD_TOP = 28;
const PAD_BOTTOM = 28;
const PAD_X = 12;

function formatLabel(periodStart: string, period: Period): string {
  const [y, m, d] = periodStart.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (period === 'month') {
    return date.toLocaleDateString('en-US', { month: 'short' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPeriodLabel(periodStart: string, period: Period): string {
  const [y, m, d] = periodStart.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (period === 'day') return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (period === 'month') return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function WeeklySpendingChart({ expenses, currentUserId, currency, hasUser }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('group');
  const [period, setPeriod] = useState<Period>('week');
  const [selected, setSelected] = useState<number>(-1);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Tags available for filtering, most-used first ('deleted' is a system tag).
  const availableTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const e of expenses) {
      for (const t of e.tags ?? []) {
        if (t !== 'deleted') freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [expenses]);

  useEffect(() => {
    if (!tagMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setTagMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tagMenuOpen]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  // No selection = all expenses; otherwise an expense matches on ANY selected tag.
  const filteredExpenses = useMemo(() => {
    if (selectedTags.size === 0) return expenses;
    return expenses.filter((e) => e.tags?.some((t) => selectedTags.has(t)));
  }, [expenses, selectedTags]);

  const data = useMemo(() => {
    if (period === 'day') return calculateDailySpending(filteredExpenses, currentUserId);
    if (period === 'month') return calculateMonthlySpending(filteredExpenses, currentUserId);
    return calculateWeeklySpending(filteredExpenses, currentUserId);
  }, [filteredExpenses, currentUserId, period]);

  // Reset selection to last bucket when data changes.
  useEffect(() => {
    setSelected(data.length - 1);
  }, [data.length, period]);

  // Scroll newest bucket into view on period change.
  useLayoutEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = viewportRef.current.scrollWidth;
    }
  }, [viewMode, data.length, period]);

  // Re-run when data becomes available (first render may have been the empty fallback,
  // so viewportRef.current was null and deps=[] would never re-fire).
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
  }, [data.length]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [data.length]);

  // Only bail out entirely when the group truly has no spending — with a tag
  // filter active we must keep rendering the chips so it can be cleared.
  if (data.length === 0 && selectedTags.size === 0) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
        <p className="text-gray-400">No spending yet</p>
      </div>
    );
  }

  const effectiveMode: ViewMode = hasUser ? viewMode : 'group';
  const pick = (d: { groupTotal: number; userShare: number }) =>
    effectiveMode === 'group' ? d.groupTotal : d.userShare;

  // No tags selected: one cyan total line with the area fill. With tags
  // selected the total is replaced by one line per tag, coloured to match its
  // chip, so the tags can be compared against each other rather than summed.
  const series: { key: string; label: string; color: string; values: number[] }[] =
    selectedTags.size === 0
      ? [{ key: '__total', label: 'Total', color: '#06b6d4', values: data.map(pick) }]
      : [...selectedTags].map((tag) => {
          const calc =
            period === 'day'
              ? calculateDailySpending
              : period === 'month'
                ? calculateMonthlySpending
                : calculateWeeklySpending;
          const forTag = calc(
            expenses.filter((e) => e.tags?.includes(tag)),
            currentUserId,
          );
          // Align onto the shared bucket list; a tag with no spending in a
          // bucket contributes a zero rather than shifting the line.
          const byKey = new Map(forTag.map((d) => [d.weekStart, d]));
          return {
            key: tag,
            label: tag,
            color: getTagStroke(tag),
            values: data.map((d) => {
              const hit = byKey.get(d.weekStart);
              return hit ? pick(hit) : 0;
            }),
          };
        });

  const maxValue = Math.max(...series.flatMap((s) => s.values), 1);

  const barWidth = PERIOD_WIDTH[period];
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const usableContainerWidth = Math.max(containerWidth - PAD_X * 2, 0);
  const naturalInnerWidth = data.length * barWidth;
  const shouldStretch = data.length > 0 && usableContainerWidth > naturalInnerWidth;
  const effectiveBarWidth = shouldStretch ? usableContainerWidth / data.length : barWidth;
  const innerWidth = shouldStretch ? usableContainerWidth : naturalInnerWidth;
  const width = innerWidth + PAD_X * 2;

  const xAt = (i: number) => PAD_X + i * effectiveBarWidth + effectiveBarWidth / 2;
  const yAt = (v: number) => PAD_TOP + innerHeight * (1 - v / maxValue);

  const plotted = series.map((s) => ({
    ...s,
    points: s.values.map((v, i) => ({ x: xAt(i), y: yAt(v), value: v })),
  }));
  const pathOf = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  const isTotalMode = selectedTags.size === 0;
  const totalPoints = plotted[0]?.points ?? [];
  const areaPath =
    isTotalMode && totalPoints.length > 0
      ? `${pathOf(totalPoints)} L${totalPoints[totalPoints.length - 1].x},${PAD_TOP + innerHeight} L${totalPoints[0].x},${PAD_TOP + innerHeight} Z`
      : '';

  const selIdx = selected >= 0 && selected < data.length ? selected : data.length - 1;
  const selectedBucket = data.length > 0 ? data[selIdx] : null;
  const selectedValue = selectedBucket
    ? (effectiveMode === 'group' ? selectedBucket.groupTotal : selectedBucket.userShare)
    : 0;

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="inline-flex rounded-md overflow-hidden border border-gray-700 text-sm">
          {(['day', 'week', 'month'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 capitalize ${period === p ? 'bg-cyan-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}`}
            >
              {p === 'day' ? 'Day' : p === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
        {hasUser && (
          <div className="inline-flex rounded-md overflow-hidden border border-gray-700 text-sm">
            <button
              onClick={() => setViewMode('group')}
              className={`px-3 py-1 ${viewMode === 'group' ? 'bg-cyan-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}`}
            >
              Group
            </button>
            <button
              onClick={() => setViewMode('user')}
              className={`px-3 py-1 ${viewMode === 'user' ? 'bg-cyan-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}`}
            >
              You
            </button>
          </div>
        )}
      </div>

      {availableTags.length > 0 && (
        <div ref={tagMenuRef} className="relative mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => setTagMenuOpen((v) => !v)}
            title="Filter by tags"
            className={`relative p-1.5 rounded-md border transition-colors ${
              selectedTags.size > 0
                ? 'border-cyan-500 text-cyan-300 bg-cyan-600/10'
                : 'border-gray-700 text-gray-500 bg-gray-900 hover:border-gray-500 hover:text-gray-300'
            }`}
          >
            {/* funnel icon */}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
            </svg>
            {selectedTags.size > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-cyan-500 text-gray-900 text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {selectedTags.size}
              </span>
            )}
          </button>
          {tagMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-56 max-h-56 overflow-y-auto bg-gray-800 border border-gray-600 rounded-lg shadow-xl">
              {selectedTags.size > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setSelectedTags(new Set())}
                    className="w-full px-3 py-1.5 text-sm text-left text-gray-400 hover:bg-gray-700"
                  >
                    Clear filter
                  </button>
                  <div className="border-t border-gray-700" />
                </>
              )}
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-left hover:bg-gray-700"
                >
                  <span className={selectedTags.has(tag) ? 'text-cyan-300' : 'text-gray-300'}>{tag}</span>
                  {selectedTags.has(tag) && <span className="text-cyan-400">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {data.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-500">
          No spending matches the selected tags
        </div>
      ) : (
      <div ref={viewportRef} className="overflow-x-auto">
        <div ref={scrollRef} className="w-full">
          <svg width={width} height={CHART_HEIGHT} className="block">
          <defs>
            <linearGradient id="spending-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill="url(#spending-area)" />}
          {plotted.map((s) => (
            <path key={s.key} d={pathOf(s.points)} stroke={s.color} strokeWidth={2} fill="none" />
          ))}
          {plotted.map((s) =>
            s.points.map((p, i) => (
              <circle
                key={`${s.key}-${i}`}
                cx={p.x}
                cy={p.y}
                r={selIdx === i ? 4.5 : 2.5}
                fill={s.color}
                stroke={selIdx === i ? '#fff' : 'none'}
                strokeWidth={selIdx === i ? 1.5 : 0}
              />
            )),
          )}
          {/* Hit areas and axis labels, drawn once regardless of series count */}
          {data.map((d, i) => (
            <g key={d.weekStart} onClick={() => setSelected(i)} style={{ cursor: 'pointer' }}>
              <rect x={xAt(i) - effectiveBarWidth / 2} y={0} width={effectiveBarWidth} height={CHART_HEIGHT} fill="transparent" />
              {/* Value labels only make sense with a single line */}
              {isTotalMode && totalPoints[i]?.value > 0 && (
                <text
                  x={xAt(i)}
                  y={totalPoints[i].y - 9}
                  textAnchor="middle"
                  fontSize={10}
                  fill={selIdx === i ? '#22d3ee' : '#9ca3af'}
                  fontWeight={selIdx === i ? 600 : 400}
                >
                  {formatNumber(totalPoints[i].value)}
                </text>
              )}
              <text
                x={xAt(i)}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fontSize={10}
                fill={selIdx === i ? '#e5e7eb' : '#9ca3af'}
              >
                {formatLabel(d.weekStart, period)}
              </text>
            </g>
          ))}
          </svg>
        </div>
      </div>
      )}

      {selectedBucket && (
        <div className="mt-2 text-sm text-gray-300">
          <span className="font-medium">{formatPeriodLabel(selectedBucket.weekStart, period)}</span>
          {isTotalMode ? (
            <>
              <span className="text-gray-500"> · </span>
              <span className="font-semibold text-cyan-300">{formatCurrency(selectedValue, currency)}</span>
            </>
          ) : (
            // Doubles as the legend: colour, tag, and its value in this bucket.
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
              {plotted.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5 text-xs">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                  <span className="text-gray-400">{s.label}</span>
                  <span className="font-semibold" style={{ color: s.color }}>
                    {formatCurrency(s.values[selIdx] ?? 0, currency)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
