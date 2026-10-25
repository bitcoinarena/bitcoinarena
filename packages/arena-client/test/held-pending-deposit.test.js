// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEPOSIT PENDING IN A FEDERATION WITH NO LEDGER ROW YET IS STILL HELD (2026-10-20 16:46Z: 1,000 sat paid into b18947f0 "was not
// reflected", and after a reload still not credited). gw-b funded the incoming contract; the page that made the invoice was suspended,
// and the reloaded page opened wallets only where the ledger had rows - a deposit gets its row only once claimed. Now a pending deposit
// makes its federation held, a held federation's wallet opens from the invite it was last opened with when no status names one, and
// the per-federation (debug) deposit keeps its wallet with the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFederations, rememberedInvite } from '../src/page-lock.js';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m }; };
const B = 'b18947f085d40df3ce4bc8ac64df9c45256223e88fe7fdbdebf3eae13fb10b73', A = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e';

test('a federation with only a pending deposit is held; ledger and pending together are listed once', () => {
  const s = store();
  assert.deepEqual(ledgerFederations(s), []);
  s.setItem('arena.deposit.pending.' + B, JSON.stringify([{ operation: 'op1', invoice: 'lntb10u1x', msat: '1000000' }]));
  assert.deepEqual(ledgerFederations(s), [B], 'the pending deposit alone makes B held');
  s.setItem('arena.ledger.' + A, '[]'); s.setItem('arena.ledger.' + B, '[]');
  assert.deepEqual(ledgerFederations(s).sort(), [A, B].sort(), 'each once');
  s.setItem('arena.deposit.pending.nothex', '[]');
  assert.equal(ledgerFederations(s).length, 2, 'a key that is not a federation id is not one');
});

test('the invite a wallet was opened with is remembered, and the page falls back on it; the debug deposit keeps its wallet', () => {
  const s = store();
  assert.equal(rememberedInvite(s, B), null);
  s.setItem('arena.federation.invite.' + B, 'fed1invite');
  assert.equal(rememberedInvite(s, B), 'fed1invite');
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /\(st && st\.invite\) \|\| \(ARENACLIENT\.rememberedInvite \? ARENACLIENT\.rememberedInvite\(vault\(\), fid\) : null\)/);
  assert.match(html, /if \(offer\.client && window\.ARENA_KEEP_WALLET\) window\.ARENA_KEEP_WALLET\(String\(fixed\.federation\)\.toLowerCase\(\), offer\.client\);/);
  const src = readFileSync(new URL('../src/page-lock.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!ancestor\) rememberInvite\(storage, federationId, invite\);/, 'openPlayerWallet remembers it');
});

test('a deposit the current wallet does not hold ("Operation not found") is claimed in the other kept wallet that made it', async () => {
  const { resumeDeposits, pendingDeposits } = await import('../src/page-lock.js');
  const s = store();
  s.setItem('arena.deposit.pending.' + B, JSON.stringify([{ operation: '3d41502f316a', invoice: 'lntb10u1x', msat: '1000000' }]));
  const claimed = [];
  const notHere = { awaitReceive: async () => { throw new Error('Operation not found'); } };
  const otherEmpty = { label: 'aaaa0000', client: { awaitReceive: async () => { throw new Error('Operation not found'); } } };
  const otherMade = { label: 'b1e00767', client: { awaitReceive: async (op) => (op === '3d41502f316a' ? 'Claimed' : 'Failure') } };
  const finals = await resumeDeposits({ client: notHere, storage: s, federationId: B, onClaimed: (d) => claimed.push(d), others: async () => [otherEmpty, otherMade] });
  assert.deepEqual(finals, ['Claimed (in wallet b1e00767)']);
  assert.equal(claimed.length, 1); assert.equal(claimed[0].from.label, 'b1e00767', 'the page sweeps from that wallet');
  assert.deepEqual(pendingDeposits(s, B), [], 'the entry is done');
  const none = await resumeDeposits({ client: notHere, storage: (() => { const t = store(); t.setItem('arena.deposit.pending.' + B, JSON.stringify([{ operation: 'zz', invoice: 'x', msat: '1' }])); return t; })(), federationId: B, others: async () => [otherEmpty] });
  assert.match(none[0], /^unknown \(operation zz: Operation not found\)$/, 'no wallet holds it: said, and the entry stays for the next page');
});
