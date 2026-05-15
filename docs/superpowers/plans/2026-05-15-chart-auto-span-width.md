# Chart Auto-Span Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the spending chart fill the available card width when there are only a few buckets, while preserving horizontal scrolling when there are many buckets.

**Architecture:** Keep all behavior inside `src/components/WeeklySpendingChart.tsx`. Measure the visible chart viewport with a `ResizeObserver`, store that width in component state, and compute the SVG width as the larger of the measured viewport width and the chart’s natural content width. Preserve the existing period toggles, aggregation logic, and scroll-to-latest behavior.

**Tech Stack:** React, TypeScript, SVG, ResizeObserver, Tailwind CSS

---

## File structure

- Modify: `src/components/WeeklySpendingChart.tsx` — add viewport measurement and replace fixed minimum-width sizing with measured sizing.
- Verify: `src/pages/Balances.tsx` — no code changes expected; confirm the chart still renders in the same section and receives the same props.

### Task 1: Add viewport measurement to the chart

**Files:**
- Modify: `src/components/WeeklySpendingChart.tsx:1-181`
- Verify: `src/pages/Balances.tsx:27-31`

- [ ] **Step 1: Add viewport ref and width state**

Replace the current state/ref block near the top of `WeeklySpendingChart` with this code:

```tsx
export function WeeklySpendingChart({ expenses, currentUserId, currency, hasUser }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('group');
  const [period, setPeriod] = useState<Period>('week');
  const [selected, setSelected] = useState<number>(-1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
```

- [ ] **Step 2: Add a resize observer effect**

Insert this effect below the existing `useLayoutEffect` that scrolls to the newest bucket:

```tsx
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      setContainerWidth(el.clientWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);
```

- [ ] **Step 3: Run typecheck before width math changes**

Run: `npx tsc --noEmit`
Expected: PASS with no output.

- [ ] **Step 4: Commit the measurement scaffolding**

```bash
git add src/components/WeeklySpendingChart.tsx
git commit -m "refactor: measure spending chart viewport"
```

### Task 2: Replace fixed minimum width with measured width

**Files:**
- Modify: `src/components/WeeklySpendingChart.tsx:74-128`
- Verify: `src/pages/Balances.tsx:27-31`

- [ ] **Step 1: Replace fixed inner width math**

Replace this block:

```tsx
  const barWidth = PERIOD_WIDTH[period];
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const innerWidth = Math.max(data.length * barWidth, 280);
  const width = innerWidth + PAD_X * 2;
```

with this code:

```tsx
  const barWidth = PERIOD_WIDTH[period];
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const naturalInnerWidth = data.length * barWidth;
  const usableContainerWidth = Math.max(containerWidth - PAD_X * 2, 0);
  const innerWidth = Math.max(usableContainerWidth, naturalInnerWidth);
  const width = innerWidth + PAD_X * 2;
```

- [ ] **Step 2: Attach the viewport ref to the scroll container**

Replace this container:

```tsx
      <div ref={scrollRef} className="overflow-x-auto">
```

with this code:

```tsx
      <div ref={viewportRef} className="overflow-x-auto">
        <div ref={scrollRef} className="w-full">
```

Then replace the closing section:

```tsx
        </svg>
      </div>
```

with this code:

```tsx
        </svg>
        </div>
      </div>
```

- [ ] **Step 3: Keep scroll-to-latest targeting the scrollable element**

Update the existing `useLayoutEffect` so it still targets the horizontally scrollable container. Replace:

```tsx
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [viewMode, data.length, period]);
```

with:

```tsx
  useLayoutEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = viewportRef.current.scrollWidth;
    }
  }, [viewMode, data.length, period]);
```

- [ ] **Step 4: Run typecheck after the width change**

Run: `npx tsc --noEmit`
Expected: PASS with no output.

- [ ] **Step 5: Manually verify behavior in the browser**

Run the app using the project’s normal dev command, then check the Balances page:

- With only a few points in Day/Week/Month, the chart line spans the full card width.
- With many points, the chart still overflows horizontally and can be scrolled.
- Switching Day/Week/Month recalculates width without breaking point selection.
- Switching Group/You recalculates width without breaking scroll-to-latest.

Expected: All four checks pass.

- [ ] **Step 6: Commit the sizing behavior**

```bash
git add src/components/WeeklySpendingChart.tsx
git commit -m "fix: make spending chart fill available width"
```

### Task 3: Final verification

**Files:**
- Verify: `src/components/WeeklySpendingChart.tsx`
- Verify: `src/pages/Balances.tsx`

- [ ] **Step 1: Run final typecheck**

Run: `npx tsc --noEmit`
Expected: PASS with no output.

- [ ] **Step 2: Review the final diff**

Run: `git diff -- src/components/WeeklySpendingChart.tsx src/pages/Balances.tsx`
Expected: diff only shows viewport measurement, width math changes, and scroll container/ref adjustments.

- [ ] **Step 3: Confirm spec coverage**

Check that the implementation satisfies all approved requirements:
- sparse data fills the card width
- dense data remains horizontally scrollable
- no change to toggles or aggregation logic
- no change to page/container sizing outside the chart component

Expected: all requirements satisfied.
```
