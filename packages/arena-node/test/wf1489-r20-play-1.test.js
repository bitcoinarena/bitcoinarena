// kanban #1489 r20-play-1: a stranger who knows a round id and one public entry id opens any number of /play sockets and
// says 'watch' on each. No watcher is bounded per round or per entry, and every honest batch then recomputes the interest set
// (ghosts.setFor: every entry of the round, each its latest picture) once per watcher, on the seat's play thread.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve, GHOST_BACKLOG_BYTES } from '../src/server.js';
import { Ghosts } from '../src/ghosts.js';
import { Round } from '../src/round.js';
import { encodeRoundContract, encodeEntryContract, entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeGhost, ghostBinds, GHOST_BYTES } from '../../arena-protocol/src/ghost.js';
import { GENESIS, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { init, step } from '../../nextblock/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../nextblock/src/state.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { assumeStakeSeen } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = (stakeMsat = 0n) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
// each player's session key (kanban #1503: a batch is taken only signed by it)
const sessionOf = (n) => new Uint8Array(32).fill(n + 1);
const entryFor = (rid, n, stakeMsat = 0n) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: ed25519.getPublicKey(sessionOf(n)), stakeCommitment: b32(7),
  stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x50 + n), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

// THE ROUND'S RANDOMNESS IS THE FIXTURE'S OWN 32 BYTES, exactly as
// `replay.test.js` owns its seed 7. Nothing here says a round's beacon is
// this; the daemon still refuses to invent one, which is the point of asking.
const BEACON = b32(0xbe);
const FUNDED = { funded: () => true, randomnessFor: () => ({ hash: BEACON, height: 900000, timeMs: 900n }) };

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

async function twoIdentities(node, stakeMsat = 0n) {
  const c = contract(stakeMsat);
  const rid = (await post(node.port, '/round', encodeRoundContract(c))).bytes;
  const a = entryFor(rid, 5, stakeMsat);
  const b = entryFor(rid, 9, stakeMsat);
  const joinA = await post(node.port, '/entry', encodeEntryContract(a));
  const joinB = await post(node.port, '/entry', encodeEntryContract(b));
  assumeStakeSeen(node.round, a);
  assumeStakeSeen(node.round, b);
  const eidA = joinA.bytes;
  const eidB = joinB.bytes;
  const batchOf = (eid, n, first, count, previousHash = GENESIS) => {
    const words = wordsAt(n);
    const batch = {
      roundId: rid, entryId: eid, previousHash, firstTick: first,
      ticks: Array.from({ length: count }, (_, i) => words(first + i)), liquidations: [],
    };
    return { bytes: signedBatchOf(batch, (id) => ed25519.sign(id, sessionOf(n))), id: batchId(batch) };
  };
  return { rid, a, b, eidA, eidB, batchOf, joins: [joinA, joinB] };
}

test('#1489-r20-play-1: stranger watchers of one public entry are bounded, and an honest batch does not cost one picture set per stranger', { timeout: 120000 }, async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, ...FUNDED });
  const socks = [];
  try {
    const { rid, eidA, eidB, batchOf } = await twoIdentities(node);
    const player = await talk(node.port);
    const first = batchOf(eidB, 9, 0, 60);
    assert.equal(await player.say(first.bytes), '60');
    // the stranger: N sockets, each watching as player A (a public entry id), never reading what it is pushed
    const N = 200;
    const answers = [];
    for (let i = 0; i < N; i++) {
      const s = await talk(node.port);
      socks.push(s);
      answers.push(await s.say(`watch ${toHex(rid)} ${toHex(eidA)}`));
    }
    const taken = answers.filter((a) => a.startsWith('watching')).length;
    // count the picture-set work one honest batch now costs the seat's thread
    let calls = 0;
    const orig = node.ghosts.setFor.bind(node.ghosts);
    node.ghosts.setFor = (...a) => { calls++; return orig(...a); };
    const t0 = performance.now();
    assert.equal(await player.say(batchOf(eidB, 9, 60, 6, first.id).bytes), '6');
    await new Promise((r) => setTimeout(r, 300));
    const ms = performance.now() - t0;
    console.log('  FACTS r20-play-1:', JSON.stringify({ strangerSockets: N, watchesTaken: taken, setForCallsForOneBatch: calls, ms: Math.round(ms) }));
    assert.ok(taken <= 16, `${taken} of ${N} stranger sockets were taken as watchers of one entry`);
    assert.ok(calls <= 16, `one honest batch cost ${calls} picture-set computations (one per stranger socket)`);
  } finally { for (const s of socks) s.shut(); await node.close(); }
});
