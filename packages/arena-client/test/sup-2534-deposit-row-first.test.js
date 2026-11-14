// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 page-1 (round 2): A CLAIMED DEPOSIT WHOSE HISTORY ROW A FULL BROWSER REFUSED LOSES ITS PENDING ENTRY ANYWAY - THE FEDERATION IS
// NAMED NOWHERE IN THE BROWSER.
//
// depositEnded is "the one transition" of a pending deposit (kanban #1179): "Claimed writes its history row before the entry goes, so a page
// closed between the two keeps the entry". But the row is written by ledgerAppend with a raw setItem (no putRoomy, so the page's storage-full
// handler never frees room for it) whose refusal is swallowed (`return false`), and depositEnded drops the pending entry whatever that write
// did. In a full browser (#616/#883: the 5 MB filled by wallet databases) the claim of a paid deposit - or of a Move's receive leg (#1774),
// which rides the same entry - removes arena.deposit.pending.<fed>.<op> and writes no arena.ledger.<fed>.* row. When that federation had no
// row before (the first deposit there, or a Move into a federation the player never used), nothing in the storage names it any more:
// ledgerFederations returns nothing for it, so after the reload ARENA_SUM_BALANCES and the resume never open that wallet - the money is
// claimed and invisible, the history never shows the deposit, and onClaimed (the "credited" line, and the sweep of a deposit another
// phrase's wallet claimed) never runs.
// The invariant: once a deposit's entry leaves the browser, its claimed row is there - the federation it went to stays named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeDeposits, depositEnded, pendingDeposits, ledgerRows, ledgerFederations, DEPOSIT_STATE } from '../src/page-lock.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const FED = 'f1'.repeat(32);
const OP = 'ab'.repeat(32);
/** A browser storage at its quota for new history rows: every arena.ledger.* write throws QuotaExceededError (the rest still fits). */
const fullStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (String(k).startsWith('arena.ledger.')) { const e = new Error("Setting the value of '" + k + "' exceeded the quota."); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    map: m,
  };
};

test('wf1489-sm2-page-1: a reload resumes a paid deposit in a full browser - the federation stays named (row or entry)', async () => {
  const L = fullStore();
  // the deposit page's invoice, kept before the payment (pendingAdd's own key and shape); the first deposit into this federation
  L.setItem(`arena.deposit.pending.${FED}.${OP}`, JSON.stringify([{ atMs: 1, invoice: 'lntb10u1notdecodable', operation: OP, msat: '1000000' }]));
  assert.deepEqual(ledgerFederations(L), [FED], 'before the claim the pending entry names the federation');
  let credited = 0;
  // the reload: the wallet reopens and its receive ends Claimed - the 1,000 sat are in the wallet
  const finals = await resumeDeposits({ client: { awaitReceive: async () => DEPOSIT_STATE.CLAIMED }, storage: L, federationId: fromHex(FED), onClaimed: () => { credited++; } });
  const rows = ledgerRows(L, FED), left = pendingDeposits(L, FED), named = ledgerFederations(L);
  console.log(`  FACTS wf1489-sm2-page-1: resume -> ${finals.join(', ')}; history rows ${rows.length}; pending entries ${left.length}; federations named ${named.length}; onClaimed ${credited}`);
  assert.ok(rows.length > 0 || left.length > 0, 'the claimed deposit is in the history, or its entry stays for the next page to write the row');
  assert.deepEqual(named, [FED], 'the federation the 1,000 sat were claimed in is still named in this browser (ledgerFederations), so its wallet is opened and summed');
});

test('wf1489-sm2-page-1: depositEnded itself - Claimed with the row refused does not drop the entry', () => {
  const L = fullStore();
  L.setItem(`arena.deposit.pending.${FED}.${OP}`, JSON.stringify([{ atMs: 1, invoice: null, operation: OP, msat: '5000000' }]));
  const added = depositEnded(L, fromHex(FED), OP, DEPOSIT_STATE.CLAIMED, { operation: OP, amountMsat: 5000000n });
  const left = pendingDeposits(L, FED).length;
  console.log(`  FACTS wf1489-sm2-page-1: depositEnded Claimed in a full browser -> row written ${added}; entry left ${left}`);
  assert.ok(added || left === 1, 'a Claimed whose row could not be written keeps its entry (the #1179 order: row first, then the entry)');
});
