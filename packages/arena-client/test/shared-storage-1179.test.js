// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1179 THE LISTS A BROWSER'S TABS SHARE. Before: the deposits still pending (arena.deposit.pending.<fed>) and the wallet history (arena.ledger.<fed>) were one list per
// federation each, read, changed and written back by whichever tab wrote; two tabs on two phrases depositing in one federation share the storage, so one's write could drop the
// other's entry - a deposit never resumed, its wallet no longer held against tidyStorage, a history row gone. A scan of the federation that failed after its first page still
// dropped every invoice it was asked about. Now each deposit and each history row is its own key, an entry leaves only when its deposit ends, and a scan drops nothing it did
// not read to the end. The lists a page before this kept are still read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositOffer, pendingDeposits, resumeDeposits, scanLostDeposits, ledgerRows, ledgerFederations, recordReceived, tidyStorage, walletSecretFor } from '../src/page-lock.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, map: m }; };
/** A second tab's view of the same storage that read it before the first tab's write landed, and writes after it: what two processes sharing localStorage can do. */
const staleView = (shared) => {
  const seen = new Map(shared.map);
  return { getItem: (k) => (seen.has(k) ? seen.get(k) : null), setItem: (k, v) => { seen.set(k, String(v)); shared.setItem(k, v); }, removeItem: (k) => { seen.delete(k); shared.removeItem(k); },
    key: (i) => [...seen.keys()][i] ?? null, get length() { return seen.size; } };
};
const FED = 'f0'.repeat(32), CUR = 'c0'.repeat(32), PA = 'a1'.repeat(32), PB = 'b1'.repeat(32);
const dbOf = (hex, fed = FED) => `arena.walletdb.${fed.slice(0, 16)}.${toHex(sha256(walletSecretFor(fromHex(hex), fromHex(fed)))).slice(0, 16)}.`;
const count = (L, hex) => [...L.map.keys()].filter((k) => k.startsWith(dbOf(hex))).length;
const waiting = (op, invoice) => ({ receive: async () => JSON.stringify({ invoice, operation: op }), awaitReceive: () => new Promise(() => {}) });

test('#1179 two tabs on two phrases deposit in one federation at once: both deposits stay pending, and tidyStorage keeps both wallets that made them', async () => {
  const shared = store(), tabB = staleView(shared);
  const opA = 'aa'.repeat(32), opB = 'bb'.repeat(32);
  await depositOffer({ client: waiting(opA, 'lntb1a'), stakeMsat: 100000n, storage: shared, federationId: fromHex(FED) }).invoice(100000n);
  await depositOffer({ client: waiting(opB, 'lntb1b'), stakeMsat: 100000n, storage: tabB, federationId: fromHex(FED) }).invoice(200000n);
  const pending = pendingDeposits(shared, FED).map((p) => p.operation).sort();
  // each phrase's wallet holds the operation it made; the playing phrase's is a third
  shared.setItem(`${dbOf(PA)}30${opA}`, 'x'.repeat(100));
  shared.setItem(`${dbOf(PB)}30${opB}`, 'x'.repeat(100));
  shared.setItem(`${dbOf(CUR)}2f`, 'x'.repeat(100));
  tidyStorage(shared, { seeds: [CUR, PA, PB], current: CUR, federations: [FED], pressureChars: 10 });
  console.log(`  FACTS #1179: two tabs, one deposit each in one federation -> ${pending.length} pending (${pending.map((o) => o.slice(0, 4)).join(', ')}); wallets kept by a full browser's tidy: A ${count(shared, PA)}, B ${count(shared, PB)}`);
  assert.deepEqual(pending, [opA, opB], 'neither tab\'s write dropped the other\'s deposit');
  assert.equal(count(shared, PA), 1, 'the wallet that made deposit A stays');
  assert.equal(count(shared, PB), 1, 'the wallet that made deposit B stays');
  assert.deepEqual(ledgerFederations(shared), [FED], 'the federation is held by its pending deposits');
});

test('#1179 two tabs write a history row at once: both rows are kept', () => {
  const shared = store(), tabB = staleView(shared);
  recordReceived(shared, FED, { kind: 'zap-in', msat: 1000n });
  recordReceived(tabB, FED, { kind: 'referral', msat: 2000n, round: 'r1' });
  const rows = ledgerRows(shared, FED).map((r) => r.kind);
  console.log(`  FACTS #1179: two tabs, one history row each -> ${rows.length} rows kept (${rows.join(', ')})`);
  assert.deepEqual(rows.sort(), ['referral', 'zap-in']);
});

test('#1179 a scan of the federation that fails after its first page drops none of the invoices it was asked about', async () => {
  const L = store();
  L.setItem(`arena.deposit.pending.${FED}`, JSON.stringify([{ operation: 'op-lost', invoice: 'lntb1c', msat: '3000000' }]));   // a page before this one kept it
  const client = { scanDeposits: async (from) => { if (from === '0') return JSON.stringify({ found: [], next: '1', done: false }); throw new Error('the federation went away'); }, awaitReceive: async () => 'Claimed' };
  const r = await scanLostDeposits({ client, storage: L, federationId: fromHex(FED), lost: pendingDeposits(L, FED), timeoutMs: 1000 });
  const left = pendingDeposits(L, FED).map((p) => p.operation);
  console.log(`  FACTS #1179: a scan that read one page of two -> read: ${r.read}; invoices still pending: ${left.length}`);
  assert.equal(r.read, false, 'not read to the end');
  assert.deepEqual(left, ['op-lost'], 'the invoice is looked for again next time');
  // read to the end, it goes
  const whole = { scanDeposits: async () => JSON.stringify({ found: [], next: '1', done: true }) };
  assert.equal((await scanLostDeposits({ client: whole, storage: L, federationId: fromHex(FED), lost: pendingDeposits(L, FED) })).read, true);
  assert.deepEqual(pendingDeposits(L, FED), []);
  assert.equal(L.getItem(`arena.deposit.pending.${FED}`), null, 'and the old list with it');
});

test('#1179 a deposit the scan finds stays pending until its receive ends; Claimed writes its row first, once', async () => {
  const L = store();
  L.setItem(`arena.deposit.pending.${FED}.op-f`, JSON.stringify([{ operation: 'op-f', invoice: 'lntb1d', msat: '4000000' }]));
  let end;
  const client = { scanDeposits: async () => JSON.stringify({ found: [{ operation: 'op-f', msat: '4000000' }], next: '1', done: true }), awaitReceive: () => new Promise((res) => { end = res; }) };
  const scan = scanLostDeposits({ client, storage: L, federationId: fromHex(FED), lost: [] });
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(pendingDeposits(L, FED).map((p) => p.operation), ['op-f'], 'still pending while its claim runs');
  end('Claimed');
  const r = await scan;
  assert.equal(r.msat, 4000000n);
  assert.deepEqual(pendingDeposits(L, FED), []);
  assert.deepEqual(ledgerRows(L, FED).map((x) => [x.kind, x.msat]), [['deposit', '4000000']]);
  // a second tab's scan of the same claim writes no second row
  await scanLostDeposits({ client: { scanDeposits: client.scanDeposits, awaitReceive: async () => 'Claimed' }, storage: staleView(L), federationId: fromHex(FED), lost: [] });
  assert.equal(ledgerRows(L, FED).length, 1, 'one claim, one row');
});

test('#1179 the lists a page before this kept are read: a pending entry is resumed and leaves its list alone, old history rows come first', async () => {
  const L = store();
  L.setItem(`arena.deposit.pending.${FED}`, JSON.stringify([{ operation: 'op-1', invoice: 'lntb1e', msat: '1000' }, { operation: 'op-2', invoice: 'lntb1f', msat: '2000' }]));
  L.setItem(`arena.ledger.${FED}`, JSON.stringify([{ atMs: 5, kind: 'deposit', msat: '500' }]));
  assert.deepEqual(pendingDeposits(L, FED).map((p) => p.operation), ['op-1', 'op-2']);
  resumeDeposits({ client: { awaitReceive: (op) => (op === 'op-1' ? Promise.resolve('Expired') : new Promise(() => {})) }, storage: L, federationId: fromHex(FED) });   // op-2's claim never ends here
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(L.getItem(`arena.deposit.pending.${FED}`)).map((p) => p.operation), ['op-2'], 'the old list loses only the entry that ended');
  recordReceived(L, FED, { kind: 'zap-in', msat: 700n });
  assert.deepEqual(ledgerRows(L, FED).map((r) => r.msat), ['500', '700'], 'the old list\'s rows, then the new');
  assert.deepEqual(ledgerFederations(L), [FED]);
});
