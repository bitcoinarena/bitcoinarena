// A SECOND IDENTITY'S TRUCK ARRIVES ON THE SOCKET.
//
// Slice 1 made a picture; nothing could be sent one. The /play socket was
// anonymous - batches in, a number back - so the daemon had no way to address
// anybody, and it had never pushed a byte to a connection in its life. Two
// things change here and nothing else: a connection can say who it is, and a
// connection that has said gets the interest set.
//
// 0.10 is the rule the whole thing exists under: another player's truck is a
// PICTURE. It is never an input to my simulation, and every one of these
// frames came out of `ghosts.js` -> `replay.js`, the one door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Ghosts } from '../src/ghosts.js';
import { Round } from '../src/round.js';
import { encodeRoundContract, encodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { decodeGhost, ghostBinds, GHOST_BYTES } from '../../protocol/src/ghost.js';
import { GENESIS, decodeTranscript } from '../../protocol/src/transcript.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex } from '../../protocol/src/hash.js';
import { init, step } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../core/src/state.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid, n) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: b32(n + 1), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x50 + n),
});

// THE ROUND'S RANDOMNESS IS THE FIXTURE'S OWN 32 BYTES, exactly as
// `replay.test.js` owns its seed 7. Nothing here says a round's beacon is
// this; the daemon still refuses to invent one, which is the point of asking.
const BEACON = b32(0xbe);
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: BEACON, height: 900000 }) };

const wordsAt = (n) => (t) => [45875, ((t * (977 + n)) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
};

/** A socket that KEEPS what it was sent, because pushes are the measurement. */
const talk = (port) => new Promise((resolve) => {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/play`);
  sock.binaryType = 'arraybuffer';
  const said = [];
  const pushed = [];
  const texts = [];
  // TEXT IS AN ANSWER, BYTES ARE A PUSH. The daemon answers `watch` in words
  // and pushes GHOSTS frames as bytes, and a helper that resolved the next
  // message whatever it was would hand a picture back as the answer to a
  // question - which is exactly what it did the first time.
  sock.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return pushed.push(new Uint8Array(e.data));
    const waiting = said.shift();
    if (waiting) return waiting(e.data);
    return texts.push(e.data);
  });
  sock.addEventListener('open', () => resolve({
    pushed, texts,
    say: (m) => new Promise((r) => { said.push(r); sock.send(m); }),
    // A push has no reply to wait on, so this waits for the socket to be quiet
    // rather than for a count - a test that waits for N frames cannot notice
    // an N+1th it should not have had.
    settle: () => new Promise((r) => setTimeout(r, 60)),
    shut: () => sock.close(),
  }));
});

/** The player's own run, driven straight off the core with their own seed. */
function drove(entry, ticks, n) {
  const st = init(seedWordForEntry(entry, BEACON));
  const at = new Map();
  const words = wordsAt(n);
  for (let t = 0; t < ticks; t++) {
    step(st, ...words(t));
    at.set(t, { x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z], heading: st.i32[O_TRUCK + T_HEADING] });
  }
  return at;
}

async function twoIdentities(node) {
  const c = contract();
  const rid = (await post(node.port, '/round', encodeRoundContract(c))).bytes;
  const a = entryFor(rid, 5);
  const b = entryFor(rid, 9);
  const eidA = (await post(node.port, '/entry', encodeEntryContract(a))).bytes;
  const eidB = (await post(node.port, '/entry', encodeEntryContract(b))).bytes;
  const batchOf = (eid, n, first, count, previousHash = GENESIS) => {
    const words = wordsAt(n);
    const batch = {
      roundId: rid, entryId: eid, previousHash, firstTick: first,
      ticks: Array.from({ length: count }, (_, i) => words(first + i)), liquidations: [],
    };
    return { bytes: encodeInputBatch(batch), id: batchId(batch) };
  };
  return { rid, a, b, eidA, eidB, batchOf };
}

test('a second identity\'s ghost arrives on the socket, carrying the truck the core reached', async () => {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const { rid, b, eidA, eidB, batchOf } = await twoIdentities(node);
    const viewer = await talk(node.port);
    const other = await talk(node.port);

    // NOTHING IS SENT BEFORE A CONNECTION SAYS WHO IT IS.
    //
    // 120 ticks, not 40: this fixture holds the brake for the first forty, so
    // a run that short ends where it started and "the picture is at the right
    // tick" would be true of every tick in it.
    assert.equal(await other.say(batchOf(eidB, 9, 0, 120).bytes), '120');
    await viewer.settle();
    assert.equal(viewer.pushed.length, 0, 'a ghost was pushed to a connection that never subscribed');

    // SPAWN: the viewer subscribes and is shown the truck already driving.
    const answer = await viewer.say(`watch ${toHex(rid)} ${toHex(eidA)}`);
    assert.equal(answer, 'watching 1', `expected one ghost on subscribing, got ${answer}`);
    assert.equal(viewer.pushed.length, 1);

    const g = decodeGhost(viewer.pushed[0]);
    assert.equal(viewer.pushed[0].length, GHOST_BYTES);
    assert.deepEqual(toHex(g.entryId), toHex(eidB), 'that is not the other identity');
    assert.equal(g.tick, 119, 'the picture is not at the last tick that identity published');

    // AND IT IS THE CORE'S OWN TRUCK, from a direct drive of that entry's
    // inputs under that entry's own seed.
    const truck = drove(b, 120, 9);
    assert.equal(g.x, truck.get(119).x, 'x is not the core\'s');
    assert.equal(g.z, truck.get(119).z, 'z is not the core\'s');
    assert.equal(g.heading, truck.get(119).heading, 'heading is not the core\'s');
    assert.notEqual(g.x, truck.get(118).x, 'this run does not move, so the tick proves nothing');

    // AND A STRANGER COULD CHECK IT: the same frame binds against the
    // transcript the node holds for that entry.
    const bound = ghostBinds(g, decodeTranscript(node.round.handOver(rid, eidB).bytes), b);
    assert.equal(bound.ok, true, bound.why);

    viewer.shut(); other.shut();
  } finally { await node.close(); }
});

test('a new batch shows the subscriber the new picture, and never their own', async () => {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const { rid, eidA, eidB, batchOf } = await twoIdentities(node);
    const viewer = await talk(node.port);
    const other = await talk(node.port);

    assert.equal(await viewer.say(`watch ${toHex(rid)} ${toHex(eidA)}`), 'watching 0',
      'a picture was made of a run with no published inputs');

    const first = batchOf(eidB, 9, 0, 40);
    assert.equal(await other.say(first.bytes), '40');
    await viewer.settle();
    assert.equal(viewer.pushed.length, 1, 'the batch did not become a picture');
    assert.equal(decodeGhost(viewer.pushed[0]).tick, 39);

    // A SECOND BATCH IS A SECOND PICTURE, at the tick it reached.
    assert.equal(await other.say(batchOf(eidB, 9, 40, 25, first.id).bytes), '25');
    await viewer.settle();
    assert.equal(viewer.pushed.length, 2);
    assert.equal(decodeGhost(viewer.pushed[1]).tick, 64);

    // AND THE VIEWER'S OWN RUN IS NOT A PICTURE THEY ARE SENT. A player does
    // not need a picture of the truck they are driving, and `interestSet`
    // drops the viewer by entry id.
    assert.equal(await viewer.say(batchOf(eidA, 5, 0, 30).bytes), '30');
    await viewer.settle();
    assert.equal(viewer.pushed.length, 2, 'the viewer was sent a picture of their own truck');
    assert.equal(viewer.pushed.some((f) => toHex(decodeGhost(f).entryId) === toHex(eidA)), false);

    viewer.shut(); other.shut();
  } finally { await node.close(); }
});

test('a watch names a round and an entry, or it is refused by name', async () => {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const { rid, eidA, eidB } = await twoIdentities(node);
    const sock = await talk(node.port);

    assert.match(await sock.say('watch'), /a watch names a round and an entry/);
    assert.match(await sock.say(`watch ${toHex(rid)} beef`), /a watch names a round and an entry/);
    assert.match(await sock.say(`watch ${toHex(b32(0x77))} ${toHex(eidA)}`), /no such round/);
    assert.match(await sock.say(`watch ${toHex(rid)} ${toHex(b32(0x78))}`), /no such entry/);

    // ONE CONNECTION IS ONE IDENTITY. Letting a socket re-declare itself would
    // make "never a picture of yourself" mean nothing: watch as A, be shown B,
    // then become B and be shown A.
    assert.equal(await sock.say(`watch ${toHex(rid)} ${toHex(eidA)}`), 'watching 0');
    assert.match(await sock.say(`watch ${toHex(rid)} ${toHex(eidB)}`),
      /already watching as another entry/);
    // and saying the same thing twice is not an error
    assert.equal(await sock.say(`watch ${toHex(rid)} ${toHex(eidA)}`), 'watching 0');

    sock.shut();
  } finally { await node.close(); }
});

test('a round with no randomness yet shows nobody anything', async () => {
  // The daemon does not invent a beacon (verify.js says why at length), and a
  // picture needs the world seed the beacon mixes. So the honest answer is no
  // picture, not a truck in a world nobody else can reproduce.
  const node = await serve(openStore(), { port: 0, funded: () => true });
  try {
    const { rid, eidA, eidB, batchOf } = await twoIdentities(node);
    const viewer = await talk(node.port);
    const other = await talk(node.port);
    assert.equal(await viewer.say(`watch ${toHex(rid)} ${toHex(eidA)}`), 'watching 0');
    assert.equal(await other.say(batchOf(eidB, 9, 0, 40).bytes), '40');
    await viewer.settle();
    assert.equal(viewer.pushed.length, 0, 'a world was seeded out of nothing');

    const made = node.ghosts.latest(rid, eidB);
    assert.equal(made.ok, false);
    assert.match(made.why, /no randomness yet/);
    viewer.shut(); other.shut();
  } finally { await node.close(); }
});

test('the subscriber is shown the interest set, not the whole field', async () => {
  // K is a node's bandwidth policy (piece 3), so it is measured on the service
  // the socket uses rather than by opening twenty sockets.
  const round = new Round(openStore(), () => 1234);
  const c = contract();
  const rid = round.open(c);
  const ghosts = new Ghosts(round, { randomnessFor: () => ({ hash: BEACON }), limit: 2 });

  const ids = [];
  for (let n = 10; n < 16; n++) {
    const e = entryFor(rid, n);
    const eid = round.enter(e);
    ids.push({ eid, e, n });
    const words = wordsAt(n);
    round.batch(encodeInputBatch({
      roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 20 }, (_, i) => words(i)), liquidations: [],
    }));
  }

  const shown = ghosts.setFor(rid, ids[0].eid);
  assert.equal(shown.length, 2, `the budget is 2 and ${shown.length} were shown`);
  assert.equal(shown.some((f) => toHex(f.entryId) === toHex(ids[0].eid)), false,
    'the viewer is in their own interest set');
  assert.equal(new Set(shown.map((f) => toHex(f.entryId))).size, shown.length,
    'the same truck was shown twice');

  // and the whole field really is bigger than what was shown
  assert.equal(round.entriesOf(rid).length, 6);

  // EVERY PICTURE STILL BINDS, so what a budget drops is bandwidth and never
  // the check.
  for (const frame of shown) {
    const who = ids.find((i) => toHex(i.eid) === toHex(frame.entryId));
    const bound = ghostBinds(decodeGhost(frame.bytes),
      decodeTranscript(round.handOver(rid, frame.entryId).bytes), who.e);
    assert.equal(bound.ok, true, bound.why);
  }
});

test('a tick past the published inputs is refused on the socket path too', async () => {
  const round = new Round(openStore(), () => 1234);
  const rid = round.open(contract());
  const e = entryFor(rid, 11);
  const eid = round.enter(e);
  const ghosts = new Ghosts(round, { randomnessFor: () => ({ hash: BEACON }) });

  // no inputs yet: no picture, and the reason is that rather than "no tick"
  assert.match(ghosts.latest(rid, eid).why, /published no inputs/);
  assert.equal(ghosts.setFor(rid, eid).length, 0);

  const words = wordsAt(11);
  round.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 20 }, (_, i) => words(i)), liquidations: [],
  }));

  assert.equal(ghosts.frameFor(rid, eid, 19).ok, true);
  assert.match(ghosts.frameFor(rid, eid, 20).why, /not one the published inputs cover/);
  assert.match(ghosts.frameFor(rid, eid, 9999).why, /not one the published inputs cover/);

  // AND A PICTURE IS MADE ONCE. A replay is minutes of simulation; a
  // subscriber asking twice must not cost twice.
  const made = ghosts.made;
  ghosts.frameFor(rid, eid, 19);
  assert.equal(ghosts.made, made, 'the same tick was replayed twice');
  assert.equal(ghosts.served > 0, true);
});

test('a subscriber of one round is not shown another round\'s trucks', () => {
  // Found by a mutant that survived: dropping the round filter in the push
  // broke nothing, because every test had one round in play. A daemon serves
  // many, and a picture from a round you are not in is a truck from another
  // world - the private world of 0.9 is per round, not per node.
  const round = new Round(openStore(), () => 1234);
  const ghosts = new Ghosts(round, { randomnessFor: () => ({ hash: BEACON }) });

  const mine = round.open(contract());
  const other = round.open({ ...contract(), censusHeight: 900001 });
  assert.notEqual(toHex(mine), toHex(other), 'the fixture opened the same round twice');

  const drive = (rid, n) => {
    const e = entryFor(rid, n);
    const eid = round.enter(e);
    const words = wordsAt(n);
    round.batch(encodeInputBatch({
      roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
      ticks: Array.from({ length: 60 }, (_, i) => words(i)), liquidations: [],
    }));
    return eid;
  };
  const viewer = drive(mine, 20);
  const neighbour = drive(mine, 21);
  const stranger = drive(other, 22);

  const shown = ghosts.setFor(mine, viewer);
  assert.deepEqual(shown.map((f) => toHex(f.entryId)), [toHex(neighbour)],
    'a round showed somebody else\'s round');
  assert.equal(shown.some((f) => toHex(f.entryId) === toHex(stranger)), false);
});
