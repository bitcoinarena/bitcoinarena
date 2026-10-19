// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HOLD-INVOICE PATH IS GONE, NOT RENAMED (§23.6, RULED 2026-09-22 22:59; cut 6b RULED 2026-09-24: "Delete the
// hold vocabulary from payout.js. lock-settlement.js takes settle-or-refund from a federation-only function with the
// same outputs ... comments that name THRESHOLD_LN. No decode-only label. An old round that names it stays invalid.").
//
// MEASURED before this test (2026-09-25): payout.js still exported the hold invoice's actions (SETTLE, CANCEL, NOTHING,
// their wire bytes), its 23.2 table (settlementAction), its pool split (holdSettlement), its state machine (HELD,
// SETTLED, CANCELLED, EXPIRED, holdAfter) and its invoice check (invoiceMatchesEntry); lock-settlement.js,
// slash.js and the node's preimage.js imported them; thirteen files under src/ and tools/ still named THRESHOLD_LN.
//
// A lock has three ends of its own, and they are the federation's: CLAIM (a loser's lock claimed into the settlement),
// RETURN (a qualifier's lock forfeited back to its refund key) and EXPIRE (a VOID - nobody acts, and the lock refunds at
// its expiry). arena-protocol/src/lock-action.js holds them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import * as payout from '../src/payout.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const HOLD = ['SETTLE', 'CANCEL', 'NOTHING', 'ACTIONS', 'actionByte', 'actionOf', 'settlementAction', 'holdSettlement',
  'HELD', 'SETTLED', 'CANCELLED', 'EXPIRED', 'holdAfter', 'invoiceMatchesEntry'];

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(js|mjs|sh|rs)$/.test(name)) out.push(p);
  }
  return out;
}

test('payout.js exports none of the hold invoice\'s vocabulary', () => {
  const still = HOLD.filter((n) => n in payout);
  assert.deepEqual(still, [], `payout.js still exports ${still.join(', ')}`);
});

test('no source or tool imports the hold vocabulary from payout.js', () => {
  const importing = [];
  for (const pkg of ['arena-protocol', 'arena-node', 'arena-client', 'nextblock']) {
    for (const sub of ['src', 'tools']) {
      let files = [];
      try { files = filesUnder(join(ROOT, 'packages', pkg, sub)); } catch { continue; }
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*\/payout\.js'/g)) {
          const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
          const hold = names.filter((n) => HOLD.includes(n));
          if (hold.length) importing.push(`${f.slice(ROOT.length)}: ${hold.join(', ')}`);
        }
      }
    }
  }
  assert.deepEqual(importing, []);
});

test('nothing under src/ or tools/ names THRESHOLD_LN', () => {
  const naming = [];
  for (const pkg of ['arena-protocol', 'arena-node', 'arena-client', 'nextblock']) {
    for (const sub of ['src', 'tools']) {
      let files = [];
      try { files = filesUnder(join(ROOT, 'packages', pkg, sub)); } catch { continue; }
      for (const f of files) if (readFileSync(f, 'utf8').includes('THRESHOLD_LN')) naming.push(f.slice(ROOT.length));
    }
  }
  assert.deepEqual(naming, [], `still named in ${naming.length} file(s)`);
});

test('a lock has three ends of its own - CLAIM, RETURN, EXPIRE - and the settle-or-refund split is the federation\'s', async () => {
  let m = null;
  try { m = await import('../src/lock-action.js'); } catch (e) { m = { missing: e.message }; }
  assert.equal(m.missing, undefined, `arena-protocol/src/lock-action.js: ${m.missing}`);
  assert.deepEqual(m.LOCK_ACTIONS, ['CLAIM', 'RETURN', 'EXPIRE']);
  assert.equal(typeof m.lockAction, 'function');
  assert.equal(typeof m.lockActions, 'function');
});
