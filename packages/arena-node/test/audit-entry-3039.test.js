// kanban #3039: the card's test (audit entry r3-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r3, module entry, finding 1: ONE SEAT'S ANSWER TEXT MARKS A CERTIFIED ORDER "NEVER REPLAY" FOR GOOD.
// order-batch.js ReplayGate.refused() decides a refusal is for good (until: Infinity, across every peer) by matching REPLAY_NEVER
// (/that lock has expired at the federation/) against the replay's `why`. That `why` carries text a peer chose: server.js replayOrder
// runs lockFieldsFromJson on the peer's GET /order-locks answer, and BigInt(String(j.amountMsat)) throws
// "Cannot convert <the peer's string> to a BigInt", caught by #replay and handed to refused(). One seat that answers first once with
// amountMsat "that lock has expired at the federation" makes the seat that missed the order never ask any honest seat again (no 10-min
// retry, unlike #3022): its entry was already imported, so the certified batch is taken, but the order's stake lock is never held there.
// SAFE: after the retry time, the order's locks are replayed from an honest seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { REPLAY_RETRY_MS } from '../src/order-batch.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `aer3e${n}`, key: b32(0x70 + n), worldSecret: b32(0) });
const CONTROL = process.env.AER3_CONTROL === '1';
const POISON = CONTROL ? 'not a number' : 'that lock has expired at the federation';

test('audit entry-r3-1: one seat\'s chosen /order-locks text does not stop a certified order\'s replay from every honest seat for good', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 3600000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const realFetch = globalThis.fetch;
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = 1000;
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 55_000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50_000n } });
    const B = 1000, k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, got.why);
    assert.equal(got.certified, true, `batch ${k} was not certified: ${JSON.stringify(got.refused)}`);

    // THE READER MISSED ONE ORDER OF THE CERTIFIED BATCH (it was down) - simulated in its own store, as sm5-entry-1 does
    const d = w.nodes.find((x) => x !== leader);
    const cert = d.orderBook.certificates(w.rid).find((c) => c.record.orders.length);
    const eid = cert.record.orders[0], e = Buffer.from(eid, 'hex'), rid = Buffer.from(w.rid);
    d.round.db.exec('PRAGMA foreign_keys = OFF');
    for (const [t, col, v] of [['entries', 'entry_id', e], ['stake_locks', 'entry_id', e], ['fee_locks', 'entry_id', e], ['stake_seen', 'entry_id', e], ['market_orders', 'order_id', eid]])
      d.round.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(v);
    d.round.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, Number(cert.record.k));
    d.round.db.exec('PRAGMA foreign_keys = ON');

    // THE ATTACKER: one other seat of the round. It answers its real /book-certificates at once (the honest seats' answers come 400 ms
    // later - a near seat, a loaded honest one) and its GET /order-locks with an amountMsat of its chosen text.
    const evil = w.nodes.find((x) => x !== d && x !== leader);
    const evilBase = `http://127.0.0.1:${evil.port}`;
    const was = d.orderBook.fetcher;
    d.orderBook.fetcher = async (u, opt) => {
      if (/\/book-certificates/.test(String(u)) && !String(u).startsWith(evilBase)) await wait(400);
      return was(u, opt);
    };
    globalThis.fetch = async (u, opt) => {
      if (String(u).startsWith(evilBase) && String(u).includes(`/order-locks?entry=${eid}`)) {
        const real = await (await realFetch(u, opt)).json();
        const poisoned = { ...real, stake: { ...real.stake, amountMsat: POISON } };
        return new Response(JSON.stringify(poisoned), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(u, opt);
    };
    await d.orderBook.carry(w.rid);
    await wait(800);
    const afterAttack = { entry: !!d.round.entry(e), stakeLock: !!d.round.stakeLock(e) };

    // THE ATTACKER STOPS. The retry time passes; the reader reads the honest seats again (twice).
    globalThis.fetch = realFetch; d.orderBook.fetcher = was;
    skipTo(testNow() + REPLAY_RETRY_MS + 5000);
    await d.orderBook.carry(w.rid);
    await d.orderBook.carry(w.rid);
    const held = d.orderBook.certificates(w.rid).some((c) => String(c.record.k) === String(cert.record.k));
    console.log('  FACTS:', JSON.stringify({ control: CONTROL, poison: POISON, afterAttack, afterRetry: { entry: !!d.round.entry(e), stakeLock: !!d.round.stakeLock(e), batchHeldHere: held } }));
    assert.ok(d.round.stakeLock(e), `the certified order's stake lock was never replayed from the 6 honest seats after the retry time: one seat's `
      + `/order-locks text "${POISON}" marked the order "never replay" at the gate (batch held here: ${held})`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
