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

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { Client, receiptsForLive } from '../src/client.js';
import { joinFromQuery, tabIdentity, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { toHex } from '../../protocol/src/hash.js';
import { NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
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

/** A seated, connected tab - exactly the page's steps, with the page's node list or without it. */
async function tab(round, named, { pageNodes }) {
  const secret = ed25519.utils.randomSecretKey();
  const player = tabIdentity({ storage: storage(), random, curve: feldmanGroup });
  const seat = entryFor(named.round, { playerPubkey: player.pubkey, random });
  // `nodes` is what the page's wrapper of `Client.at` adds (`index.html`): the
  // round's node list, `window.BLWP_NODES`. Without it, the Daily before this.
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
  const entry = { ...seat, roundId: rid, sessionPubkey: ed25519.getPublicKey(secret) };
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
    assert.deepEqual(client.peerSeats.map((s) => s.ok), [true],
      `B did not seat the entry: ${JSON.stringify(client.peerSeats)}`);

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

test('a client that reaches one daemon of two is refused past its first link, and says so', async () => {
  // THE DAILY BEFORE THE FAN-OUT, reproduced: no page node list, so no peers.
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
    assert.match(second.answer, /chain head/, `the second link was not refused for the head: ${second.answer}`);

    const at = [await stored(client.base, rid, eid), await stored(other, rid, eid)];
    const held = [await heldTicks(client.base, rid, eid), await heldTicks(other, rid, eid)];
    console.log(`  one daemon: checkpoints A ${at[0]} B ${at[1]}, inputs A ${held[0]} B ${held[1]}; `
      + `refused: ${client.marksRefusedWhy}`);
    assert.deepEqual(at, [1, 0]);
    assert.deepEqual(held, [120, 0]);

    // AND THE PAGE'S LINE NO LONGER HIDES IT.
    assert.equal(client.marksSent, 1);
    assert.equal(client.marksAccepted, 0);
    assert.equal(client.marksRefused, 1);
    assert.match(client.status(120), / refused 1\b/);
    assert.match(client.marksRefusedWhy, /chain head/);
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
    // batch is refused for the seat, the seat is given, and its feed stops
    // there until the next try.
    client.deliverTo(named.nodes);
    drive(client, 60);
    await publishAll(client);
    assert.equal(client.peerBatchesRefused, 1, 'B was expected to refuse once, for the missing seat');
    assert.match(client.peerBatches()[0].why, /no such entry/);
    assert.match(client.status(120), / inputs refused 1\b/, 'a refused input was not on the line');
    assert.equal(await heldTicks(B, rid, eid), 0, 'B is seated and holds nothing yet');

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
    assert.match(line, / inputs refused \d+/, 'the refused inputs to B are not on the line');
  } finally {
    if (t) { t.client.ended = true; t.client.close(); }
    try { await round.close(); } catch { /* B was already stopped */ }
  }
});
