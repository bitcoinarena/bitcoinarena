// kanban #1489 sm8-page-3: TWO TABS RECEIVING ONE KEPT MERGE STRING: THE ONE THAT LOST THE RACE WRITES THE RECORD "REFUSED" OVER A RECEIVE THAT SUCCEEDED.
// SM-C1 (e-cash in flight, merge): a kept string (arena.ecash.pending.*) with no `to` - a deposit swept from another phrase's wallet, or
// one whose `to` is older than 2 minutes - is received by ANY tab's merge in that federation (index.html receiveKeptPass), into that tab's
// own wallet. Two tabs restored together (a browser restart) both run it. receiveKeptEcash takes no hold on the record across the receive:
// tab A's receive answers Success and A waits in `settle` (up to 5 s for its balance to show it) before it removes the record; tab B's receive
// of the same notes answers Rejected (spent - by tab A) and B's compare-and-set still finds the record 'kept', so B writes it 'refused':
// "the kept notes were spent elsewhere", final, kept as evidence. A's removal then finds the record moved and does nothing.
// Invariant: a record ends 'refused' only when its notes went to nobody of this browser; one received in full is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendKeptEcash, receiveKeptEcash, readEcashTransfer, ECASH_PENDING_PREFIX } from '../src/ecash-transfer.js';

const mem = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
};

test('two tabs receive one kept merge string: the Success tab\'s money is not recorded as spent elsewhere', async () => {
  const L = mem();
  const key = `${ECASH_PENDING_PREFIX}${'ab'.repeat(8)}.${Date.now()}.cafe0001`;
  const ECASH = 'fedimint' + 'q'.repeat(60);
  // the other phrase's wallet that sent its notes (the deposit resume's sweep): intent, then kept
  const from = { sendAllEcash: async () => JSON.stringify({ ecash: ECASH, msat: '5000000' }) };
  const sent = await sendKeptEcash({ storage: L, key, wallet: from, fields: { kind: 'merge', msat: '0', from: 'cafe0001', fromKey: 'cafe0001cafe0001', fed: 'ab'.repeat(32) } });
  assert.equal(sent.sent, true);
  let spent = false;
  // tab A's wallet takes the notes; tab B's wallet then finds them spent
  const walletA = { receiveEcash: async () => { spent = true; return JSON.stringify({ state: 'Success', msat: '5000000' }); } };
  const walletB = { receiveEcash: async () => { await new Promise((r) => setTimeout(r, 20)); return JSON.stringify({ state: spent ? 'Rejected' : 'Success', msat: '5000000' }); } };
  const recA = readEcashTransfer(L, key), recB = readEcashTransfer(L, key);   // each tab's pass read the kept record
  const [a, b] = await Promise.all([
    receiveKeptEcash({ storage: L, key, rec: recA, receive: (e) => walletA.receiveEcash(e), federation: 'ab'.repeat(32),
      settle: () => new Promise((r) => setTimeout(r, 200)) }),           // tab A waits for its balance to show the notes
    receiveKeptEcash({ storage: L, key, rec: recB, receive: (e) => walletB.receiveEcash(e), federation: 'ab'.repeat(32) }),
  ]);
  const left = readEcashTransfer(L, key);
  console.log('  FACTS:', JSON.stringify({ a: { ok: a.ok, state: a.state }, b: { ok: b.ok, state: b.state, refused: b.refused }, left: left && left.state, why: left && left.why }));
  assert.equal(a.ok, true, 'tab A received the notes');
  assert.equal(left, null, `the notes are in tab A's wallet, and the record is kept as "${left && left.state}": ${left && left.why}`);
});

test('kanban #2212: a receive that throws gives its claim back; a claim of a closed tab is taken over once 5 min old', async () => {
  const L = mem();
  const key = `${ECASH_PENDING_PREFIX}${'ab'.repeat(8)}.${Date.now()}.cafe0002`;
  const ECASH = 'fedimint' + 'q'.repeat(60);
  await sendKeptEcash({ storage: L, key, wallet: { sendAllEcash: async () => JSON.stringify({ ecash: ECASH, msat: '5000000' }) }, fields: { kind: 'merge', msat: '0', fed: 'ab'.repeat(32) } });
  const t = await receiveKeptEcash({ storage: L, key, rec: readEcashTransfer(L, key), receive: async () => { throw new Error('no answer'); } });
  assert.equal(t.retry, true);
  assert.equal(readEcashTransfer(L, key).receivingAtMs, undefined, 'the claim is given back after a throw');
  // a tab that closed mid-receive: its claim stays
  let n = 0;
  const hung = receiveKeptEcash({ storage: L, key, rec: readEcashTransfer(L, key), receive: () => { n++; return new Promise(() => {}); }, nowMs: () => 1000 });
  void hung;
  const busy = await receiveKeptEcash({ storage: L, key, rec: readEcashTransfer(L, key), receive: async () => { n++; return '{}'; }, nowMs: () => 1000 + 60000 });
  assert.equal(busy.busy, true); assert.equal(n, 1, 'a fresh claim: nothing received');
  const late = await receiveKeptEcash({ storage: L, key, rec: readEcashTransfer(L, key), nowMs: () => 1000 + 300000,
    receive: async () => { n++; return JSON.stringify({ state: 'Success', msat: '5000000' }); } });
  assert.equal(late.ok, true); assert.equal(n, 2); assert.equal(readEcashTransfer(L, key), null);
});
