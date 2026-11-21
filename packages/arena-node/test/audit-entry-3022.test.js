// kanban #3022: the card's test (audit entry r2-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 entry r2 #1: ONE PEER SEAT'S QUICK REFUSAL STOPS THE REPLAY OF A CERTIFIED ORDER FROM EVERY OTHER PEER.
// order-batch.js #replay: the ReplayGate (kanban #1087) keys a refused replay by the order only, "across every peer", for REPLAY_RETRY_MS (10 min).
// A seat that missed an order of a certified batch asks every round seat for /book-certificates in parallel (sync / carry). One seat of the
// round answers first with the real certificate and then 404 at GET /entry?id=<order>: the replay from it is refused, the order is held at the
// gate, and the honest seats' answers that come a little later are never replayed (#replay answers false at once). Each later pass the same.
// Safe behaviour: one peer's failed replay does not stop the order being replayed from the honest peers in the same pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `aer2${n}`, key: b32(0x50 + n), worldSecret: b32(0) });

test('audit entry r2 #1: one seat answering first with a refusal does not stop the replay of a certified order from the honest seats', async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  let evil = null;
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = 1000;
    await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 55_000n } });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50_000n } });
    const B = 1000, k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B) await wait(5);
    const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
    const got = await leader.orderBook.lead(w.rid, k);
    assert.equal(got.ok, true, got.why);
    assert.equal(got.certified, true);

    // seat d never received one order of that batch (as in wf1489-sm5-entry-1)
    const d = w.nodes.find((x) => x !== leader);
    const cert = d.orderBook.certificates(w.rid).find((c) => c.record.orders.length);
    const eid = cert.record.orders[0], e = Buffer.from(eid, 'hex'), rid = Buffer.from(w.rid);
    d.round.db.exec('PRAGMA foreign_keys = OFF');
    for (const [t, col, v] of [['entries', 'entry_id', e], ['stake_locks', 'entry_id', e], ['fee_locks', 'entry_id', e], ['stake_seen', 'entry_id', e], ['market_orders', 'order_id', eid]])
      d.round.db.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).run(v);
    d.round.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, Number(cert.record.k));
    d.round.db.exec('PRAGMA foreign_keys = ON');

    // THE ATTACKER: one seat of the round. It serves the real certified batches at once, and 404 for the order's entry.
    const leaderBase = `http://127.0.0.1:${leader.port}`;
    const certs = await fetch(`${leaderBase}/book-certificates?round=${toHex(w.rid)}`).then((r) => r.json());
    evil = http.createServer((req, res) => {
      if (req.url.startsWith('/book-certificates')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(certs)); }
      res.writeHead(404); res.end('no such entry');
    });
    await new Promise((r) => evil.listen(0, '127.0.0.1', r));
    const evilBase = `http://127.0.0.1:${evil.address().port}`;
    const honest = d.orderBook.peersFor(w.rid);
    d.orderBook.peersFor = () => (process.env.AER2_CONTROL === '1' ? honest : [evilBase, ...honest]);   // AER2_CONTROL=1: the same run without the attacker
    // the honest seats are a little farther away on the network than the attacker (100 ms)
    const fetcher = d.orderBook.fetcher;
    d.orderBook.fetcher = async (u, o) => { if (!String(u).startsWith(evilBase)) await new Promise((r) => setTimeout(r, 100)); return fetcher(u, o); };

    await d.orderBook.carry(w.rid);
    await d.orderBook.carry(w.rid);
    const held = d.orderBook.certificates(w.rid).some((c) => String(c.record.k) === String(cert.record.k));
    console.log('  FACTS:', JSON.stringify({ honestPeers: honest.length, entryHere: !!d.round.entry(e), stakeLockHere: !!d.round.stakeLock(e), batchHeldHere: held }));
    assert.ok(d.round.stakeLock(e), 'the certified order was never replayed from the 6 honest seats: one seat\'s 404 held it at the replay gate');
    assert.ok(held, 'the certified batch is not held at the seat that missed it');
  } finally { if (evil) evil.close(); await w.close(); }
});

