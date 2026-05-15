# Chart auto-span width design

## Goal
Make the spending chart fill the available card width when there are only a few buckets, while preserving horizontal scrolling when there are many buckets.

## Current behavior
The chart width is computed from bucket count and a fixed per-period width, with a small hard minimum. When there are only a few buckets, the SVG stays narrow instead of spanning the card.

## Chosen approach
Measure the chart viewport width and compute the SVG width as the larger of:
- the available viewport width inside the card
- the natural content width derived from `data.length * barWidth`

This keeps the current scrolling model intact:
- sparse data → chart stretches to fill the card
- dense data → chart exceeds the card width and scrolls horizontally

## Implementation
### In `src/components/WeeklySpendingChart.tsx`
- Add a second ref for the visible chart viewport container.
- Track `containerWidth` in component state.
- Use `ResizeObserver` to update `containerWidth` whenever the viewport width changes.
- Replace the fixed minimum-width logic with:
  - `naturalInnerWidth = data.length * barWidth`
  - `innerWidth = Math.max(usableContainerWidth, naturalInnerWidth)`
  - `width = innerWidth + PAD_X * 2`
- Derive `usableContainerWidth` from the measured viewport width, subtracting horizontal chart padding so plotted points align with the actual drawable area.

## Behavior details
- No change to period toggles or group/you toggles.
- No change to bucket aggregation.
- No change to scroll-to-latest behavior.
- When width is not measured yet on first render, the component may briefly use the natural width, then expand once measurement lands.

## Testing
- Few daily points: chart spans full card width.
- Few weekly points: chart spans full card width.
- Many daily points: chart overflows horizontally and remains scrollable.
- Resize viewport: chart recalculates width correctly.
- Toggle Day/Week/Month: width recalculates correctly.

## Scope
This change is limited to layout sizing in the spending chart component. No other page/container sizing changes are included.
