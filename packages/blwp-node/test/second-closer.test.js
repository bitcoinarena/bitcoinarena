// THE SECOND DAEMON TO CLOSE SETTLES A LOST STAKE EVEN WHEN ITS FIRST SHARE ASK CAME TOO EARLY (M3.3-29).
//
// Measured on the regtest rehearsal: in 6 of 21 runs the daemon that closed
// second ended HELD on the loser's stake - "this node has no preimage for that
// stake" - while lnd had settled it through the first. Its one share ask
// reached the first daemon before that daemon's run was final ("no share is
// handed out before the result is final: 1 of 2 agree"), and nothing asked
// again: `watchFinality` stops once no run is short of final, and on the second
// closer the run was final at its own close.
//
// Two named gaps, as the rehearsal's `--close-gap` sends them, on the daemons'
// own 2 s watch. At 800 ms A's one gather at its close misses B's result, B
// closes, is final at once, settles, and asks A for a share A will not hand
// out yet - the race; the test checks it happened, then that B still ends
// SETTLED with the preimage the hold was made for. At 0 ms it is NOT a control
// here, though it is on the rehearsal (0 of 8 HELD): two in-process closes are
// handled one after the other, and before the fix B was still left HELD
// ("B is HELD on the lost stake") - the same race, which the fix also closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD, SETTLED, CANCELLED } from '../src/custody.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeSeated, assumeStakeSeen } from './seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const STAKE = 100000n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// THE TWO PLAYERS, both on close-order's drive. The winner's world secret was
// searched ONCE with the core's own replay (the first of 2000 tried that
// delivers with a score over the round's minScore): DELIVERED by tick 1320,
// score 12. The loser's is close-order's own, which wrecks at tick 547.
const WINNER = { name: 'winner', key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}d1`), ticks: 1320 };
const LOSER = { name: 'loser', key: b32(5), worldSecret: b32(0x16), ticks: 1000 };

/** A Lightning node whose players have paid, and which remembers what it was told to do. */
function paidPort() {
  const amounts = new Map();
  const settled = [];
  const cancelled = [];
  return {
    settled, cancelled,
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a }; },
    async settle({ paymentHash, preimage }) { settled.push({ paymentHash: toHex(paymentHash), preimage: toHex(preimage) }); },
    async cancel({ paymentHash }) { cancelled.push(toHex(paymentHash)); },
  };
}

// A ROUND WITH NO OBJECTION WINDOW: final at the quorum, which is the moment
// this race is about. objection-window.test.js pins the window (M3.3-32); the
// watch's budget is named in `finality` instead.
const contractFor = (nodes) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 0n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/** One player's stake dealt 2-of-2, seated, paid and played on both daemons. */
async function seatAndPlay(daemons, c, rid, who) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, seats: c.nodes, roundId: rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < who.ticks; t++) step(st, ...wordsAt(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of daemons) {
    const took = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    assert.equal(took.status, 201, `${who.name}'s handout: ${await took.text()}`);
    const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, `${who.name}'s entry: ${await seated.text()}`);
    const quote = await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`);
    assert.equal(quote.status, 200, `${who.name}'s invoice: ${await quote.text()}`);
    assumeStakeSeen(d.round, entry);
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, preimage };
}

/**
 * Two daemons on a paying round with a winner and a loser, both closed - the
 * second close sent `gapMs` after the first, as `--close-gap` sends it on the
 * rehearsal - and each on the daemon's own 2 s finality watch.
 */
async function closedWithGap(gapMs) {
  const opts = { funded: () => true, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: 'test port' }),
    finality: { windowMs: 20000 } };
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB });
  const close = async () => { await a.close(); await b.close(); };
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
    const c = contractFor([a.round.pubkey, b.round.pubkey]);
    const rid = roundId(c);
    for (const d of [a, b]) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeSeated(d.round, rid, c.nodes);
    }
    const winner = await seatAndPlay([a, b], c, rid, WINNER);
    const loser = await seatAndPlay([a, b], c, rid, LOSER);

    const first = say(a.port, `close ${toHex(rid)}`);
    if (gapMs) await wait(gapMs);
    const second = say(b.port, `close ${toHex(rid)}`);
    assert.deepEqual(await Promise.all([first, second]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;
    const early = await b.stakes();
    const stateOf = (d, eid) => (d.round.hold(eid) || {}).state;
    const settledBoth = async (ms) => {
      const stop = Date.now() + ms;
      while (Date.now() < stop && !(stateOf(a, loser.eid) === SETTLED && stateOf(b, loser.eid) === SETTLED)) await wait(100);
    };
    return { a, b, portA, portB, winner, loser, early, stateOf, settledBoth, close };
  } catch (err) { await close(); throw err; }
}

const wantOf = (loser) => ({ paymentHash: toHex(loser.entry.stakeCommitment), preimage: toHex(loser.preimage) });
const bigints = (k, v) => (typeof v === 'bigint' ? String(v) : v);

test('closed 800 ms apart: the second closer, refused its first share, ends SETTLED on the lost stake lnd settled through the first', async () => {
  const w = await closedWithGap(800);
  try {
    // THE RACE HAPPENED: B's close was final, settled, and was refused A's share.
    const first = (w.early.actions || []).find((x) => toHex(x.entryId) === toHex(w.loser.eid));
    assert.ok(first, `B's close did not act on the lost stake at all: ${w.early.why || JSON.stringify(w.early, bigints)}`);
    assert.equal(first.state, HELD, `the race did not happen at 800 ms - B's close left it ${first.state}`);
    assert.match(first.why, /no preimage/, 'B held the stake for another reason than the race');

    await w.settledBoth(12000);
    assert.equal(w.stateOf(w.a, w.loser.eid), SETTLED, 'the first closer never settled the lost stake');
    assert.deepEqual(w.portA.settled, [wantOf(w.loser)], 'A released something other than the lost stake\'s own preimage');
    assert.equal(w.stateOf(w.b, w.loser.eid), SETTLED,
      `the second closer is still ${w.stateOf(w.b, w.loser.eid)} on a stake lnd settled through the first: ${(w.b.round.hold(w.loser.eid) || {}).why}`);
    assert.deepEqual(w.portB.settled, [wantOf(w.loser)], 'B released something other than the lost stake\'s own preimage');
    assert.equal(w.stateOf(w.a, w.winner.eid), CANCELLED);
    assert.equal(w.stateOf(w.b, w.winner.eid), CANCELLED);
  } finally { await w.close(); }
});

test('closed at the same moment: both daemons end SETTLED on the lost stake and CANCELLED on the winner\'s', async () => {
  const w = await closedWithGap(0);
  try {
    await w.settledBoth(12000);
    assert.equal(w.stateOf(w.a, w.loser.eid), SETTLED, `A is ${w.stateOf(w.a, w.loser.eid)} on the lost stake`);
    assert.equal(w.stateOf(w.b, w.loser.eid), SETTLED, `B is ${w.stateOf(w.b, w.loser.eid)} on the lost stake`);
    assert.deepEqual(w.portA.settled, [wantOf(w.loser)]);
    assert.deepEqual(w.portB.settled, [wantOf(w.loser)]);
    assert.equal(w.stateOf(w.a, w.winner.eid), CANCELLED);
    assert.equal(w.stateOf(w.b, w.winner.eid), CANCELLED);
  } finally { await w.close(); }
});
