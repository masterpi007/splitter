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

// Normalised shape: { line, date, description, amount, paidBy, tags,
//                     parts: [{ name, share, accepted }] }
function emit(list) {
  const out = [];
  out.push('-- generated by scripts/csv-to-sql.mjs — review before running');
  out.push('BEGIN TRANSACTION;');

  let n = 0;
  let settlements = 0;
  for (const x of list) {
    try {
      const when = toIso(x.date);
      const id = randomUUID();
      const tags = (x.tags || '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      // The app writes settlements as "Settlement: A → B"; anything else is
      // an expense, even when a single participant carries the whole amount
      // (that is "A paid for B", which nets out the same but counts as
      // spending in the chart).
      const isSettlement = x.forceSettlement || /^settlement\s*:/i.test(x.description);

      const sum = round2(x.parts.reduce((s, p) => s + p.share, 0));
      if (!isSettlement && Math.abs(sum - x.amount) >= 0.02) {
        throw new Error(`shares sum to ${sum}, expected ${x.amount}`);
      }

      out.push('');
      out.push(`-- line ${x.line}: ${x.description || '(no description)'}`);
      out.push(
        `INSERT INTO expenses (id, group_id, description, amount, paid_by, created_by, split_type, receipt_date, created_at) VALUES (` +
          `${q(id)}, ${q(groupId)}, ${q(x.description)}, ${x.amount}, ` +
          `${memberRef(x.paidBy)}, ${memberRef(x.paidBy)}, ${q(isSettlement ? 'settlement' : 'exact')}, ${q(when)}, ${q(when)});`,
      );

      for (const p of x.parts) {
        out.push(
          `INSERT INTO expense_splits (expense_id, member_id, value, amount, signed_off, signed_at) VALUES (` +
            `${q(id)}, ${memberRef(p.name)}, ${p.share}, ${p.share}, ${p.accepted ? 1 : 0}, ${p.accepted ? q(when) : 'NULL'});`,
        );
      }
      for (const tag of tags) {
        out.push(`INSERT INTO expense_tags (expense_id, tag) VALUES (${q(id)}, ${q(tag)});`);
      }
      n++;
      if (isSettlement) settlements++;
    } catch (err) {
      console.error(`line ${x.line}: ${err.message}`);
      process.exit(1);
    }
  }

  out.push('');
  out.push('COMMIT;');
  console.log(out.join('\n'));
  console.error(`ok — ${n} transaction(s) for group ${groupId} (${settlements} settlement(s))`);
}

// The app's own export uses one row per participant (Date, Description,
// Amount, Paid By, Participant, Share, Status, Tags). Fold those rows back
// into one expense each, then hand them to the same emitter below.
const isExportFormat = header.includes('participant') && header.includes('share');
if (isExportFormat) {
  const groups = new Map();
  for (const [i, r] of rows.entries()) {
    const key = [col(r, 'date'), col(r, 'description'), col(r, 'amount'), col(r, 'paid by')].join(' ');
    if (!groups.has(key)) {
      groups.set(key, {
        line: i + 2,
        date: col(r, 'date'),
        description: col(r, 'description'),
        amount: num(col(r, 'amount')),
        paidBy: col(r, 'paid by'),
        tags: col(r, 'tags'),
        // A transfer the export wrote as a plain expense can be marked by
        // adding a `type` column with the value `settlement`.
        forceSettlement: col(r, 'type').toLowerCase() === 'settlement',
        parts: [],
      });
    }
    groups.get(key).parts.push({
      name: col(r, 'participant'),
      share: num(col(r, 'share')),
      accepted: col(r, 'status').toLowerCase() !== 'pending',
    });
  }
  emit([...groups.values()]);
  process.exit(0);
}

// --- simple format: one row per expense, participants in the `split` column --

const simple = [];
for (const [i, r] of rows.entries()) {
  const line = i + 2;
  try {
    const amount = num(col(r, 'amount'));
    const paidBy = col(r, 'paid_by');
    const spec = col(r, 'split');
    const accepted = (col(r, 'accepted') || 'yes').toLowerCase() !== 'no';
    if (!paidBy) throw new Error('paid_by is required');
    if (!spec) throw new Error('split is required');
    const isSettlement = (col(r, 'type') || '').toLowerCase() === 'settlement';

    const parsed = parseSplit(spec);
    let parts;
    if (isSettlement) {
      parts = [{ name: parsed.entries[0]?.name ?? spec.trim(), share: amount, accepted }];
    } else if (parsed.mode === 'exact') {
      parts = parsed.entries.map((e) => ({ name: e.name, share: e.amount, accepted }));
    } else if (parsed.mode === 'all') {
      throw new Error("split=all needs the roster; list the names explicitly");
    } else {
      parts = distribute(amount, parsed.entries, paidBy).map((e) => ({
        name: e.name,
        share: e.amount,
        accepted,
      }));
    }

    simple.push({
      line,
      date: col(r, 'date'),
      description: col(r, 'description') || (isSettlement ? 'Settlement' : ''),
      amount,
      paidBy,
      tags: col(r, 'tags'),
      parts,
    });
  } catch (err) {
    console.error(`line ${line}: ${err.message}`);
    process.exit(1);
  }
}
emit(simple);
