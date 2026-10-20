// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RUN'S CHECKPOINT CHAIN GROWS ON EVERY NODE OF THE COMMITTEE - AND ONLY
// OVER INPUTS EACH OF THEM HOLDS.
//
// Measured 2026-09-10 on the Daily's 2-of-2, two real Chromes: every run
// stored ONE checkpoint on daemon A and NONE on daemon B, and every later one
// was refused as "not following the chain head". The client sent each
// checkpoint to the one node it had proven, B never held the entry, and the
// head only moves when a mark is LIVE - two receipts on a committee of two.
// Once checkpoints reached both, B held 0 ticks of the runs it receipted: a
// client that sent no batch at all still got all four checkpoints receipted by
// both daemons. A receipt over inputs the node never saw is a claim.
//
// Section 10: "a checkpoint is accepted when enough nodes receive it". Section
// 11: "the client periodically sends batches and checkpoints". Section 13C: a
// canonical chain is one the committee's receipts carry.
//
// These run against two real daemons, stood up by the same tool the Daily
// runs, and the page's own path: the URL the operator printed, the node list
// `index.html` hands `Client.at`, `join`, `record`, `markNow`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../arena-node/tools/round-2of2.mjs';
import { Client, receiptsForLive, FEED_WINDOW } from '../src/client.js';
import { joinFromQuery, tabSeed, playerFor, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../arena-node/src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { init as coreInit, step as coreStep } from '../../nextblock/src/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../nextblock/dist/blwp-core.js');
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const fromHexHere = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/** A joined, connected tab - exactly the page's steps, with the page's node list or without it. */
async function tab(round, named, { pageNodes }) {
  const secret = ed25519.utils.randomSecretKey();
  const player = playerFor(named.round, { seed: tabSeed({ storage: storage(), random }), curve: feldmanGroup });
  const signerNode = entryFor(named.round, { seed: player.seed, curve: feldmanGroup, random });
  // `nodes` is what the page's wrapper of `Client.at` adds (`index.html`): the
  // round's node list, `window.ARENA_NODES`. Without it, the Daily before this.
  const client = await Client.at({
    headers: named.chain.headers, bonds: named.chain.bonds,
    signedAdvert: fromHexHere(named.advert.signedAdvert),
    committee: named.round.nodes,
    ...(pageNodes ? { nodes: named.nodes } : {}),
  }, {
    core: { hash: (st) => core.hash(st) },
    sign: (id) => ed25519.sign(id, secret),
    verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
  });
  const rid = await client.openRound(named.round);
  const entry = { ...signerNode, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
  const eid = await client.join(entry);
  await client.connect();
  client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
  return { client, rid, eid };
}

/** How many checkpoints a daemon has STORED for this run, on its own public door. */
async function stored(base, rid, eid) {
  const r = await fetch(`${base}/checkpoints?round=${toHex(rid)}&entry=${toHex(eid)}`);
  await r.arrayBuffer();
  return Number(r.headers.get('x-checkpoints'));
}

/** How many ticks of this run a daemon HOLDS, and their hash, on its own public door. */
async function transcriptOn(base, rid, eid) {
  const r = await fetch(`${base}/transcript?round=${toHex(rid)}&entry=${toHex(eid)}`);
  await r.arrayBuffer();
  return { ticks: Number(r.headers.get('x-ticks')), hash: r.headers.get('x-transcript-hash') };
}
const heldTicks = async (base, rid, eid) => (await transcriptOn(base, rid, eid)).ticks;

/** 204 when a daemon holds no fork proof against this entry, 200 when it does. */
async function equivocation(base, rid, eid) {
  const r = await fetch(`${base}/equivocation?round=${toHex(rid)}&entry=${toHex(eid)}`);
  await r.arrayBuffer();
  return r.status;
}

/** The checkpoint chain a daemon stores for this run, as the bytes it serves. */
async function chainOn(base, rid, eid) {
  const r = await fetch(`${base}/checkpoints?round=${toHex(rid)}&entry=${toHex(eid)}`);
  return toHex(new Uint8Array(await r.arrayBuffer()));
}

/** Everything recorded published to this client's node, and every peer fed. */
async function publishAll(client) {
  for (let i = 0; i < 500 && (client.hold.length || client.publishing); i++) {
    await (client.drain() || client.publishing);
    await client.awaitPublishes();
  }
  await client.awaitPeers();
}

/** A core driven to `tick`, hashed the way the bridge hashes it. */
function driven(seed, tick) {
  const st = coreInit(seed);
  for (let t = 0; t < tick; t++) coreStep(st, 45875, 0, 0, 0, 0);
  return core.hash(st);
}

const drive = (client, n) => { for (let i = 0; i < n; i++) client.record([45875, 0, 0, 0, 0]); };

test('a checkpoint over inputs no node holds is refused by both daemons, and nothing is stored', async () => {
  // BEFORE THIS CUT: four checkpoints, no batch, and both daemons receipted
  // all four - 4 stored on A and 4 on B over 0 ticks of inputs. Sent here the
  // low way, `mark`, which does not wait for inputs, so the node's own rule is
  // what is measured.
  const round = await standUpRound({ host: '127.0.0.1', portA: 18250, portB: 18251 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    assert.equal(client.peers.length, 1, 'the page named two nodes and the client knows one peer');
    assert.equal(receiptsForLive(named.round), 2, 'a 2-of-2 needs both receipts to go live');
    assert.deepEqual(client.peerJoins.map((s) => s.ok), [true],
      `B did not take the entry: ${JSON.stringify(client.peerJoins)}`);

    for (const tick of [60, 120, 180, 240]) {
      const r = await client.mark(driven(7, tick), { roundId: rid, entryId: eid, tick });
      console.log(`  no inputs, tick ${tick}: ${r.answer} | refused by ${r.refused.length} | `
        + `witnessed ${client.witnessed(r.id)}`);
      assert.match(r.answer, /holds this run's inputs only before tick 0/,
        `A signed a checkpoint at ${tick} over no inputs: ${r.answer}`);
      assert.equal(r.refused.length, 2, `both daemons must refuse the checkpoint at ${tick}`);
      assert.match(r.refused[1], /holds this run's inputs only before tick 0/);
      assert.equal(client.witnessed(r.id), 0, 'a receipt came back over no inputs');
      assert.equal(r.live, false);
    }
    assert.deepEqual([await stored(A, rid, eid), await stored(B, rid, eid)], [0, 0],
      'a checkpoint over no inputs was stored');
    assert.deepEqual([await heldTicks(A, rid, eid), await heldTicks(B, rid, eid)], [0, 0]);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

test('a client that reaches one daemon of two cannot grow its chain past its first link, sends no second child, and says so', async () => {
  // THE DAILY BEFORE THE FAN-OUT, reproduced: no page node list, so no peers.
  // Until 2026-09-10 the second link WENT OUT here, naming the zero head, and
  // A refused it for the chain head AND KEPT it - the second child of one
  // parent, a fork proof against an honest player. It is not sent now.
  const round = await standUpRound({ host: '127.0.0.1', portA: 18252, portB: 18253 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: false });
    const { client, rid, eid } = t;
    assert.equal(client.peers.length, 0);
    const other = named.nodes.map((n) => String(n).replace(/\/+$/, ''))
      .find((n) => n !== client.base);

    drive(client, 60);
    const first = await client.markNow(driven(7, 60), 60);
    assert.equal(first.answer, 'receipted');
    assert.equal(first.live, false, 'one receipt of two went live');
    drive(client, 60);
    const second = await client.markNow(driven(7, 120), 120);
    assert.equal(second.skippedForLink, true, `the second link went out: ${second.answer}`);
    assert.match(second.answer, /stored but not carried/);

    const at = [await stored(client.base, rid, eid), await stored(other, rid, eid)];
    const held = [await heldTicks(client.base, rid, eid), await heldTicks(other, rid, eid)];
    const proof = await equivocation(client.base, rid, eid);
    console.log(`  one daemon: checkpoints A ${at[0]} B ${at[1]}, inputs A ${held[0]} B ${held[1]}; `
      + `A /equivocation ${proof}; ${client.status(120)}`);
    assert.deepEqual(at, [1, 0]);
    assert.deepEqual(held, [120, 0]);
    assert.equal(proof, 204, 'the honest client handed A a fork proof against itself');

    // AND THE PAGE'S LINE SAYS WHY THE CHAIN STOPPED.
    assert.equal(client.marksSent, 1);
    assert.equal(client.marksAccepted, 0);
    assert.equal(client.marksRefused, 0);
    assert.equal(client.marksSkipped, 1);
    assert.match(client.status(120), / skipped 1\b/);
    assert.match(client.status(120), / pending link 60\b/);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

test('the page\'s own order - record, then mark at once - waits for both daemons to hold the inputs, and the chain grows on both', async () => {
  // THE MARK IS TAKEN WHILE ITS LAST TICKS ARE STILL IN THE HOLD, which is
  // exactly when the bridge takes it. It must not race them: it waits until A
  // took them and B answered that it holds them, then goes to both.
  const round = await standUpRound({ host: '127.0.0.1', portA: 18254, portB: 18255 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];

    const links = [];
    for (const tick of [60, 120, 180, 240]) {
      drive(client, 60);
      assert.ok(client.hold.length > 0, 'the last ticks must still be held when the mark is taken');
      const r = await client.markNow(driven(7, tick), tick);
      links.push(r);
      await client.awaitPeers();
      const a = await transcriptOn(A, rid, eid);
      const b = await transcriptOn(B, rid, eid);
      const marks = [await stored(A, rid, eid), await stored(B, rid, eid)];
      console.log(`  tick ${tick}: inputs A ${a.ticks} B ${b.ticks} same hash ${a.hash === b.hash} | `
        + `checkpoints A ${marks[0]} B ${marks[1]}, live ${r.live}, refused ${r.refused.length}`);
      assert.equal(r.answer, 'receipted', `A refused the checkpoint at ${tick}: ${r.answer}`);
      assert.deepEqual(r.refused, [], `a node refused the checkpoint at ${tick}: ${r.refused}`);
      assert.equal(r.live, true, `the checkpoint at ${tick} did not go live`);
      assert.equal(client.witnessed(r.id), 2, 'both daemons receipted it, so both count');
      assert.deepEqual([a.ticks, b.ticks], [tick, tick], `at ${tick} A and B hold ${a.ticks} and ${b.ticks}`);
      assert.equal(b.hash, a.hash, 'B holds different inputs from A');
      assert.deepEqual(marks, [links.length, links.length]);
    }
    assert.equal(client.marksWaited, 4, 'every mark was taken with its last ticks still held, so each waited');

    // AND EACH LINK NAMES THE ONE BEFORE IT - the head moved, on both receipts.
    assert.equal(toHex(links[0].checkpoint.previousHash), toHex(NO_PREVIOUS));
    for (let i = 1; i < links.length; i++)
      assert.equal(toHex(links[i].checkpoint.previousHash), toHex(links[i - 1].id),
        `link ${i} does not name the head before it`);

    // THE COUNTERS SAY WHAT HAPPENED.
    assert.equal(client.marksSent, 4);
    assert.equal(client.marksAccepted, 4);
    assert.equal(client.marksRefused, 0);
    assert.deepEqual(client.peerBatches().map(({ ticks, lag, refused }) => ({ ticks, lag, refused })),
      [{ ticks: 240, lag: 0, refused: 0 }]);
    const line = client.status(240);
    assert.match(line, / marks 4 /);
    assert.match(line, / accepted 4\b/);
    assert.equal(/refused/.test(line), false, `a refusal was printed where there was none: ${line}`);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

test('a daemon that has not caught up refuses rather than signs, then signs once it holds the inputs', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18256, portB: 18257 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    // THE DAILY BEFORE: no node list, so the entry and the inputs reach A alone.
    t = await tab(round, named, { pageNodes: false });
    const { client, rid, eid } = t;
    const B = named.nodes.map((n) => String(n).replace(/\/+$/, '')).find((n) => n !== client.base);
    drive(client, 60);
    await publishAll(client);
    const before = [await heldTicks(client.base, rid, eid), await heldTicks(B, rid, eid)];
    assert.deepEqual(before, [60, 0], `without the node list A and B hold ${before}`);

    // NOW THE NODE LIST ARRIVES, with B never having seen the entry. Its first
    // batch is refused for the signer node, the signer node is given, and its feed stops
    // there until the next try.
    client.deliverTo(named.nodes);
    drive(client, 60);
    await publishAll(client);
    assert.equal(client.peerBatchesRefused, 1, 'B was expected to refuse once, for the missing signer node');
    assert.match(client.peerBatches()[0].why, /no such entry/);
    assert.match(client.status(120), / inputs refused 1\b/, 'a refused input was not on the line');
    assert.equal(await heldTicks(B, rid, eid), 0, 'B is joined and holds nothing yet');

    // B IS ASKED TO SIGN BEFORE IT HOLDS THE INPUTS, and does not. Sent the low
    // way, `mark`, which does not wait - the way a client that raced its
    // batches would.
    const early = await client.mark(driven(7, 60), { roundId: rid, entryId: eid, tick: 60 });
    console.log(`  B behind: A ${early.answer}, B ${early.refused.join('; ')}`);
    assert.equal(early.answer, 'receipted', 'A holds 120 ticks and should sign the mark at 60');
    assert.equal(early.refused.length, 1);
    assert.match(early.refused[0], /holds this run's inputs only before tick 0/);
    assert.equal(early.live, false, 'one receipt of two went live');
    assert.deepEqual([await stored(client.base, rid, eid), await stored(B, rid, eid)], [1, 0]);

    // B IS CAUGHT UP FROM THE FIRST BATCH THIS CLIENT KEPT, and then the same
    // checkpoint - the same bytes - is signed by B too and goes live.
    client.pumpPeers();
    await client.awaitPeers();
    const caught = [await transcriptOn(client.base, rid, eid), await transcriptOn(B, rid, eid)];
    assert.deepEqual(caught.map((c) => c.ticks), [120, 120],
      'B was not caught up across the ticks published before the node list arrived');
    assert.equal(caught[1].hash, caught[0].hash);
    const again = await client.mark(driven(7, 60), { roundId: rid, entryId: eid, tick: 60 });
    assert.equal(toHex(again.id), toHex(early.id), 'the second send is not the same checkpoint');
    assert.deepEqual(again.refused, [], `refused after catching up: ${again.refused}`);
    assert.equal(again.live, true, 'both daemons hold the inputs and both signed, so it is live');

    // AND FROM HERE THE PAGE'S OWN PATH carries on, on both.
    drive(client, 60);
    const next = await client.markNow(driven(7, 180), 180);
    assert.equal(next.live, true);
    assert.deepEqual(next.refused, []);
    const after = [await stored(client.base, rid, eid), await stored(B, rid, eid)];
    const held = [await heldTicks(client.base, rid, eid), await heldTicks(B, rid, eid)];
    console.log(`  late peer: inputs before A ${before[0]} B ${before[1]}, after A ${held[0]} B ${held[1]}; `
      + `checkpoints A ${after[0]} B ${after[1]}`);
    assert.deepEqual(held, [180, 180]);
    assert.deepEqual(after, [2, 2]);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

// A PEER THAT IS BEHIND IS CAUGHT UP IN ROUND TRIPS, NOT IN BATCHES.
//
// Measured on the Daily, a paid entry both seats served through quick tunnels: the peer round trip was
// 65 ms (median of 2084), one batch is 6 ticks, so one batch per round trip closes a backlog at 92 ticks
// a second against a player making 60 - 32 a second of surplus. A seat that started 2280 ticks behind
// therefore needed 71 s, the run's first mark went out at tick 5940, and §13B judged it against a window
// ending at 900: FORFEIT, on a player who had paid in 10 s.
//
// The window does not move and no node checks less. The client stops waiting for one answer before
// asking the next question, which is what `FEED_WINDOW` is.
test('a peer behind by a hundred batches is caught up in round trips, not one round trip per batch', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18276, portB: 18277 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    // THE BACKLOG, MADE THE WAY THE DAILY MADE IT: B is not in the page's node list, so everything the
    // player does reaches A alone and B holds nothing at all.
    t = await tab(round, named, { pageNodes: false });
    const { client, rid, eid } = t;
    const B = named.nodes.map((n) => String(n).replace(/\/+$/, '')).find((n) => n !== client.base);
    // THE BRIDGE DRAINS EVERY `BatchEvery` TICKS (6, 10 Hz of a 60 Hz run), so the backlog is a hundred
    // small batches and not one big one - which is the whole shape of the thing being measured.
    const EVERY = 6, TICKS = 600;
    for (let i = 0; i < TICKS / EVERY; i++) { drive(client, EVERY); await publishAll(client); }
    const batches = client.published.length;
    assert.ok(batches >= 90, `the backlog was meant to be about a hundred batches, it is ${batches}`);
    assert.deepEqual([await heldTicks(client.base, rid, eid), await heldTicks(B, rid, eid)], [TICKS, 0]);

    // EVERY FRAME TO B IS COUNTED, and so is how many were on the wire at once. A wave is one round trip's
    // worth: the count goes up each time the wire goes from empty to busy.
    let inFlight = 0, waves = 0, mostAtOnce = 0, frames = 0;
    const was = client.sendPeer.bind(client);
    client.sendPeer = async (base, bytes) => {
      if (base !== B) return was(base, bytes);
      if (inFlight === 0) waves++;
      inFlight++; frames++;
      if (inFlight > mostAtOnce) mostAtOnce = inFlight;
      try { return await was(base, bytes); } finally { inFlight--; }
    };

    client.deliverTo(named.nodes);
    client.pumpPeers();
    await client.awaitPeers();
    // B WAS NOT IN THE ROUND AT ALL, so the first wave is refused for the signer node and the entry is
    // handed over; the feed then catches it up. Whatever it takes, it is counted here.
    for (let i = 0; i < 10 && (await heldTicks(B, rid, eid)) < TICKS; i++) {
      client.pumpPeers();
      await client.awaitPeers();
    }
    const held = [await heldTicks(client.base, rid, eid), await heldTicks(B, rid, eid)];
    const ceiling = Math.ceil(batches / FEED_WINDOW);
    console.log(`  ${batches} batches of backlog: ${frames} frames in ${waves} waves, `
      + `${mostAtOnce} at once, B holds ${held[1]} of ${held[0]}`);
    assert.deepEqual(held, [TICKS, TICKS], 'B was not caught up across the whole backlog');
    assert.ok(mostAtOnce > 1, 'the backlog still went one frame per round trip');
    assert.ok(waves <= ceiling + 3,
      `${batches} batches took ${waves} waves and ${ceiling} + the retry are what a window of ${FEED_WINDOW} allows`);
    assert.equal(client.peerBatchesRefused, 1,
      `a whole window of refusals was counted where one batch was refused: ${client.peerBatchesRefused}`);

    // AND THE RUN GOES ON THROUGH THE PAGE'S OWN PATH, on both.
    const mark = await client.markNow(driven(7, TICKS), TICKS);
    assert.equal(mark.live, true, `the mark after the catch-up was not live: ${mark.refused.join('; ')}`);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

// A NODE THAT NEVER CATCHES UP.
//
// The cut above made a mark wait until every node holds its inputs, and the
// wait had no end: with one daemon gone the mark waited for ever, every later
// mark was skipped behind it, and `awaitPublishes` never returned.
test('a stopped daemon holds a checkpoint for a bounded time: it is sent to nobody, publishing returns, and the next mark tries again', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18258, portB: 18259 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    client.markWaitMs = 1500;

    drive(client, 60);
    const first = await client.markNow(driven(7, 60), 60);
    assert.equal(first.live, true, 'with both daemons up the first mark goes live');

    // DAEMON B STOPS.
    await round.b.close();
    await wait(100);

    drive(client, 60);
    const pending = client.markNow(driven(7, 120), 120);
    assert.ok(pending, 'the mark was skipped instead of waiting for its inputs');
    assert.match(client.status(120), / waiting 120\b/, `the line does not say a mark is waiting: ${client.status(120)}`);

    // PUBLISHING RETURNS, inside the bound - it used to wait for ever here.
    const t0 = Date.now();
    await client.awaitPublishes();
    const waited = Date.now() - t0;
    const r = await pending;
    console.log(`  B stopped: awaitPublishes returned after ${waited} ms (bound ${client.markWaitMs}); `
      + `${r.answer}; behind: ${r.behind.join('; ')}`);
    assert.ok(waited >= client.markWaitMs - 100 && waited < client.markWaitMs + 2000,
      `awaitPublishes returned after ${waited} ms against a ${client.markWaitMs} ms bound`);
    assert.equal(r.timedOut, true);
    assert.equal(r.live, false);
    assert.ok(r.behind.some((w) => w.startsWith(B)), `B is not named as the node behind: ${r.behind}`);
    assert.equal(r.behind.some((w) => w.startsWith(A)), false, 'A holds the inputs and was named as behind');

    // FAIL CLOSED: sent to nobody, so A stores no link B could never agree to -
    // but A still took the inputs.
    assert.equal(await stored(A, rid, eid), 1, 'the timed-out mark was sent to A anyway');
    assert.equal(await heldTicks(A, rid, eid), 120, 'the inputs stopped going to A');
    assert.equal(client.marksTimedOut, 1);
    assert.match(client.marksTimedOutWhy, /tick 120/);
    let line = client.status(120);
    assert.match(line, / timed out 1\b/, `the line does not count the mark that was never sent: ${line}`);
    assert.equal(/ waiting /.test(line), false, `the line still says waiting: ${line}`);

    // THE NEXT MARK IS NOT SKIPPED FOR EVER: it is tried, waits its own bound,
    // and is counted again while B stays down.
    drive(client, 60);
    const again = await client.markNow(driven(7, 180), 180);
    assert.ok(again, 'the next mark was skipped');
    assert.equal(again.timedOut, true);
    assert.equal(client.marksTimedOut, 2);
    assert.equal(client.marksSkipped, 0, 'no mark was skipped: each was tried and counted');
    assert.equal(await stored(A, rid, eid), 1);
    assert.equal(await heldTicks(A, rid, eid), 180);
    line = client.status(180);
    console.log(`  after: A stores ${await stored(A, rid, eid)} checkpoint, holds ${await heldTicks(A, rid, eid)} ticks; ${line}`);
    assert.match(line, / timed out 2\b/);
    // A STOPPED DAEMON IS DOWN, NOT REFUSING: its failed connections are
    // counted as closed and as one drop, never as refused inputs.
    assert.equal(client.peerBatchesRefused, 0, `B was off and was counted as refusing inputs: ${line}`);
    assert.ok(client.peerBatches()[0].closed >= 1, 'no closed connection was counted while B was off');
    assert.match(line, / peer drops 1\b/, `the line does not say B dropped: ${line}`);
    assert.equal(/refused/.test(line), false, `the line says refused for a daemon that was off: ${line}`);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    try { await round.close(); } catch { /* B was already stopped */ }
  }
});

// A CHECKPOINT HALF-PUBLISHED WHILE A PEER WAS DOWN.
//
// Measured 2026-09-10 before the fix: B went down after it held the inputs for
// tick 60, so mark 60 went out at once and reached A alone. When B came back,
// mark 120 named the zero head; A refused it and KEPT it - /equivocation 200,
// a fork proof against an honest player - and B stored it. A held [60], B held
// [120], and every later mark was refused by both.
test('an honest next checkpoint is not a fork proof because a peer was down: the half-published one is re-sent, carried by both, and the next chains onto it', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18264, portB: 18265 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];

    drive(client, 60);
    await publishAll(client);
    assert.deepEqual([await heldTicks(A, rid, eid), await heldTicks(B, rid, eid)], [60, 60],
      'both daemons must hold mark 60\'s inputs before B goes');

    // B GOES DOWN, and mark 60 is not held back: every node held its inputs.
    await round.b.close();
    await wait(100);
    const half = await client.markNow(driven(7, 60), 60);
    assert.equal(half.answer, 'receipted', 'A holds the inputs and signs');
    assert.equal(half.live, false, 'one receipt of two went live');
    assert.deepEqual(half.refused, [], `B was down, not refusing: ${half.refused}`);
    assert.equal(half.unreached.length, 1, 'B was down and should be named as unreached');
    assert.equal(await stored(A, rid, eid), 1, 'A stored the half-published link');
    assert.match(client.status(60), / pending link 60\b/, `the line does not name the pending link: ${client.status(60)}`);

    // B COMES BACK - the same store, identity and port.
    await round.restartB();
    drive(client, 60);
    const next = await client.markNow(driven(7, 120), 120);
    const proofs = [await equivocation(A, rid, eid), await equivocation(B, rid, eid)];
    const marks = [await stored(A, rid, eid), await stored(B, rid, eid)];
    console.log(`  B back: mark 60 re-sent, witnessed ${client.witnessed(half.id)}; mark 120 ${next.answer}, `
      + `live ${next.live}, names mark 60 ${toHex(next.checkpoint.previousHash) === toHex(half.id)}; `
      + `checkpoints A ${marks[0]} B ${marks[1]}; /equivocation A ${proofs[0]} B ${proofs[1]}`);
    assert.equal(client.witnessed(half.id), 2, 'the re-sent link is not carried by both');
    assert.equal(client.marksRelinked, 1);
    assert.equal(next.live, true, `the next checkpoint did not go live: ${next.answer}`);
    assert.deepEqual(next.refused, []);
    assert.equal(toHex(next.checkpoint.previousHash), toHex(half.id),
      'the next checkpoint does not chain onto the re-sent one');
    assert.deepEqual(marks, [2, 2]);
    assert.deepEqual(proofs, [204, 204], 'a daemon holds a fork proof against an honest player');
    assert.equal(await chainOn(B, rid, eid), await chainOn(A, rid, eid), 'A and B hold different chains');

    // AND FROM HERE THE CHAIN GROWS ON BOTH, the same on each.
    drive(client, 60);
    const after = await client.markNow(driven(7, 180), 180);
    assert.equal(after.live, true);
    assert.equal(toHex(after.checkpoint.previousHash), toHex(next.id));
    assert.deepEqual([await stored(A, rid, eid), await stored(B, rid, eid)], [3, 3]);
    assert.deepEqual([await equivocation(A, rid, eid), await equivocation(B, rid, eid)], [204, 204]);
    assert.equal(await chainOn(B, rid, eid), await chainOn(A, rid, eid));
    const line = client.status(180);
    console.log(`  after: checkpoints 3/3, same chain, no fork proof; ${line}`);
    assert.equal(/pending link/.test(line), false, `the line still names a pending link: ${line}`);
    assert.match(line, / relinked 1\b/);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

// A PEER THAT IS DOWN IS NOT A PEER THAT SAYS NO.
//
// Measured 2026-09-10 at e3f24c2, B down 2 s while the next mark waited:
// "inputs refused 20" and "refused 1" - every failed connection to B counted
// in the numbers a node uses to say it will not take something.
test('a peer that is down is counted as down, not as refusing, and the re-sent checkpoint still lands on both with no fork proof', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18266, portB: 18267 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let t;
  let play = null;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];

    drive(client, 60);
    await publishAll(client);
    await round.b.close();
    await wait(100);
    const half = await client.markNow(driven(7, 60), 60);
    assert.equal(half.live, false);
    assert.deepEqual(half.refused, [], `B was down and was counted as refusing: ${half.refused}`);
    assert.equal(half.unreached.length, 1);

    // THE NEXT MARK WAITS WHILE B IS DOWN, and the page keeps playing.
    drive(client, 60);
    const pending = client.markNow(driven(7, 120), 120);
    play = setInterval(() => {
      drive(client, 6);
      const d = client.drain();
      if (d && d.catch) d.catch(() => {});
    }, 100);
    await wait(2000);
    const feed = client.peerBatches()[0];
    const line = client.status(client.nextTick);
    console.log(`  B down 2 s: inputs refused ${client.peerBatchesRefused}, closed ${feed.closed}, `
      + `peer drops ${client.peerDowns}; marks refused ${client.marksRefused}, unreached `
      + `${client.marksUnreached}; ${line}`);
    assert.equal(client.peerBatchesRefused, 0, 'a closed connection was counted as B refusing inputs');
    assert.equal(feed.refused, 0);
    assert.ok(feed.closed >= 1, 'no closed connection was counted while B was down');
    assert.equal(feed.down, true);
    assert.equal(client.peerDowns, 1, 'B went down once');
    assert.equal(client.marksRefused, 0, 'a checkpoint B never received was counted as refused');
    assert.equal(client.marksUnreached, 1);
    assert.equal(/refused/.test(line), false, `the line says refused for a daemon that was off: ${line}`);
    assert.match(line, / unreached 1\b/);
    assert.match(line, / peer drops 1\b/);
    assert.match(line, / waiting 120\b/);

    // B COMES BACK, inside the bound: the re-send lands mark 60 on both and
    // mark 120 chains onto it.
    await round.restartB();
    const next = await pending;
    clearInterval(play);
    play = null;
    await publishAll(client);
    const marks = [await stored(A, rid, eid), await stored(B, rid, eid)];
    const proofs = [await equivocation(A, rid, eid), await equivocation(B, rid, eid)];
    console.log(`  B back: mark 120 ${next.answer}, live ${next.live}, names mark 60 `
      + `${toHex(next.checkpoint.previousHash) === toHex(half.id)}; checkpoints A ${marks[0]} B ${marks[1]}; `
      + `/equivocation A ${proofs[0]} B ${proofs[1]}; ${client.status(client.nextTick)}`);
    assert.equal(next.live, true, `mark 120 did not go live: ${next.answer}`);
    assert.equal(toHex(next.checkpoint.previousHash), toHex(half.id));
    assert.equal(client.witnessed(half.id), 2, 'the re-sent mark 60 is not carried by both');
    assert.deepEqual(marks, [2, 2]);
    assert.deepEqual(proofs, [204, 204], 'a daemon holds a fork proof against an honest player');
    assert.equal(await chainOn(B, rid, eid), await chainOn(A, rid, eid), 'A and B hold different chains');
    assert.equal(client.peerBatchesRefused, 0, 'B never said no, and the count says it did');
    assert.equal(client.peerBatches()[0].down, false, 'B answers again and is still marked down');
  } finally {
    if (play) clearInterval(play);
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

// THE PLAYER'S OWN LINK GOES WHILE A CHECKPOINT WAITS.
//
// Measured 2026-09-10 at 71271bf: a mark waited for B, the player's own socket
// dropped, B came back and caught up without it, and the mark woke with no
// socket to its own node: "error there is no socket" was counted as a refusal
// ("refused 1"), and the mark went to B alone - stored on B, left pending.
test('a checkpoint that wakes after the player\'s own link went is skipped, not refused and not half-sent, and the run carries on after the reconnect', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18270, portB: 18271 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];

    drive(client, 60);
    await round.b.close();
    await wait(100);
    const pending = client.markNow(driven(7, 60), 60);      // waits: B cannot confirm the inputs
    for (let i = 0; i < 40 && client.nextTick < 60; i++) await wait(50);
    assert.equal(client.nextTick, 60, 'A never took the inputs');

    // THE PLAYER'S OWN LINK GOES; B comes back and is fed without it.
    client.sock.close();
    await wait(200);
    assert.equal(client.sock, null, 'the player\'s own socket did not go');
    await round.restartB();
    client.pumpPeers();
    const r = await pending;
    const line = client.status(60);
    console.log(`  own link gone at wake: "${r.answer}"; refused ${client.marksRefused}, skipped `
      + `${client.marksSkipped}, pending link ${client.pendingLink ? client.pendingLink.tick : 'none'}; `
      + `checkpoints A ${await stored(A, rid, eid)} B ${await stored(B, rid, eid)}; ${line}`);
    assert.equal(r.skippedNoSocket, true, `the mark went out with no socket to its own node: ${r.answer}`);
    assert.equal(client.marksRefused, 0, 'the player\'s own drop was counted as a node refusing');
    assert.equal(client.marksSkipped, 1);
    assert.equal(client.pendingLink, null, 'the mark was half-sent to B');
    assert.deepEqual([await stored(A, rid, eid), await stored(B, rid, eid)], [0, 0]);
    assert.equal(/refused/.test(line), false, `the line says refused for the player's own drop: ${line}`);
    assert.match(line, / skipped 1\b/);

    // THE RECONNECT, and the run carries on on both daemons, with one chain.
    await client.reconnect(client.where);
    drive(client, 60);
    const next = await client.markNow(driven(7, 120), 120);
    const marks = [await stored(A, rid, eid), await stored(B, rid, eid)];
    const proofs = [await equivocation(A, rid, eid), await equivocation(B, rid, eid)];
    console.log(`  after the reconnect: mark 120 ${next.answer}, live ${next.live}; checkpoints A ${marks[0]} `
      + `B ${marks[1]}; /equivocation A ${proofs[0]} B ${proofs[1]}; ${client.status(120)}`);
    assert.equal(next.live, true, `the run did not carry on: ${next.answer}`);
    assert.deepEqual(marks, [1, 1]);
    assert.deepEqual(proofs, [204, 204]);
    assert.equal(await chainOn(B, rid, eid), await chainOn(A, rid, eid));
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});

// A MARK BOTH DAEMONS STORED WHILE THIS CLIENT COUNTED NONE OF THEIR ANSWERS (measured live: testnet4
// ea63aa94 @1620, and the control on 0.0.2815, entry 0b68a08f @1140 - all 7 seats stored and receipted the mark, the page
// set no pending link and kept the mark before as its head, and every later mark named that old parent: refused at every
// seat "does not follow the chain head", the rest of the run never carried). No reload, no reconnect: the next mark must
// still chain onto the mark the daemons carry.
test('a mark the daemons stored but whose receipts this client never counted: the head is read back, and the next mark chains onto it on both', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18292, portB: 18293 });
  let t;
  try {
    const named = await joinFromQuery(new URL(round.url).search);
    t = await tab(round, named, { pageNodes: true });
    const { client, rid, eid } = t;
    const [A, B] = [client.base, ...client.peers];
    const own = client.readReceipt.bind(client);
    let drop = false;
    client.readReceipt = (bytes, markId) => {
      if (drop) throw new Error('the receipt never reached this client');
      return own(bytes, markId);
    };
    const links = [];
    for (const tick of [60, 120, 180, 240, 300]) {
      drive(client, 60);
      drop = tick === 180;
      const r = await client.markNow(driven(7, tick), tick);
      drop = false;
      links.push(r);
      await client.awaitPeers();
      console.log(`  tick ${tick}: live ${r.live}, refused ${r.refused.length}, head read back ${r.headRecovered ? r.headRecovered.slice(0, 8) : '-'}`
        + ` | checkpoints A ${await stored(A, rid, eid)} B ${await stored(B, rid, eid)}`);
    }
    // the mark at 180: stored and receipted at both, counted by nobody here - then read back as the head
    assert.equal(links[2].live, false, 'the dropped receipts were counted: not the case the test names');
    assert.equal(links[2].headRecovered, toHex(links[2].id), 'the head was not read back onto the mark both daemons carry');
    assert.equal(client.marksHeadRecovered, 1);
    // and every later mark names it, and is carried by both
    for (const i of [3, 4]) {
      assert.deepEqual(links[i].refused, [], `the mark at ${[60, 120, 180, 240, 300][i]} was refused: ${links[i].refused}`);
      assert.equal(links[i].live, true);
      assert.equal(toHex(links[i].checkpoint.previousHash), toHex(links[i - 1].id), `link ${i} does not name the mark before it`);
    }
    assert.deepEqual([await stored(A, rid, eid), await stored(B, rid, eid)], [5, 5], 'not all five marks are stored on both');
    assert.deepEqual([await equivocation(A, rid, eid), await equivocation(B, rid, eid)], [204, 204], 'a daemon holds a fork proof');
    assert.match(client.status(300), / head read back 1/);
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    await round.close();
  }
});
