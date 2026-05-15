# Expense Card Click + Hover Design

**Date:** 2026-05-15  
**Status:** Approved

## Overview

Make the entire transaction card clickable so users can open `/tx/:id` by clicking anywhere on the card, not just the description text. Preserve all existing interactive controls inside the card by preventing their clicks from triggering navigation. Add a hover treatment that visually highlights the card using a shadow/glow matching its current border color.

## Interaction Model

Use a root-level click handler on `ExpenseCard` rather than wrapping content in a full-card `<Link>`.

### Root card behavior
- Clicking anywhere on the card opens `/tx/:id`
- Card root gets `cursor: pointer`
- Card root gets keyboard accessibility:
  - `role="link"`
  - `tabIndex={0}`
  - `Enter` opens `/tx/:id`
  - `Space` opens `/tx/:id`

### Interactive child behavior
These controls must keep their current behavior and must **not** trigger card navigation:
- Delete buttons
- Tag edit buttons
- Receipt thumbnail / receipt modal open-close controls
- Expand / collapse controls
- Claim / assign item buttons
- Sign-off buttons
- ConfirmDialog buttons
- Any other existing button or link inside `ExpenseCard`

Implementation rule: each interactive child handler must stop event propagation before running its own action.

## Content Change

The existing description text link to `/tx/:id` is removed. The description becomes plain text because the whole card is the click target.

## Hover Styling

Apply hover styling on the card root.

### Non-settlement cards
- Keep current border family
- Add a soft cyan/gray shadow or glow that matches the card border tone
- Add a subtle transform for lift (`scale` or small upward translate)
- Animate with a short transition

### Settlement cards
- Keep current green border
- Add a matching green glow/shadow
- Use the same subtle lift and transition behavior as non-settlement cards

### Deleted cards
- Keep reduced opacity
- Still show a lighter version of the hover highlight so the card remains visibly interactive

## Scope

Only `src/components/ExpenseCard.tsx` needs behavioral and styling changes for this adjustment. No routing or API changes are required.
