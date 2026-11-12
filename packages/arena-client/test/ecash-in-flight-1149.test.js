// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// E-CASH IN FLIGHT (kanban #1149, the 2026-11-06 state-machine audit): bearer notes existed only in memory after the send. The exchange POSTed
// the same string to each seat in turn until one answered OK (every seat that answered 4xx kept a spendable copy), wrote its record only after
// the send (a full browser lost the notes), dropped the record on any receive answer, and never compared what came back with what was sent.
// Each case is that scenario or one of its guards, run through the page's own ARENA_EXCHANGE_INTO (ecash-1149-rig.js) or ecash-transfer.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeRig, payingSeat, refusingSeat, encodeEcash, A, B } from './ecash-1149-rig.js';
import { ecashTransferStep, moveEcashTransfer, readEcashTransfer, sendKeptEcash, recoverEcashIntent, receiveKeptEcash, advanceEcashExchange,
  ecashFaceValue, ecashTransferMsatInFlight, ECASH_HANDED_RECLAIM_MS } from '../src/ecash-transfer.js';

const NEED = 100000n;
const total = (r) => r.bal.get(A) + r.bal.get(B) + r.unreceived();

test('THE SCENARIO: three seats, the first offers nothing, the second refuses - each bearer string reaches exactly one seat, and none is left with a copy', async () => {
  const r = exchangeRig({ seats: { 'http://s1': refusingSeat({}), 'http://s2': refusingSeat({ [B]: '500000' }), 'http://s3': payingSeat({ [B]: '500000' }) } });
  const before = total(r);
  const said = await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s1', 'http://s2', 'http://s3'] });
  assert.equal(said.ok, true, said.why);
  for (const [ecash, at] of r.seen) assert.equal(at.length, 1, `the string ${ecash.slice(0, 20)}... was handed to ${at.join(', ')}`);
  assert.ok(![...r.seen.values()].flat().includes('http://s1'), 'a seat whose offer does not cover it is handed nothing');
  const atS2 = [...r.seen].find(([, at]) => at[0] === 'http://s2');
  assert.ok(atS2 && !r.live.has(atS2[0]), 'the refusing seat\'s copy was taken back (reissued into the wallet): it can spend nothing');
  assert.equal(r.bal.get(B), NEED, 'the round\'s federation holds the exchanged amount');
  assert.equal(total(r), before, 'nothing created or lost');
  assert.deepEqual(r.kept(), [], 'nothing kept once received in full');
});

test('the browser refuses the write after the send (storage full): the notes are taken back into the wallet, never lost', async () => {
  const r = exchangeRig({ seats: { 'http://s1': payingSeat({ [B]: '500000' }) }, failWrite: (k, v) => k.startsWith('arena.ecash.exchange.') && v.includes('fedimint') });
  const before = r.bal.get(A);
  let said; try { said = await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s1'] }); } catch (e) { said = { ok: false, threw: e.message }; }
  assert.equal(said.ok, false);
  assert.equal(r.bal.get(A), before, `the notes are back in the wallet they left (${said.threw || said.why})`);
  assert.equal(r.unreceived(), 0n, 'no bearer string left anywhere');
  assert.equal(r.seen.size, 0, 'nothing handed to a seat that could not be written first');
});

test('a browser that cannot write the intent sends nothing', async () => {
  const r = exchangeRig({ seats: { 'http://s1': payingSeat({ [B]: '500000' }) }, failWrite: (k) => k.startsWith('arena.ecash.exchange.') });
  const said = await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s1'] });
  assert.equal(said.ok, false);
  assert.match(said.why, /nothing sent/);
  assert.deepEqual(r.log, [], 'the wallet was never asked to send');
});

test('a seat that pays less than it was handed: received, and the record stays as the evidence (short) - never dropped as done', async () => {
  for (const msatInReceive of [false, true]) {
    const r = exchangeRig({ seats: { 'http://s1': payingSeat({ [B]: '500000' }, 30000n) }, msatInReceive });
    const said = await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s1'] });
    assert.equal(r.bal.get(B), NEED - 30000n);
    const kept = r.kept();
    assert.equal(kept.length, 1, `the short exchange is kept (${msatInReceive ? 'the receive says the amount' : 'the string\'s face value read'})`);
    assert.equal(kept[0].state, 'short');
    assert.equal(kept[0].creditedMsat, String(NEED - 30000n));
    assert.equal(kept[0].agreedMsat, String(NEED));
    assert.equal(said.short, true);
  }
});

test('a seat that took the notes and did not answer: asked again later, the same seat only, with the same notes; its answer received', async () => {
  let calls = 0;
  const flaky = payingSeat({ [B]: '500000' });
  const post = flaky.post;
  const took = new Map();
  flaky.post = async (b, tools) => {
    calls++;
    if (calls === 1) { took.set(b.ecash, tools.take(b.ecash)); return { status: 503, body: 'the payout failed; ask again' }; }
    const n = took.get(b.ecash);
    if (n) return { status: 200, body: { ok: true, msat: String(n.msat), ecash: tools.mint(b.to, n.msat) } };
    return post(b, tools);
  };
  const r = exchangeRig({ seats: { 'http://s1': flaky, 'http://s2': payingSeat({ [B]: '500000' }) } });
  const first = await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s1', 'http://s2'] });
  assert.equal(first.ok, false);
  assert.equal(r.kept().length, 1);
  assert.equal(r.kept()[0].state, 'handed');
  assert.equal(r.kept()[0].seat, 'http://s1');
  assert.ok(!r.log.some((x) => x[0] === 'receive' && x[1] === '33'), 'never taken back while the one seat may hold it');
  assert.equal(r.seen.size, 1, 'not handed to a second seat');
  await r.exchange({ to: B, needMsat: NEED, nodes: ['http://s2', 'http://s1'] });
  const handed = [...r.seen.values()][0];
  assert.deepEqual(handed, ['http://s1', 'http://s1'], 'the kept exchange asked its own seat again, and no other seat');
  assert.equal(r.bal.get(B), 2n * NEED, 'the kept exchange and the new one both received');
  assert.deepEqual(r.kept(), []);
});

test('a silent seat past ten minutes: the notes are taken back; if the seat took them (Rejected) the record goes back to asking it', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const put = (s, k, v) => s.setItem(k, v);
  const ecash = encodeEcash(A, NEED, 9);
  const key = 'arena.ecash.exchange.1.0';
  for (const [state, next] of [['Success', null], ['Rejected', 'handed']]) {
    const rec = { v: 3, state: 'handed', kind: 'exchange', from: A, to: B, msat: String(NEED), ecash, seat: 'http://s1', handedAtMs: 0 };
    storage.setItem(key, JSON.stringify(rec));
    const walletFrom = { receiveEcash: async () => JSON.stringify({ state }) };
    const fetcher = async () => { throw new Error('the seat did not answer'); };
    const r = await advanceEcashExchange({ storage, key, rec, walletFrom, walletTo: async () => null, fetcher, nowMs: ECASH_HANDED_RECLAIM_MS + 1, put });
    const after = readEcashTransfer(storage, key);
    assert.equal(after ? after.state : null, next, state);
    if (next) { assert.equal(after.seatTook, true); assert.equal(r.pending, true); } else assert.equal(r.reclaimed, true);
  }
});

// kanban #1583: a seat's 4xx is not proof it took nothing (a restarted seat answered 409 for a row it had taken) - a Rejected take-back after a
// refusal goes back to asking that same seat (handed, seatTook), never the terminal `refused`; a later refusal is not taken back from again
test('a seat that refused and whose notes are spent anyway: kept handed to that seat (it may hold them), naming it - not handed to another', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const key = 'arena.ecash.exchange.2.0';
  const rec = { v: 3, state: 'handed', kind: 'exchange', from: A, to: B, msat: String(NEED), ecash: encodeEcash(A, NEED, 3), seat: 'http://s1', handedAtMs: 0 };
  storage.setItem(key, JSON.stringify(rec));
  const fetcher = async () => ({ ok: false, status: 409, text: async () => 'too little' });
  const r = await advanceEcashExchange({ storage, key, rec, walletFrom: { receiveEcash: async () => '{"state":"Rejected"}' }, walletTo: async () => null, fetcher, put: (s, k, v) => s.setItem(k, v) });
  assert.equal(r.pending, true);
  const after = readEcashTransfer(storage, key);
  assert.deepEqual([after.state, after.seat, after.seatTook], ['handed', 'http://s1', true]);
  let asked = 0;
  const again = await advanceEcashExchange({ storage, key, rec: after, walletFrom: { receiveEcash: async () => { asked++; return '{"state":"Rejected"}'; } }, walletTo: async () => null, fetcher, put: (s, k, v) => s.setItem(k, v) });
  assert.equal(again.pending, true); assert.equal(asked, 0, 'not taken back from twice');
  assert.equal(readEcashTransfer(storage, key).state, 'handed');
});

test('an intent left by a closed tab: the 2.0 lock client\'s log gives the string back; no send in its log - dropped; an older client - kept, named', async () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const put = (s, k, v) => s.setItem(k, v);
  const ecash = encodeEcash(A, 7000n, 5);
  const sent = new Map();
  const wallet = { sendAllEcash: async (intent) => { sent.set(intent, { ecash, msat: 7000 }); throw new Error('the tab closed'); }, sentEcash: async (i) => JSON.stringify(sent.get(i) || null),
    receiveEcash: async () => JSON.stringify({ state: 'Success', msat: 7000 }) };
  // the send happened and the page never heard of it: the wallet's log keeps the string under the record's key
  const s = await sendKeptEcash({ storage, key: 'arena.ecash.pending.k1', wallet, fields: { kind: 'merge', fed: A, msat: '0' }, put });
  assert.equal(s.sent, true, s.why);
  assert.equal(readEcashTransfer(storage, 'arena.ecash.pending.k1').state, 'kept');
  // an intent written, the tab gone before the wallet answered
  storage.setItem('arena.ecash.pending.k2', JSON.stringify({ v: 3, state: 'intent', kind: 'merge', fed: A, msat: '0' }));
  sent.set('arena.ecash.pending.k2', { ecash: encodeEcash(A, 3000n, 6), msat: 3000 });
  const back = await recoverEcashIntent({ storage, key: 'arena.ecash.pending.k2', rec: readEcashTransfer(storage, 'arena.ecash.pending.k2'), wallet, put });
  assert.equal(back.rec.state, 'kept');
  assert.equal(ecashTransferMsatInFlight(back.rec), 3000n, 'counted once it is kept');
  storage.setItem('arena.ecash.pending.k3', JSON.stringify({ v: 3, state: 'intent', kind: 'merge', fed: A, msat: '0' }));
  const none = await recoverEcashIntent({ storage, key: 'arena.ecash.pending.k3', rec: readEcashTransfer(storage, 'arena.ecash.pending.k3'), wallet, put });
  assert.equal(none.nothing, true);
  assert.equal(storage.getItem('arena.ecash.pending.k3'), null);
  storage.setItem('arena.ecash.pending.k4', JSON.stringify({ v: 3, state: 'intent', kind: 'merge', fed: A, msat: '0' }));
  const old = await recoverEcashIntent({ storage, key: 'arena.ecash.pending.k4', rec: readEcashTransfer(storage, 'arena.ecash.pending.k4'), wallet: { }, put });
  assert.equal(old.unknown, true);
  assert.equal(readEcashTransfer(storage, 'arena.ecash.pending.k4').state, 'intent', 'kept, and never counted as money');
  assert.equal(ecashTransferMsatInFlight(readEcashTransfer(storage, 'arena.ecash.pending.k4')), 0n);
});

test('a kept copy is dropped only on Success/AlreadyReceived crediting at least what was sent; Rejected is kept as refused', async () => {
  const ecash = encodeEcash(A, 5000n, 2);
  for (const [said, left] of [[{ state: 'Success' }, null], [{ state: 'AlreadyReceived' }, null], [{ state: 'Rejected' }, 'refused'], [{ state: 'Success', msat: 4000 }, 'short']]) {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    const rec = { v: 3, state: 'kept', ecash, msat: '5000', fed: A };
    storage.setItem('k', JSON.stringify(rec));
    await receiveKeptEcash({ storage, key: 'k', rec, receive: async () => JSON.stringify(said), federation: A, put: (s, k, v) => s.setItem(k, v) });
    const after = readEcashTransfer(storage, 'k');
    assert.equal(after ? after.state : null, left, JSON.stringify(said));
  }
});

test('one transition function: each step guarded; a record another tab moved is not overwritten', () => {
  assert.equal(ecashTransferStep(null, 'intent').state, 'intent');
  assert.throws(() => ecashTransferStep(null, 'kept'), /none -> intent, not -> kept/);
  assert.throws(() => ecashTransferStep({ state: 'intent' }, 'handed'), /not -> handed/);
  assert.throws(() => ecashTransferStep({ state: 'refused' }, 'none'), /refused -> nowhere/);
  assert.throws(() => ecashTransferStep({ state: 'short' }, 'none'), /short -> nowhere/);
  assert.equal(ecashTransferStep({ state: 'answered' }, 'none'), null);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const rec = { v: 3, state: 'kept', ecash: 'fedimint00', msat: '1' };
  storage.setItem('k', JSON.stringify(rec));
  storage.removeItem('k');   // another tab received it
  assert.throws(() => moveEcashTransfer(storage, 'k', rec, 'refused', {}, (s, k, v) => s.setItem(k, v)), /moved under this step/);
  assert.equal(storage.getItem('k'), null, 'the removal another tab made stands');
});

test('the string\'s face value and federation, read from the mintv2 encoding; anything else is unreadable', () => {
  const f = ecashFaceValue(encodeEcash(B, 123457n, 4));
  assert.equal(f.msat, 123457n);
  assert.equal(f.federation, B);
  assert.equal(f.notes, 7, '123457 msat is seven powers of two');
  assert.equal(ecashFaceValue('fedimint0123'), null);
  assert.equal(ecashFaceValue('notes-from-seat'), null);
  // an older page's records: a merge's kept, an exchange's taken back first (its seats are unknown)
  const store = new Map([['arena.ecash.pending.1.x', JSON.stringify({ ecash: 'e', msat: '1' })], ['arena.ecash.exchange.1', JSON.stringify({ ecash: 'e', msat: '1', from: A, to: B })]]);
  const storage = { getItem: (k) => store.get(k) ?? null };
  assert.equal(readEcashTransfer(storage, 'arena.ecash.pending.1.x').state, 'kept');
  assert.equal(readEcashTransfer(storage, 'arena.ecash.exchange.1').state, 'reclaiming');
});
