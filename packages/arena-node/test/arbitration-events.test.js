// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET'S EVENTS (kanban #723, the owner 2026-10-27: liquidations and slashes in the explorer as their own events, with every payout
// and its transaction): signed by k of the set's members, kept by a seat only when they stand and are newer, listed at GET /liquidations and
// taken at POST /liquidations/events; T2's liquidation (rehearsal 17) as its event, every id and amount the card names; and the arbiter's
// pay keeping every remainder payee from now on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createArbitrationEvents, signEvent, eventStands, liquidationEvent, slashEvent, stampEvent, eventTxids, canonicalJson } from '../src/arbitration-events.js';
import { arbitrationMembers, memberSign } from '../src/arbiter.js';
import { createLiquidationClaims, payOutLiquidation } from '../src/liquidation-claims.js';
import { REGTEST_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const T2 = JSON.parse(readFileSync(new URL('./fixtures/t2-liquidation-723.json', import.meta.url), 'utf8'));
const set = arbitrationMembers('regtest');
const tn4 = arbitrationMembers('testnet4');
const g = genesisFor('regtest');

const t2Event = (atMs = T2.firstMs + 1000) => ({ ...liquidationEvent({ network: 'testnet4', fid: T2.federation, v: T2.state, claims: T2.claims, escrowAt: T2.escrowAt, into: T2.into }),
  firstMs: T2.firstMs, atMs });

test('T2\'s liquidation as its event: the escrow, the 47 notes paid to one key, the remainder to 42 nodes and the donation set - every id and amount', () => {
  const e = t2Event();
  assert.equal(e.status, 'paid out');
  assert.deepEqual([e.federation.slice(0, 8), e.halt.height, e.halt.proof.session, e.halt.proof.observers], ['9919a571', 157476, 783, 27]);
  assert.deepEqual([e.escrow.txid.slice(0, 8), e.escrow.sats, e.escrow.claimedMsat, e.escrow.into.slice(0, 8), e.escrow.outpoint.slice(0, 8)],
    ['d96364ec', '47000', '44999680', '337ae01a', 'b6464f0e']);
  assert.deepEqual([e.claims.accepted.length, e.claims.msat, new Set(e.claims.accepted.map((c) => c.payoutPk)).size, e.claims.refused.length], [47, '28994560', 1, 0]);
  assert.deepEqual(e.payouts.map((p) => [p.txid.slice(0, 8), p.msat, p.outIdx, p.federation.slice(0, 8)]), [['a6c8636f', '28994560', 0, '337ae01a']]);
  const r = e.remainder;
  assert.deepEqual([r.txid.slice(0, 8), r.msat, r.payees, r.payouts.length], ['1f107491', '15994608', 44, 44]);
  const nodes = r.payouts.filter((p) => p.part === 'node'), dev = r.payouts.filter((p) => p.part === 'donation');
  assert.deepEqual([nodes.length, new Set(nodes.map((p) => p.msat)).size, nodes[0].msat], [42, 1, '285618']);
  assert.deepEqual(dev.map((p) => p.msat).sort(), ['1332750', '2665902']);
  assert.equal(r.payouts.reduce((t, p) => t + BigInt(p.msat), 0n), 15994608n);
  assert.deepEqual(r.payouts.map((p) => p.outIdx), Array.from({ length: 44 }, (_, i) => i), 'each payee at its own output, in order');
  assert.deepEqual(eventTxids(e).map((x) => x.slice(0, 8)).sort(), ['1f107491', 'a6c8636f', 'b6464f0e', 'd96364ec']);
});

test('an event stands with k signatures of the set; fewer, a stranger\'s, another network\'s or a changed body do not', () => {
  const said = signEvent(t2Event(), set, memberSign);
  assert.equal(said.signatures.length, g.arbitrationK);
  const keys = g.arbitrationKeys;
  assert.deepEqual(eventStands(said, { keys, k: g.arbitrationK, verify }), { ok: true, signers: 5 });
  assert.match(eventStands({ ...said, signatures: said.signatures.slice(0, 4) }, { keys, k: 5, verify }).why, /4 valid signatures .* needs 5/);
  const twice = { ...said, signatures: [...said.signatures.slice(0, 4), said.signatures[0]] };
  assert.equal(eventStands(twice, { keys, k: 5, verify }).ok, false, 'one member twice counts once');
  assert.equal(eventStands(signEvent(t2Event(), tn4, memberSign), { keys, k: 5, verify }).ok, false, 'testnet4\'s set is not regtest\'s');
  const changed = { ...said, event: { ...said.event, remainder: { ...said.event.remainder, msat: '1' } } };
  assert.match(eventStands(changed, { keys, k: 5, verify }).why, /0 valid signatures/);
  assert.match(eventStands({ event: { kind: 'order' } }, { keys, k: 5, verify }).why, /liquidation, slash/);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test('a seat keeps the newest version of each event across restarts, an older one is not taken over it, and lists them by kind', () => {
  let saved = [];
  const book = () => createArbitrationEvents({ keys: g.arbitrationKeys, k: g.arbitrationK, verify, load: () => saved, save: (rows) => { saved = rows; } });
  const a = book();
  assert.deepEqual([a.offer(signEvent(t2Event(2000), set, memberSign)).kept, a.offer(signEvent(t2Event(1000), set, memberSign)).kept], [true, false]);
  const slash = { ...slashEvent({ network: 'regtest', proof: 'cd'.repeat(32), v: { posted: 'ef'.repeat(32), node: 'aa'.repeat(32), round: '11'.repeat(32), entry: '22'.repeat(32),
    slashHeight: 900, signers: 5, bondSats: '100000', playersSats: '60000', nodesSats: '30000', developersSats: '10000', escrowTxid: '33'.repeat(32), pegInSats: '59000', claimedMsat: '58000000',
    payouts: [{ round: '11'.repeat(32), entry: '22'.repeat(32), refundPk: '02' + '44'.repeat(32), msat: '58000000', txid: '55'.repeat(32), outIdx: 0 }] } }), firstMs: 500, atMs: 3000 };
  assert.equal(a.offer(signEvent(slash, set, memberSign)).kept, true);
  assert.equal(a.offer({ event: slash, signatures: [] }).ok, false);
  const b = book();                                         // the seat restarted
  assert.deepEqual(b.list().map((r) => [r.event.kind, r.event.atMs]), [['slash', 3000], ['liquidation', 2000]]);
  assert.deepEqual(b.list({ kind: 'liquidation' }).map((r) => r.event.federation.slice(0, 8)), ['9919a571']);
  assert.deepEqual([slash.status, slash.sats.bond, eventTxids(slash).length], ['paid out', '100000', 3]);
  assert.equal(createArbitrationEvents({ keys: [], k: 5, verify }).offer(signEvent(slash, set, memberSign)).status, 503, 'no set for its chain: nothing taken');
});

test('the arbiter\'s times: firstMs once, atMs moved only when the event changed', () => {
  const kept = {};
  const a = stampEvent({ kind: 'liquidation', federation: 'ab'.repeat(32), status: 'claims open' }, kept, 100);
  const b = stampEvent({ kind: 'liquidation', federation: 'ab'.repeat(32), status: 'claims open' }, kept, 200);
  const c = stampEvent({ kind: 'liquidation', federation: 'ab'.repeat(32), status: 'paid out' }, kept, 300);
  assert.deepEqual([a.changed, b.changed, c.changed, b.event.atMs, c.event.atMs, c.event.firstMs], [true, false, true, 100, 300, 100]);
});

test('the remainder\'s payees are kept with their part and output, and each step with its time - not only the count', async () => {
  const FED = 'ab'.repeat(32), P1 = '02' + '11'.repeat(32);
  let tip = 1012;
  const claims = createLiquidationClaims({ validate: async () => ({ ok: true, notes: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 512000n }], amountMsat: 512000n }),
    liquidationOf: async () => ({ federation: FED, haltHeight: 1000, liquidatesAt: 1010, claimWindowCloses: 1020, lateClaimsUntil: 1100, spentNonces: [] }),
    height: async () => tip, escrowMsatOf: async () => 2_000_000n, clocks: REGTEST_CLOCKS });
  await claims.offer({ federation: FED, ecash: 'e', payoutPk: P1 });
  assert.deepEqual(claims.claimed(FED).map((c) => [c.amountMsat, c.payoutPk]), [['512000', P1]]);
  const v = {};
  const run = async (args) => {
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 2_000_000 };
    if (args[1] === 'pay') return { txid: 'f'.repeat(64), payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) };
    if (args[1] === 'balance') return { msat: 1_500_000 };
    return {}; };
  const remainderPayees = async (_fid, msat) => [{ key: '02' + 'aa'.repeat(32), msat: (msat * 75n) / 100n, part: 'node' }, { key: '03' + 'dd'.repeat(32), msat: msat - (msat * 75n) / 100n, part: 'donation' }];
  const pass = () => payOutLiquidation({ fid: FED, v, claims, height: async () => tip, run, spendEscrow: async () => ({ txid: 'e'.repeat(64), sats: '2000' }), remainderPayees });
  tip = 1021; await pass();
  tip = 1100; await pass();
  assert.deepEqual([v.escrowSats, Number.isFinite(v.escrowAtMs), Number.isFinite(v.claimedAtMs), Number.isFinite(v.payouts[0].atMs), Number.isFinite(v.remainderAtMs)], ['2000', true, true, true, true]);
  assert.deepEqual(v.remainderPayouts.map((p) => [p.part, p.payoutPk.slice(0, 4), p.msat, p.outIdx]), [['node', '02aa', '1116000', 0], ['donation', '03dd', '372000', 1]]);
  const e = liquidationEvent({ network: 'regtest', fid: FED, v, claims: claims.claimed(FED) });
  assert.deepEqual([e.status, e.remainder.payees, e.remainder.payouts.length, e.escrow.sats], ['paid out', 2, 2, '2000']);
});

test('a seat takes an event at POST /liquidations/events, lists it at GET /liquidations, keeps it beside its database, and refuses a forged one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-events-'));
  const path = join(dir, 'seat.db');
  const start = () => serve(openStore(path), { port: 0, genesis: g });
  let seat = await start();
  try {
    const post = (body) => fetch(`http://127.0.0.1:${seat.port}/liquidations/events`, { method: 'POST', body: JSON.stringify(body) });
    const said = signEvent(t2Event(), set, memberSign);
    const r = await post(said);
    assert.equal(r.status, 201);
    assert.equal((await post(said)).status, 200, 'the same event again: held already');
    const forged = await post({ ...said, signatures: said.signatures.slice(0, 2) });
    assert.equal(forged.status, 422);
    assert.match(await forged.text(), /2 valid signatures/);
    const list = async () => (await (await fetch(`http://127.0.0.1:${seat.port}/liquidations`)).json()).events;
    const [held] = await list();
    assert.deepEqual([held.event.kind, held.event.remainder.payouts.length, held.signatures.length], ['liquidation', 44, 5]);
    assert.ok(existsSync(`${path}.arbitration-events.json`), 'kept beside the database');
    await seat.close();
    seat = await start();
    assert.deepEqual((await list()).map((x) => x.event.remainder.txid.slice(0, 8)), ['1f107491'], 'kept across a restart');
  } finally { await seat.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('T2\'s state completed once from the payees rebuilt at the payment\'s height: their sum must be the remainder paid, their count the one kept', async () => {
  const { completeLiquidation } = await import('../tools/liquidation-record.mjs');
  const raw = () => { const v = JSON.parse(JSON.stringify(T2.state)); for (const k of ['remainderPayouts', 'escrowSats', 'escrowAtMs', 'claimedAtMs', 'remainderAtMs', 'halt']) delete v[k];
    for (const p of v.payouts) delete p.atMs; return { handled: {}, liquidations: { [T2.federation]: v } }; };
  const got = { height: 157699, payees: T2.state.remainderPayouts.map((p) => ({ part: p.part, key: p.payoutPk, msat: p.msat, outIdx: p.outIdx })) };
  const s = raw();
  const did = completeLiquidation(s, T2.federation, got, { escrowSats: '47000', first: '2026-10-24T19:37:24Z', escrowAt: '2026-10-24T19:37:24Z', claimedAt: '2026-10-26T21:48:58Z',
    paidAt: '2026-10-26T21:48:58Z', remainderAt: '2026-10-26T22:46:00Z' });
  assert.equal(did.length, 7);
  const v = s.liquidations[T2.federation];
  assert.deepEqual(v.remainderPayouts, T2.state.remainderPayouts);
  assert.deepEqual([v.escrowSats, v.claimedAtMs, s.events[`liquidation:${T2.federation}`].firstMs], ['47000', T2.state.claimedAtMs, T2.firstMs]);
  assert.deepEqual(completeLiquidation(s, T2.federation, got, { escrowSats: '1' }), [], 'only what the state lacks: run twice, nothing more');
  assert.throws(() => completeLiquidation(raw(), T2.federation, { payees: got.payees.slice(1) }), /payees come to 15708990 msat, and the remainder paid was 15994608/);
});
