// A RESULT IS NOT FINAL UNTIL ITS TRANSCRIPT IS POSTED WHERE ANYONE CAN REPLAY IT (P2).
//
// Spec v4.6.2 §13A, "Publication is a condition of finality": a
// PROVISIONALLY_FINAL result is not FINAL until the canonical transcript it
// names has been retrieved by the round's threshold of settlement seats and
// posted by them to the contract's `publication_relays[]`, and the window W
// counts from that posting. Without it a quorum that plays for itself sends the
// honest seats nothing, signs what it likes, and nobody ever holds an object to
// replay (the §35A row "self-dealing quorum never publishes its transcript").
//
// MEASURED FIRST, asserted as it stands: the contract names a relay that
// counts every request, and nobody asks it anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { SETTLED, CANCELLED } from '../src/custody.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import {
  WINDOW_MS, wait, WINNER, LOSER, paidPort, contractFor, say, seatAndPlay, opts, sevenSeats,
} from './window-fixture.js';

/** A relay that keeps whatever it is given and writes down every request. */
async function countingRelay() {
  const seen = [];
  const held = new Map();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, path: req.url, bytes: body.length });
    if (req.method === 'PUT' || req.method === 'POST') { held.set(req.url, body); res.writeHead(201); return res.end(); }
    const kept = held.get(req.url);
    if (!kept) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    return res.end(kept);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, held, close: () => new Promise((r) => server.close(r)) };
}

test('MEASURED: seven seats, five sign and nobody posts the transcript anywhere - after the window the run is FINAL', async () => {
  const relay = await countingRelay();
  const w = await sevenSeats(1000, [relay.url]);
  try {
    w.sign('agrees', () => ({}));
    await wait(1200);
    const may = w.holder.preimages.mayRelease(w.rid, w.runs.agrees.eid);
    const facts = { final: may.ok, relayAsked: relay.seen.length, relayHolds: relay.held.size };
    console.log('  FACTS (7 seats, nothing posted):', JSON.stringify(facts), may.why || '');
    assert.deepEqual(facts, { final: true, relayAsked: 0, relayHolds: 0 });
  } finally { await w.close(); await relay.close(); }
});

test('MEASURED: two seats, the contract names a relay nobody posts to - after the window the loser settles, the winner cancels and a payout is queued', async () => {
  const relay = await countingRelay();
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA, finality: { everyMs: 100 } });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB, finality: { everyMs: 100 } });
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), [relay.url]);
    const rid = roundId(c);
    for (const d of [a, b]) {
      assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      assumeSeated(d.round, rid, c.nodes);
    }
    const winner = await seatAndPlay([a, b], c, rid, WINNER, 2);
    const loser = await seatAndPlay([a, b], c, rid, LOSER, 2);
    assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;

    const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;
    const moved = () => [a, b].every((d) => stateOf(d, loser.eid) === SETTLED && stateOf(d, winner.eid) === CANCELLED && d.round.payout(rid));
    const done = Date.now() + WINDOW_MS + 8000;
    while (Date.now() < done && !moved()) await wait(100);
    const facts = {
      loserSettled: [a, b].map((d) => stateOf(d, loser.eid) === SETTLED),
      winnerCancelled: [a, b].map((d) => stateOf(d, winner.eid) === CANCELLED),
      payoutQueued: [a, b].map((d) => !!d.round.payout(rid)),
      relayAsked: relay.seen.length,
    };
    console.log('  FACTS (2 seats, nothing posted):', JSON.stringify(facts));
    assert.deepEqual(facts, { loserSettled: [true, true], winnerCancelled: [true, true], payoutQueued: [true, true], relayAsked: 0 });
  } finally { await a.close(); await b.close(); await relay.close(); }
});
