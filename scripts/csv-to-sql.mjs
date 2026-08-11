#!/usr/bin/env node
// Turn a per-group expense CSV into SQL for D1.
//
//   node scripts/csv-to-sql.mjs --group <groupId> expenses.csv > import.sql
//
// Member names in the CSV are resolved to member ids by SQL subselect at
// import time, so the group and its members must already exist (create them
// in the app first). Names are matched case-insensitively against non-removed
// members of that group; a name with no match makes the INSERT fail loudly
// rather than silently attaching the expense to nobody.
//
// CSV columns (header row required, order irrelevant, extras ignored):
//   date         ISO date or datetime — when the money was actually spent
//   description  free text
//   amount       total paid, e.g. 250 or 250.5 (dot or comma decimal)
//   paid_by      member name
//   split        who shares it. Either
//                  'all'                     -> every active member, equal
//                  'Minh,Dad'                -> those members, equal
//                  'Minh:2,Dad:1'            -> weighted shares
//                  'Minh=150,Dad=100'        -> exact amounts (must sum to amount)
//   type         optional: expense (default) | settlement
//                for settlement, `split` names the single recipient
//   tags         optional, comma-separated
//   accepted     optional: yes (default) | no — imported history is normally
//                already agreed, so splits are marked signed off
//
// Everything is emitted as one transaction; if any row fails, nothing lands.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// --- args ---------------------------------------------------------------

const argv = process.argv.slice(2);
let groupId = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--group') groupId = argv[++i];
  else files.push(argv[i]);
}
if (!groupId || files.length !== 1) {
  console.error('usage: node scripts/csv-to-sql.mjs --group <groupId> <file.csv>');
  process.exit(1);
}

// --- tiny CSV reader (quoted fields, embedded commas/newlines) -----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const rows = parseCsv(readFileSync(files[0], 'utf8'));
const header = rows.shift().map((h) => h.trim().toLowerCase());
const col = (r, name) => {
  const i = header.indexOf(name);
  return i === -1 ? '' : (r[i] ?? '').trim();
};

// --- helpers ------------------------------------------------------------

const q = (v) => (v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => {
  const n = parseFloat(String(v).replace(/,/g, '.'));
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
};
const round2 = (n) => Math.round(n * 100) / 100;
// Resolve a member name to its id inside the target group.
const memberRef = (name) =>
  `(SELECT id FROM members WHERE group_id = ${q(groupId)} AND lower(name) = lower(${q(name)}) AND removed_at IS NULL)`;

function toIso(raw) {
  const s = raw.trim();
  if (!s) return new Date().toISOString();
  // Accept 'YYYY-MM-DD' as local noon so timezone shifts can't move the day.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (isNaN(d.getTime())) throw new Error(`unparseable date: ${raw}`);
  return d.toISOString();
}

// Split spec -> [{name, weight|exact}], plus the mode.
function parseSplit(spec) {
  const parts = spec.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0].toLowerCase() === 'all') return { mode: 'all', entries: [] };
  if (parts.some((p) => p.includes('='))) {
    return {
      mode: 'exact',
      entries: parts.map((p) => {
        const [name, v] = p.split('=');
        return { name: name.trim(), amount: num(v) };
      }),
    };
  }
  return {
    mode: 'weighted',
    entries: parts.map((p) => {
      const [name, w] = p.split(':');
      return { name: name.trim(), weight: w ? num(w) : 1 };
    }),
  };
}

// Distribute `total` by weights, giving the payer (or first member) the
// rounding remainder so the splits sum exactly to the total.
function distribute(total, entries, payerName) {
  const sum = entries.reduce((s, e) => s + e.weight, 0);
  const out = entries.map((e) => ({ ...e, amount: round2((total * e.weight) / sum) }));
  const diff = round2(total - out.reduce((s, e) => s + e.amount, 0));
  if (Math.abs(diff) >= 0.005) {
    const idx = Math.max(0, out.findIndex((e) => e.name.toLowerCase() === payerName.toLowerCase()));
    out[idx].amount = round2(out[idx].amount + diff);
  }
  return out;
}

// --- emit ---------------------------------------------------------------

const out = [];
out.push('-- generated by scripts/csv-to-sql.mjs — review before running');
out.push('BEGIN TRANSACTION;');

let n = 0;
for (const [i, r] of rows.entries()) {
  const line = i + 2; // 1-based, header consumed
  try {
    const description = col(r, 'description');
    const amount = num(col(r, 'amount'));
    const paidBy = col(r, 'paid_by');
    const when = toIso(col(r, 'date'));
    const type = (col(r, 'type') || 'expense').toLowerCase();
    const accepted = (col(r, 'accepted') || 'yes').toLowerCase() !== 'no';
    const tags = col(r, 'tags').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const spec = col(r, 'split');
    if (!paidBy) throw new Error('paid_by is required');
    if (!spec) throw new Error('split is required');

    const id = randomUUID();
    const isSettlement = type === 'settlement';
    const signedAt = accepted ? when : null;

    out.push('');
    out.push(`-- line ${line}: ${description || '(no description)'}`);
    out.push(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by, created_by, split_type, receipt_date, created_at) VALUES (` +
        `${q(id)}, ${q(groupId)}, ${q(description || (isSettlement ? 'Settlement' : ''))}, ${amount}, ` +
        `${memberRef(paidBy)}, ${memberRef(paidBy)}, ${q(isSettlement ? 'settlement' : 'exact')}, ${q(when)}, ${q(when)});`,
    );

    if (isSettlement) {
      const to = parseSplit(spec).entries[0]?.name ?? spec.trim();
      out.push(
        `INSERT INTO expense_splits (expense_id, member_id, value, amount, signed_off, signed_at) VALUES (` +
          `${q(id)}, ${memberRef(to)}, ${amount}, ${amount}, ${accepted ? 1 : 0}, ${q(signedAt)});`,
      );
    } else {
      const parsed = parseSplit(spec);
      let shares;
      if (parsed.mode === 'exact') {
        const sum = round2(parsed.entries.reduce((s, e) => s + e.amount, 0));
        if (Math.abs(sum - amount) >= 0.01) {
          throw new Error(`exact amounts sum to ${sum}, expected ${amount}`);
        }
        shares = parsed.entries;
      } else if (parsed.mode === 'all') {
        // Resolved at import time: every active member, equal shares. Emitted
        // as one INSERT..SELECT because the roster isn't known here.
        out.push(
          `INSERT INTO expense_splits (expense_id, member_id, value, amount, signed_off, signed_at) ` +
            `SELECT ${q(id)}, m.id, ` +
            `round(${amount} / (SELECT count(*) FROM members WHERE group_id = ${q(groupId)} AND removed_at IS NULL), 2), ` +
            `round(${amount} / (SELECT count(*) FROM members WHERE group_id = ${q(groupId)} AND removed_at IS NULL), 2), ` +
            `${accepted ? 1 : 0}, ${q(signedAt)} ` +
            `FROM members m WHERE m.group_id = ${q(groupId)} AND m.removed_at IS NULL;`,
        );
        shares = null;
      } else {
        shares = distribute(amount, parsed.entries, paidBy);
      }

      if (shares) {
        for (const s of shares) {
          out.push(
            `INSERT INTO expense_splits (expense_id, member_id, value, amount, signed_off, signed_at) VALUES (` +
              `${q(id)}, ${memberRef(s.name)}, ${s.amount}, ${s.amount}, ${accepted ? 1 : 0}, ${q(signedAt)});`,
          );
        }
      }
    }

    for (const tag of tags) {
      out.push(`INSERT INTO expense_tags (expense_id, tag) VALUES (${q(id)}, ${q(tag)});`);
    }
    n++;
  } catch (err) {
    console.error(`line ${line}: ${err.message}`);
    process.exit(1);
  }
}

out.push('');
out.push('COMMIT;');
console.log(out.join('\n'));
console.error(`ok — ${n} transaction(s) ready for group ${groupId}`);
