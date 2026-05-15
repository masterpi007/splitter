# Expense Card Click + Hover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole transaction card open `/tx/:id` on click while preserving all internal controls, and add a border-matched hover highlight.

**Architecture:** Update `src/components/ExpenseCard.tsx` for root-card navigation, keyboard support, and hover styling, plus `src/components/SignOffButton.tsx` so sign-off clicks do not bubble into card navigation. Every nested interactive control stops event propagation so its current behavior is preserved.

**Tech Stack:** React, React Router, TypeScript, Tailwind CSS.

---

### Task 1: Make the card root navigate

**Files:**
- Modify: `src/components/ExpenseCard.tsx`

- [ ] **Step 1: Add navigation import and handler**

In `src/components/ExpenseCard.tsx`, add `useNavigate` to the router imports and create the root navigation handler near the other handlers:

```tsx
import { Link, useNavigate } from 'react-router-dom';
```

Then inside `ExpenseCard`:

```tsx
  const navigate = useNavigate();

  const openExpenseView = () => {
    navigate(`/tx/${expense.id}`);
  };
```

- [ ] **Step 2: Make the root card clickable and keyboard accessible**

Replace the root wrapper opening tag:

```tsx
    <div className={`bg-gray-800 rounded-lg shadow-sm border ${isSettlement ? 'border-green-700' : 'border-gray-700'} p-4 ${expenseDeleted ? 'opacity-60' : ''}`}>
```

with:

```tsx
    <div
      role="link"
      tabIndex={0}
      onClick={openExpenseView}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openExpenseView();
        }
      }}
      className={`bg-gray-800 rounded-lg shadow-sm border p-4 cursor-pointer transition-all duration-150 ${
        isSettlement
          ? 'border-green-700 hover:shadow-[0_0_0_1px_rgba(21,128,61,0.5),0_10px_30px_rgba(21,128,61,0.18)]'
          : 'border-gray-700 hover:shadow-[0_0_0_1px_rgba(34,211,238,0.28),0_10px_30px_rgba(34,211,238,0.10)]'
      } hover:-translate-y-0.5 ${expenseDeleted ? 'opacity-60' : ''}`}
    >
```

- [ ] **Step 3: Replace the description link with plain text**

Find:

```tsx
                <Link to={`/tx/${expense.id}`} className="font-medium text-gray-100 hover:text-cyan-300 transition-colors">
                  {expense.description}
                </Link>
```

Replace with:

```tsx
                <h3 className="font-medium text-gray-100">{expense.description}</h3>
```

- [ ] **Step 4: Run build to verify it passes**

Run:

```bash
pnpm run build 2>&1 | tail -8
```

Expected: output ends with `✓ built in` and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ExpenseCard.tsx
git commit -m "feat: make expense card open detail page"
```

---

### Task 2: Stop nested controls from triggering navigation

**Files:**
- Modify: `src/components/ExpenseCard.tsx`

- [ ] **Step 1: Stop propagation on delete buttons**

Change both delete buttons from:

```tsx
onClick={handleDelete}
```

to:

```tsx
onClick={(e) => {
  e.stopPropagation();
  handleDelete();
}}
```

This applies to the settlement delete button near the top of the card and the non-settlement delete button near the footer.

- [ ] **Step 2: Stop propagation on tag editing controls**

For each tag edit button, wrap the click handler so it begins with `e.stopPropagation();`.

Example conversion:

```tsx
onClick={() => setEditingTags(true)}
```

becomes:

```tsx
onClick={(e) => {
  e.stopPropagation();
  setEditingTags(true);
}}
```

Apply the same pattern to tag save, tag cancel, and tag chip actions that already mutate tags.

- [ ] **Step 3: Stop propagation on receipt open/close controls**

Update the receipt thumbnail button from:

```tsx
<button
  onClick={() => setShowReceipt(true)}
  className="..."
>
```

to:

```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    setShowReceipt(true);
  }}
  className="..."
>
```

Update the modal close button the same way:

```tsx
onClick={(e) => {
  e.stopPropagation();
  setShowReceipt(false);
}}
```

The inner modal image already stops propagation; keep that behavior.

- [ ] **Step 4: Stop propagation on expand/collapse controls**

For each card expand/collapse trigger such as:

```tsx
onClick={() => setExpanded(true)}
```

and

```tsx
onClick={() => setExpanded(false)}
```

change to:

```tsx
onClick={(e) => {
  e.stopPropagation();
  setExpanded(true);
}}
```

and:

```tsx
onClick={(e) => {
  e.stopPropagation();
  setExpanded(false);
}}
```

Apply this to every expand/collapse button in the component.

- [ ] **Step 5: Stop propagation on claim/assign/item action buttons**

For each nested item action button with async handlers, make the first line of the callback `e.stopPropagation();`.

Example conversion:

```tsx
onClick={async () => {
  setClaimingItemId(item.id);
  try {
    await claimExpenseItem(expense.id, item.id, currentUser.id);
  } finally {
    setClaimingItemId(null);
  }
}}
```

becomes:

```tsx
onClick={async (e) => {
  e.stopPropagation();
  setClaimingItemId(item.id);
  try {
    await claimExpenseItem(expense.id, item.id, currentUser.id);
  } finally {
    setClaimingItemId(null);
  }
}}
```

Apply this pattern to every nested item assignment / claim / split action button in the file.

- [ ] **Step 6: Stop propagation on sign-off button**

In `src/components/SignOffButton.tsx`, change:

```tsx
onClick={handleSignOff}
```

to:

```tsx
onClick={(e) => {
  e.stopPropagation();
  handleSignOff();
}}
```

Also update the handler signature only if needed; no other behavior changes.

- [ ] **Step 7: Run build to verify it passes**

Run:

```bash
pnpm run build 2>&1 | tail -8
```

Expected: output ends with `✓ built in` and no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/ExpenseCard.tsx src/components/SignOffButton.tsx
git commit -m "fix: preserve nested actions inside clickable expense cards"
```

---

### Task 3: Verify behavior manually

**Files:**
- Modify: `src/components/ExpenseCard.tsx` (only if follow-up fixes are needed)

- [ ] **Step 1: Start the app**

Run:

```bash
pnpm run dev
```

Expected: Vite prints a local URL such as `http://localhost:5173/`.

- [ ] **Step 2: Verify whole-card navigation**

Open the app in a browser and check one non-settlement card and one settlement card.

Confirm all of the following:
- Clicking empty space on the card opens `/tx/:id`
- Clicking text/status rows also opens `/tx/:id`
- Hovering shows a glow matching the card border color
- Hovering slightly lifts the card

- [ ] **Step 3: Verify nested controls do not navigate**

On a card that has controls, verify:
- Delete button opens delete confirmation, not detail navigation
- Tag edit controls still edit tags in place
- Receipt thumbnail opens the receipt modal
- Expand/collapse controls only expand/collapse
- Item claim/assign controls still work without navigation
- Sign-off button still signs off without navigation

- [ ] **Step 4: Run final production build**

Run:

```bash
pnpm run build 2>&1 | tail -8
```

Expected: output ends with `✓ built in` and no errors.

- [ ] **Step 5: Commit**

If no follow-up code changes were required after manual verification, skip this commit. If fixes were required, commit them with:

```bash
git add src/components/ExpenseCard.tsx src/components/SignOffButton.tsx
git commit -m "fix: polish clickable expense card interactions"
```
