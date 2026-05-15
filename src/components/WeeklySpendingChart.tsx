import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Expense } from '../types';
import { formatCurrency, formatNumber, calculateWeeklySpending, calculateDailySpending, calculateMonthlySpending } from '../utils/balances';

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const data = useMemo(() => {
    if (period === 'day') return calculateDailySpending(expenses, currentUserId);
    if (period === 'month') return calculateMonthlySpending(expenses, currentUserId);
    return calculateWeeklySpending(expenses, currentUserId);
  }, [expenses, currentUserId, period]);

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

  if (data.length === 0) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
        <p className="text-gray-400">No spending yet</p>
      </div>
    );
  }

  const effectiveMode: ViewMode = hasUser ? viewMode : 'group';
  const values = data.map((d) => (effectiveMode === 'group' ? d.groupTotal : d.userShare));
  const maxValue = Math.max(...values, 1);

  const barWidth = PERIOD_WIDTH[period];
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const usableContainerWidth = Math.max(containerWidth - PAD_X * 2, 0);
  const naturalInnerWidth = data.length * barWidth;
  const shouldStretch = data.length > 0 && usableContainerWidth > naturalInnerWidth;
  const effectiveBarWidth = shouldStretch ? usableContainerWidth / data.length : barWidth;
  const innerWidth = shouldStretch ? usableContainerWidth : naturalInnerWidth;
  const width = innerWidth + PAD_X * 2;

  const points = values.map((v, i) => ({
    x: PAD_X + i * effectiveBarWidth + effectiveBarWidth / 2,
    y: PAD_TOP + innerHeight * (1 - v / maxValue),
    value: v,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L${points[points.length - 1].x},${PAD_TOP + innerHeight} L${points[0].x},${PAD_TOP + innerHeight} Z`
      : '';

  const selIdx = selected >= 0 && selected < data.length ? selected : data.length - 1;
  const selectedBucket = data[selIdx];
  const selectedValue = effectiveMode === 'group' ? selectedBucket.groupTotal : selectedBucket.userShare;

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
          <path d={linePath} stroke="#06b6d4" strokeWidth={2} fill="none" />
          {points.map((p, i) => (
            <g key={i} onClick={() => setSelected(i)} style={{ cursor: 'pointer' }}>
              <rect x={p.x - effectiveBarWidth / 2} y={0} width={effectiveBarWidth} height={CHART_HEIGHT} fill="transparent" />
              <circle
                cx={p.x}
                cy={p.y}
                r={selIdx === i ? 5 : 3}
                fill={selIdx === i ? '#22d3ee' : '#0891b2'}
                stroke={selIdx === i ? '#fff' : 'none'}
                strokeWidth={selIdx === i ? 1.5 : 0}
              />
              {p.value > 0 && (
                <text
                  x={p.x}
                  y={p.y - 9}
                  textAnchor="middle"
                  fontSize={10}
                  fill={selIdx === i ? '#22d3ee' : '#9ca3af'}
                  fontWeight={selIdx === i ? 600 : 400}
                >
                  {formatNumber(p.value)}
                </text>
              )}
              <text
                x={p.x}
                y={CHART_HEIGHT - 8}
                textAnchor="middle"
                fontSize={10}
                fill={selIdx === i ? '#e5e7eb' : '#9ca3af'}
              >
                {formatLabel(data[i].weekStart, period)}
              </text>
            </g>
          ))}
          </svg>
        </div>
      </div>

      <div className="mt-2 text-sm text-gray-300">
        <span className="font-medium">{formatPeriodLabel(selectedBucket.weekStart, period)}</span>
        <span className="text-gray-500"> · </span>
        <span className="font-semibold text-cyan-300">{formatCurrency(selectedValue, currency)}</span>
      </div>
    </div>
  );
}
