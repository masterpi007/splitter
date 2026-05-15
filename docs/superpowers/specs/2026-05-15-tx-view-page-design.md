# Transaction View Page Design

**Date:** 2026-05-15  
**Status:** Approved

## Overview

Replace the current pattern of linking directly to `/edit/:id` (which shows "no permission" to non-editors) with a dedicated read-only view page at `/tx/:id`. Edit functionality remains at `/edit/:id`, accessible via a pencil icon on the view page for eligible users.

## Routes

| Route | Component | Access |
|-------|-----------|--------|
| `/tx/:id` | `ExpenseView.tsx` (new) | Any group member |
| `/edit/:id` | `EditExpense.tsx` (unchanged) | Payer / creator / admin only |

## Link Updates

All existing links that point to `/edit/:id` are redirected to `/tx/:id`:

- `src/components/ExpenseCard.tsx` line 159 — description link
- `functions/api/expenses.ts` — push notification URL for new/updated expenses
- `functions/api/expenses/[id].ts` — push notification URL for edits

`App.tsx` gains a new `<Route path="/tx/:id" element={<ExpenseView />} />` entry alongside the existing `/edit/:id` route.

## ExpenseView Page Layout

### Header bar
- Back arrow (←) on the left — `navigate(-1)`
- "Transaction" title (center)
- Pencil icon (✏️) on the right — visible only to payer / creator / admin; links to `/edit/${expense.id}`

### Body
1. **Description** — large text + split type badge (Shares / Items / Group / Settlement)
2. **Amount + currency** — prominent; paid-by name and formatted date below
3. **Splits table** — one row per member: name · amount · status icon (✅ confirmed / ⏳ pending). For group-mode expenses (`splitType === 'group'`) which store no `splits` array, show all current group members with computed equal shares and their `signedOffBy` status instead.
4. **Tags** — pill list, shown only if tags exist
5. **Receipt thumbnail** — shown only if receipt exists; tappable to expand full image
6. **Deleted banner** — amber warning bar shown when expense has the `deleted` tag

### Footer actions
- **"Confirm my share" button** — shown only when current user has an unsigned split and expense is not deleted; calls existing `signOffExpense` from `useApp()`
- **"Delete" button** — shown only to payer / creator / admin on non-deleted expenses; triggers a `ConfirmDialog`, then calls existing `deleteExpense` from `useApp()`

## Data

All data sourced from existing `useApp()` context: `expenses`, `group`, `currentUser`, `signOffExpense`, `deleteExpense`. No new API calls required.

## Error States

| Condition | Behaviour |
|-----------|-----------|
| Expense ID not found | "Transaction not found" message with back link |
| User not in group | Auth/AppContext redirects before page loads — no special handling needed |

## Permissions Summary

| Action | Who can see it |
|--------|---------------|
| View page | Any group member |
| Pencil icon | Payer, creator, or group admin |
| Delete button | Payer, creator, or group admin |
| Confirm button | Current user with unsigned split |

## Out of Scope

- Inline editing on the view page (edit remains a separate route)
- Receipt upload from the view page
- Comments or activity log
