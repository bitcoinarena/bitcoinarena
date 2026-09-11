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
// MEASURED BEFORE (TASKBOOK): seven seats, five signatures and nothing posted
// anywhere - FINAL after the window; two daemons whose contract named a relay -
// loser settled, winner cancelled, payout queued, the relay asked 0 times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD, SETTLED, CANCELLED } from '../src/custody.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import { transcriptBytesHash } from '../../protocol/src/posting.js';
import {
  b32, rand, WINDOW_MS, wait, WINNER, LOSER, paidPort, contractFor, say, seatAndPlay, opts, sevenSeats,
} from './window-fixture.js';

/** A relay that keeps whatever it is given and writes down every request; `lies` gives back other bytes. */
async function countingRelay({ lies = false } = {}) {
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
    return res.end(lies ? Buffer.concat([kept, Buffer.from([0])]) : kept);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, held, close: () => new Promise((r) => server.close(r)) };
}

const mayRelease = (w, name) => w.holder.preimages.mayRelease(w.rid, w.runs[name].eid);

test('seven seats, five sign and nobody posts the transcript anywhere: after the window the run is still not final, and says why', async () => {
  const relay = await countingRelay();
  const w = await sevenSeats(1000, [relay.url]);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    await wait(1200);
    const may = mayRelease(w, 'agrees');
    const facts = { final: may.ok, relayAsked: relay.seen.length, relayHolds: relay.held.size };
    console.log('  FACTS (7 seats, nothing posted):', JSON.stringify(facts), may.why || '');
    assert.deepEqual(facts, { final: false, relayAsked: 0, relayHolds: 0 });
    assert.match(may.why, /0 of 5 settlement seats have posted/);
  } finally { await w.close(); await relay.close(); }
});

test('seven seats: four postings are not enough; the fifth opens the window, and W counts from it, not from the signatures', async () => {
  const w = await sevenSeats(1000);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    await wait(1200);                       // a whole window after the signatures
    const four = mayRelease(w, 'agrees');
    assert.equal(four.ok, false, 'four postings made the run final');
    assert.match(four.why, /4 of 5 settlement seats have posted/);

    w.post('agrees', 5);                    // the fifth seat's posting arrives now
    await wait(700);
    const inside = mayRelease(w, 'agrees');
    assert.equal(inside.ok, false, 'the window was counted from the signatures, not from the posting');
    assert.match(inside.why, /objection window/);
    await wait(600);
    const after = mayRelease(w, 'agrees');
    assert.equal(after.ok, true, `the run was not final a whole window after its fifth posting: ${after.why}`);
  } finally { await w.close(); }
});

test('seven seats: postings from keys that are not seated, or about another transcript, count for nothing', async () => {
  const w = await sevenSeats(500);
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 4);
    w.post('agrees', 3, {}, [rand(32), rand(32), rand(32)]);           // three strangers
    w.post('agrees', 6, { transcriptHash: b32(0x77) });                // the fifth and sixth seat, about another transcript
    await wait(700);
    const may = mayRelease(w, 'agrees');
    assert.equal(may.ok, false, 'strangers or postings of another transcript made the run final');
    assert.match(may.why, /4 of 5 settlement seats have posted/);
  } finally { await w.close(); }
});

test('seven seats: a contract that names no relay is never final, whatever five postings say', async () => {
  const w = await sevenSeats(500, []);
  try {
    w.sign('agrees', () => ({}));
    await wait(700);
    const may = mayRelease(w, 'agrees');
    assert.equal(may.ok, false, 'a round with nowhere to post its transcripts went final');
    assert.match(may.why, /names no publication relay/);
  } finally { await w.close(); }
});

test('a daemon\'s relay door keeps a transcript only under the hash its bytes have', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const bytes = rand(300);
    const name = toHex(transcriptBytesHash(bytes));
    const wrong = await fetch(`http://127.0.0.1:${d.port}/transcript/${'ab'.repeat(32)}`, { method: 'PUT', body: bytes });
    assert.equal(wrong.status, 409);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/transcript/${'ab'.repeat(32)}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/transcript/${name}`, { method: 'PUT', body: bytes })).status, 201);
    const back = new Uint8Array(await (await fetch(`http://127.0.0.1:${d.port}/transcript/${name}`)).arrayBuffer());
    assert.equal(toHex(back), toHex(bytes));
  } finally { await d.close(); }
});

/** Two daemons, one relay the test runs, both runs played and the round closed on both. */
async function twoDaemons(relay) {
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA, finality: { everyMs: 100 } });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB, finality: { everyMs: 100 } });
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
  const closedAt = Date.now();
  assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
  await a.verifier.settling;
  await b.verifier.settling;
  const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;
  return { a, b, portA, portB, rid, winner, loser, closedAt, stateOf, close: async () => { await a.close(); await b.close(); } };
}

test('two seats: each posts both transcripts to the contract\'s relay, and only then, a window later, the loser settles, the winner cancels and a payout is queued', async () => {
  const relay = await countingRelay();
  const t = await twoDaemons(relay);
  try {
    const { a, b, rid, winner, loser, stateOf } = t;
    const moved = () => [a, b].every((d) => stateOf(d, loser.eid) === SETTLED && stateOf(d, winner.eid) === CANCELLED && d.round.payout(rid));
    const done = Date.now() + WINDOW_MS + 8000;
    while (Date.now() < done && !moved()) await wait(100);
    const puts = relay.seen.filter((s) => s.method === 'PUT');
    const facts = {
      loserSettled: [a, b].map((d) => stateOf(d, loser.eid) === SETTLED),
      winnerCancelled: [a, b].map((d) => stateOf(d, winner.eid) === CANCELLED),
      payoutQueued: [a, b].map((d) => !!d.round.payout(rid)),
      puts: puts.length,
      relayHolds: relay.held.size,
      heldUnderOwnHash: [...relay.held].every(([path, bytes]) => path === `/transcript/${toHex(transcriptBytesHash(new Uint8Array(bytes)))}`),
    };
    console.log('  FACTS (2 seats, a relay):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      loserSettled: [true, true], winnerCancelled: [true, true], payoutQueued: [true, true],
      puts: 4,                   // two seats, two runs
      relayHolds: 2,             // one transcript per run: both seats posted the same bytes
      heldUnderOwnHash: true,
    });
    // AND NO ACT BEFORE A WHOLE WINDOW AFTER THE POSTING that completed 2 of 2
    // on that seat - each run against its OWN posting: the loser's settle
    // against the loser's, the winner's cancel against the winner's.
    for (const [name, d, p] of [['A', a, t.portA], ['B', b, t.portB]]) {
      const postedAt = (eid) => Math.max(...d.round.postings(rid, eid).map((x) => x.seenMs));
      for (const [acts, run, what] of [[p.settled, loser, 'settled the loser'], [p.cancelled, winner, 'cancelled the winner']])
        for (const act of acts)
          assert.ok(act.at >= postedAt(run.eid) + WINDOW_MS,
            `${name} ${what} ${act.at - postedAt(run.eid)} ms after that run's posting, inside a ${WINDOW_MS} ms window`);
    }
  } finally { await t.close(); await relay.close(); }
});

test('two seats whose only relay gives back other bytes: no seat posts, and nothing moves after the window', async () => {
  const relay = await countingRelay({ lies: true });
  const t = await twoDaemons(relay);
  try {
    const { a, b, rid, winner, loser, stateOf } = t;
    await wait(Math.max(0, t.closedAt + WINDOW_MS + 1500 - Date.now()));
    const facts = {
      holds: [a, b].map((d) => [stateOf(d, loser.eid), stateOf(d, winner.eid)]),
      postings: [a, b].map((d) => d.round.postings(rid, loser.eid).length),
      payout: [a, b].map((d) => d.round.payout(rid)),
      lightningActs: [t.portA, t.portB].map((p) => p.settled.length + p.cancelled.length),
    };
    console.log('  FACTS (2 seats, a lying relay):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      holds: [[HELD, HELD], [HELD, HELD]], postings: [0, 0], payout: [null, null], lightningActs: [0, 0],
    });
  } finally { await t.close(); await relay.close(); }
});
