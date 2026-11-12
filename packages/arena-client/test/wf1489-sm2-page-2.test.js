// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 page-2: AN E-CASH EXCHANGE LEFT BY ONE PHRASE'S TAB IS FINISHED INTO ANOTHER PHRASE'S WALLET.
//
// Two tabs of one browser are two players (two phrases; kanban #1220 keyed the payout notes by phrase for exactly this). The exchange
// records (arena.ecash.exchange.<ms>.<i>, localStorage, shared by every tab) name no phrase: ARENA_EXCHANGE_INTO resumes EVERY kept
// record first, opening `walletFor(fid)` - the asking tab's own wallets (openW over the tab's seed). Tab A (phrase P1) hands 50,000 msat of
// its notes to a seat that does not answer in time; tab A is still open and holds P1 (its Web Lock arena.phrase.<P1>, which the merge
// honours: it never takes a phrase another tab holds). Tab B (phrase P2) asks for an exchange of its own, resumes A's record without any
// phrase lock, and the seat's e-cash for P1's notes is received into P2's wallet (a 'reclaiming' record is taken back into P2's
// from-wallet the same way). The record is then removed: P1's 50 sat now sit in P2's wallet while P1's tab is still playing, and
// nothing in the browser says P1 is owed them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEcashInto, resumeEcashExchanges, readEcashTransfer, ECASH_EXCHANGE_PREFIX } from '../src/ecash-transfer.js';

const FROM = 'aa'.repeat(32), TO = 'bb'.repeat(32);
function shared() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}
/** One phrase's wallet in one federation: what it sent and what it received. */
const wallet = (name) => {
  const w = { name, received: [], sent: 0 };
  w.sendEcash = async (msat) => { w.sent += Number(msat); return JSON.stringify({ msat: Number(msat), ecash: `fedimint-${name}-notes` }); };
  w.receiveEcash = async (ecash) => { w.received.push(ecash); return JSON.stringify({ state: 'Success', msat: 50000 }); };
  return w;
};

test('tab B (another phrase) resumes tab A\'s exchange and the seat\'s e-cash for A\'s notes lands in B\'s wallet', async () => {
  const L = shared();
  const A = { [FROM]: wallet('P1-from'), [TO]: wallet('P1-to') };
  const B = { [FROM]: wallet('P2-from'), [TO]: wallet('P2-to') };
  let seatAnswers = false;
  const fetcher = async (url, o = {}) => {
    if (!o.method) return new Response(JSON.stringify({ holds: { [TO]: '10000000' }, maxMsat: '10000000' }), { status: 200 });   // GET /exchange: the offer
    if (!seatAnswers) throw new Error('The operation was aborted due to timeout');   // tab A's POST: the seat silent
    return new Response(JSON.stringify({ ecash: 'fedimint-seat-answer-for-P1', msat: '50000' }), { status: 200 });
  };
  // TAB A (phrase P1): its notes handed to the seat, no answer yet; the tab stays open (it resumes on its next exchange)
  const t0 = Date.now();
  const a = await exchangeEcashInto({ storage: L, from: FROM, to: TO, needMsat: 50000n, seats: ['http://seat.test'], walletFrom: A[FROM],
    walletTo: async () => A[TO], fetcher, nowMs: t0, timeoutMs: 50 });
  const key = [...L.m.keys()].find((k) => k.startsWith(ECASH_EXCHANGE_PREFIX));
  const afterA = { ok: a.ok, pending: a.pending, state: key && readEcashTransfer(L, key).state, P1sent: A[FROM].sent };
  // TAB B (phrase P2), a minute later: ARENA_EXCHANGE_INTO resumes every kept record with the tab's own wallets first
  seatAnswers = true;
  const said = await resumeEcashExchanges({ storage: L, keys: [...L.m.keys()], walletFor: async (fid) => B[fid], fetcher, seats: [], nowMs: t0 + 60000 });
  const facts = { afterA, resumedByB: said.map((r) => ({ ok: r.ok, msat: r.msat, why: r.why })), P2toReceived: B[TO].received, P1toReceived: A[TO].received,
    recordLeft: key ? L.getItem(key) !== null : null };
  console.log('  FACTS sm2-page-2:', JSON.stringify(facts));
  assert.equal(afterA.state, 'handed', 'precondition: tab A\'s notes are with the seat, the record handed');
  assert.equal(afterA.P1sent, 50000);
  // THE INVARIANT: what P1's notes bought is received into P1's wallet only - never into another phrase's
  assert.deepEqual(B[TO].received, [], `P1's exchange was received into P2's wallet: ${JSON.stringify(facts)}`);
  assert.deepEqual(B[FROM].received, []);
});
