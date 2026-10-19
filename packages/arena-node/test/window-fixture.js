// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OBJECTION WINDOW'S DAEMONS AND PLAYERS, shared by objection-window.test.js
// (M3.3-32) and publication-finality.test.js (P2): one daemon on a seven-signer node
// round whose other six keys the test holds. Its rounds are FEDERATION, the one custody
// (§23.6); the paid fake Lightning its hold-invoice tests ran on went with them.
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { CLOCK } from './block-clock.js';
import { testNow, skipTo } from './test-clock.js';
import { OBJECTION_WINDOW_MS } from '../../arena-protocol/src/window.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { resultFinality } from '../src/finality.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
// THE RUN LENGTH IS THE CORE'S (2026-09-20). This fixture said 9000 and the core has ended a run at 10800
// since c01cc655 ("a round is three minutes"). `Round.open` refuses a contract that disagrees with the core
// it names, so every round built here was 400 at `POST /round` and every suite below it died before a stake
// was dealt - twenty-three of them. A fixture must not carry its own copy of a number the core owns.
import { BLOCK_TICKS as RUN_TICKS } from '../../nextblock/src/rules/gate.js';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { randomBytes } from 'node:crypto';
// the driver below steers at the core's own gate, in the core's own units
import { CORE } from '../../nextblock/src/adapter.js';
import { GATE_X } from '../../nextblock/src/rules/gate.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned, assumeStakeSeen } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import {
  SIGNED_RECEIPT_BYTES, encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../arena-protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../arena-protocol/src/result.js';
import { init, step, submitLoad } from '../../nextblock/src/sim.js';

// THE SCRIPTED PLAYERS' BED (C is the bed fill since 2026-10-04: an undeclared load is an empty bed, and an empty bed
// scores 0): declared at tick 0 as a load of no fee and no BTC - heat 0, where these tapes were recorded - and 0.7 of the
// 6 m bed, so C is the 45875 they were measured at. In the batch, so the signer nodes' replay sets the same C.
export const FIXTURE_ROOM = 275250;
export const loaded = (st) => { submitLoad(st, 0, 0, FIXTURE_ROOM); return st; };
export const bedFrom = (from) => (from === 0 ? [[0, 0, 0, FIXTURE_ROOM]] : []);
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeTranscriptPosting, transcriptPostingId, joinSignedPosting } from '../../arena-protocol/src/posting.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun, decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { HOSTED } from './plugins/hosted.js';

export const b32 = (n) => new Uint8Array(32).fill(n);

/**
 * THE ENTRY'S FEE SECRET (§23.5), WHICH IS NOT ZERO AND NOT SHARED.
 *
 * The node fee travels in its own lock, and on Lightning custody that lock is a hold invoice keyed on
 * `sha256(entry.feePreimage)`. Fixtures used to leave F at thirty-two zero bytes, so every paying entry
 * they built asked for a hold on `66687aad...` - not that entry's hash but every zero-F entry's, in
 * every round. Measured on two players of one round: 2 fee holds, 1 payment hash, both settled on a
 * preimage anybody can compute. Real lnd refuses it outright ("cannot use hash of all-zeroes
 * preimage", `join.js:833`) and the shipped client mints a random one on a paying round.
 *
 * Derived from the player's own stake preimage rather than random, so entry ids stay deterministic.
 */
export const feeSecretOf = (preimage) => {
  const seed = new Uint8Array(preimage.length + 2);
  seed.set(preimage, 0);
  seed.set([0x23, 0x05], preimage.length);
  return sha256(seed);
};
export const rand = (n) => new Uint8Array(randomBytes(n));
export const RANDOMNESS = b32(0x9b);
export const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
export const GENESIS_HASH = (await import('../../arena-protocol/src/transcript.js')).GENESIS;
// THE FIXTURE'S DRIVER AIMS AT THE CORE'S OWN GATE (2026-09-21).
//
// This was `[45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0]` - seven tenths throttle,
// a steering wheel sawing back and forth, and the brake held for 40 ticks in every 700. It was written when
// the drop-off was close; the world has since grown east and it never arrives. MEASURED off the core, with
// no server and no federation: it reaches x 145.9 m at its furthest and ends FAILED with score 2, while
// `arrived` wants `x >= GATE_X` (168.6 m) AND `|z| <= HALF_MOUTH` (34 m) - and the truck SPAWNS at z 71.4 m,
// so the miss was never three metres of x, it was the mouth. Nineteen tests across five suites read
// DELIVERED off this program.
//
// It is not re-tuned by hand. The driver steers at the gate the core publishes, in the core's own units -
// heading is a fraction of a turn in Q16.16, 0.25 being +x - so the day the world moves again, this follows
// it. `LEAD` aims past the gate rather than at it, because a truck that turns towards a point it is already
// on steers into the doorframe; 20 m was the shortest lead measured that still arrives.
//
// The tape is closed-loop in the WINNER's world and then handed out as fixed words, which is what the
// protocol needs: every signer node replays the same bytes. Measured on this tape - winner DELIVERED at tick
// 1018 of its 1320, score 5, z -0.4 (the middle of the mouth); loser still running at its 1000, x 159.8,
// z -54.0, outside the mouth, as a loser should be.
const TAPE = [];
let _tapeState = null;
const LEAD_M = 20, STEER_GAIN = 6;
export const wordsAt = (t) => {
  while (TAPE.length <= t) {
    if (_tapeState === null)
      _tapeState = loaded(init(seedWordForEntry({ playerPubkey: WINNER.key, worldSecret: WINNER.worldSecret, joinTick: 0 }, RANDOMNESS)));
    const p = CORE.picture(_tapeState);
    const x = p.x / 65536, z = p.z / 65536, heading = p.heading / 65536;
    let off = Math.atan2(GATE_X / 65536 + LEAD_M - x, -z) / (2 * Math.PI) - heading;
    off -= Math.round(off);                                   // the short way round, in turns
    const steer = Math.max(-65536, Math.min(65536, Math.round(off * STEER_GAIN * 65536)));
    const words = [65536, steer, 0, 0, 0];                    // throttle, steer, brake, handbrake, practice
    TAPE.push(words);
    step(_tapeState, ...words);
  }
  return TAPE[t];
};

/**
 * THE SCRIPTED WINNER UNDER A ROUND'S OWN BEACON. A paying round seeds its players from the beacon its bonded chain
 * names (1847956a), not from RANDOMNESS, so the tape above - closed-loop in RANDOMNESS's world - steered another world
 * and the winner stopped delivering: nineteen tests read FAILED, score 0, "recorded inputs, another run's beacon". The
 * same driver, run closed-loop in the world the signer nodes will replay; the world secret's last byte counts up from
 * WINNER's to the first whose drive delivers with a score by `ticks` (measured under RANDOMNESS: about one byte in eight
 * does, 0.2 s each). Anyone else, or no beacon, plays the tape above unchanged. Harness only.
 */
const _beaconWinners = new Map();
const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
/**
 * THE SAME SEARCH, YIELDING between worlds, so the daemons in this process keep answering while it runs; it fills the
 * cache `playFor` reads. Every play path awaits it first.
 */
export async function warmPlay(who, randomness) {
  if (!randomness || sameBytes(randomness, RANDOMNESS) || !sameBytes(who.key, WINNER.key) || !sameBytes(who.worldSecret, WINNER.worldSecret)) return;
  const key = `${Buffer.from(randomness).toString('hex')}:${who.ticks}`;
  for (let n = 0; n < 256 && !_beaconWinners.has(key); n++) {
    const worldSecret = Uint8Array.from(WINNER.worldSecret);
    worldSecret[31] = (WINNER.worldSecret[31] + n) & 255;
    const run = drivenTape(seedWordForEntry({ playerPubkey: who.key, worldSecret, joinTick: 0 }, randomness), who.ticks);
    if (run.outcome === 'DELIVERED' && run.score > 0) _beaconWinners.set(key, { worldSecret, words: (t) => run.tape[t], score: run.score });
    await new Promise((r) => setImmediate(r));
  }
}

/**
 * N QUALIFIERS UNDER A ROUND'S BEACON, for the pool's ranks: real player keys (the secret 0x30 + i), each driven
 * closed-loop in the first world of its own whose drive delivers with a score, n distinct scores, the highest first.
 * Each carries its words, which `playFor` hands back. Searched yielding, as `warmPlay` is.
 */
export async function qualifiersUnder(randomness, n, ticks = WINNER.ticks) {
  const out = [];
  for (let i = 0; out.length < n && i < 64; i++) {
    const key = schnorr.getPublicKey(b32(0x30 + i));
    for (let last = 0; last < 256; last++) {
      const worldSecret = Uint8Array.from(WINNER.worldSecret); worldSecret[31] = last;
      const run = drivenTape(seedWordForEntry({ playerPubkey: key, worldSecret, joinTick: 0 }, randomness), ticks);
      await new Promise((r) => setImmediate(r));
      if (run.outcome !== 'DELIVERED' || !(run.score > 0) || out.some((q) => q.score === run.score)) continue;
      out.push({ name: `q${run.score}`, key, worldSecret, ticks, score: run.score, words: (t) => run.tape[t] });
      break;
    }
  }
  if (out.length < n) throw new Error(`${out.length} of ${n} qualifiers found under this beacon`);
  return out.sort((a, b) => b.score - a.score);
}

export function playFor(who, randomness) {
  const plain = { worldSecret: who.worldSecret, words: who.words || wordsAt };
  if (!randomness || sameBytes(randomness, RANDOMNESS) || !sameBytes(who.key, WINNER.key) || !sameBytes(who.worldSecret, WINNER.worldSecret)) return plain;
  const key = `${Buffer.from(randomness).toString('hex')}:${who.ticks}`;
  if (_beaconWinners.has(key)) return _beaconWinners.get(key);
  for (let n = 0; n < 256; n++) {
    const worldSecret = Uint8Array.from(WINNER.worldSecret);
    worldSecret[31] = (WINNER.worldSecret[31] + n) & 255;
    const run = drivenTape(seedWordForEntry({ playerPubkey: who.key, worldSecret, joinTick: 0 }, randomness), who.ticks);
    if (run.outcome !== 'DELIVERED' || !(run.score > 0)) continue;
    const got = { worldSecret, words: (t) => run.tape[t], score: run.score };
    _beaconWinners.set(key, got);
    return got;
  }
  throw new Error('no world under this beacon where the scripted winner delivers');
}

/**
 * THE DRIVER, CLOSED-LOOP IN ONE WORLD: `ticks` words steered at the gate from the truck's own picture in the world
 * `seedWord` seeds, and what the core says the run came to - DELIVERED with its score, FAILED, or null (still running).
 * Past the run's end the words are idle; the tape is always `ticks` long.
 */
export function drivenTape(seedWord, ticks) {
  const st = loaded(init(seedWord));
  const tape = [];
  let ended = null;
  // THE CORE IS NOT STEPPED PAST THE RUN'S END: a failed world costs only its own ticks (a search runs on the daemons'
  // thread - measured, 7.1 s stepping every world to the end held the loop past the servers' keep-alive, ECONNRESET).
  for (let t = 0; t < ticks; t++) {
    if (ended) { tape.push([0, 0, 0, 0, 0]); continue; }
    const words = driverWords(st);
    tape.push(words);
    step(st, ...words);
    const r = CORE.result(st); if (r.outcome) ended = r;
  }
  return { tape, outcome: ended ? ended.outcome : null, score: ended ? ended.score : 0 };
}

/** The driver's five words from the truck's picture: full throttle, steered at the gate past its lead. */
function driverWords(st) {
  const p = CORE.picture(st);
  const x = p.x / 65536, z = p.z / 65536, heading = p.heading / 65536;
  let off = Math.atan2(GATE_X / 65536 + LEAD_M - x, -z) / (2 * Math.PI) - heading;
  off -= Math.round(off);
  return [65536, Math.max(-65536, Math.min(65536, Math.round(off * STEER_GAIN * 65536))), 0, 0, 0];
}

export const STAKE = 100000n;
export const WINDOW_MS = 3000;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// second-closer's two players: the winner DELIVERS by tick 1320, the loser
// wrecks before tick 1000. RE-MEASURED with the armour doctrine (WAR_TACTICS.md part A, 2026-09-16): the old
// winner (last byte d1) delivered at tick 1270 and now WRECKS at tick 284 on a tank holding the outer lane in
// front of the bay (§1.2: the outer slots are not moved away from the bay). Of the 255 last bytes 01..ff with
// this drive, two deliver by 1320: 1d (tick 1173, score 367) and a9 (1156, 160); the first is taken. The
// loser now wrecks at tick 956, score 420 (was 547, 128).
//
// RE-MEASURED AGAIN 2026-09-19, and BOTH halves had to be re-picked. Bisected: the drive stopped delivering at
// 1830888, the 20:30 hold cadence (§2.6 legs 12-20 s, §4.3 scoot 1200 ticks, §4.10 push only with both tanks on
// post and only on a confirmed verdict) - armour inputs, not settlement. 1d went DELIVERED score 367 -> WRECKED
// score 173 at tick 840 there, and by HEAD it wrecks at tick 192 with score 0, barely out of the bay; 0x16 stopped
// wrecking at all and sat LIVE at tick 1000 with score 304. The cadence is kept and the fixture moves, the same
// deliberate re-pick as before.
// Of the 255 last bytes, TEN now deliver by 1320 and the best scores 34: 6d (tick 1182, score 34, hp 69.48) is
// taken, ahead of d1 (1196, 32) and e6 (1245, 32). The army is simply harder than it was - 367 is not available at
// any last byte, and no number was invented to keep it. For the loser, 129 of 255 wreck before 1000; c0 is taken
// (wrecks at 865, score 24), which keeps the old shape of a run that earns something and then dies, with margin
// before the batch's 1000 ticks.
export const WINNER = { name: 'winner', key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}6d`), ticks: 1320 };
export const LOSER = { name: 'loser', key: b32(5), worldSecret: b32(0xc0), ticks: 1000 };

// THE START DEADLINE THESE ROUNDS NAME (§15, a late start): every player here
// plants ONE first mark at the end of its run, so the round names a deadline
// past it (planted-marks.js says why); the omitted default is not moved.
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
export { PLANTED_FIRST_MARK_DEADLINE };

/**
 * A FIXTURE ROUND IN THE PRESENT (§13C, RULED 2026-09-24): the result window opens at the first block at or after
 * the round's contract end (protocol roundEndMs) - so a round whose times sit in 1970 has no block on the fixtures' chain
 * and nothing is ever decided. This shifts committee time, start and entry close by one offset so that roundEndMs lands at
 * `endMs`; every interval between them is kept. Harness only: the protocol is not changed to keep the old times.
 */
export function presentDay(contract, endMs) {
  const shift = BigInt(endMs) - roundEndMs(contract);
  return { ...contract, committeeTimeMs: contract.committeeTimeMs + shift, startTimeMs: contract.startTimeMs + shift,
    entryCloseMs: contract.entryCloseMs + shift };
}

// THE OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED 2026-10-01): whatever a caller still
// passes as its second argument, the contract says 600000 - any other number is an invalid contract the node refuses. A
// test about that refusal sets the field itself.
export const contractFor = (nodes, _windowNoLongerChosen, publicationRelays = []) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE,
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  // FEDERATION, NAMING TEST_FEDERATION_ID: the one custody this network has (RULED 2026-09-22 22:59 -
  // THRESHOLD_LN does not exist).
  entryCloseMs: 2000n, objectionWindowMs: OBJECTION_WINDOW_MS, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: RUN_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

export const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

export const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/** One player's stake dealt at `needed` to every signer node, joined, paid and played on `daemons`. */
export async function joinAndPlay(daemons, c, rid, who, needed, { direct = false, donationMsat = 0n, port = null, randomness = RANDOMNESS } = {}) {
  await warmPlay(who, randomness);
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, signerNodes: c.nodes, roundId: rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat,
    joinTick: 0, worldSecret: playFor(who, randomness).worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  // ON A SIGNER NODE THAT REACHES A FEDERATION (`port`, the lock fixture's; RULED 2026-09-25) the entry arrives as production
  // shapes it: its stake locked to its point and its 2% fee locked to H(F), both in that federation - the round mints fee
  // locks, and the entry door takes no staked entry that names none.
  if (port) {
    const feeSecret = rand(32);
    Object.assign(entry, { feePreimage: feeSecret, stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: rand(32), outIdx: 1n } });
    const claimPk = new Uint8Array(33).fill(2);
    await port.put(entry.stakeLockOutpoint, { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
      claimPk, refundPk: refundKeyOf(who.key), expiration: port.height + 200 });
    await port.put(entry.feeLockOutpoint, { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
      claimPk, refundPk: refundKeyOf(who.key), expiration: port.height + 200 });
  }
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: who.ticks }, (_, t) => playFor(who, randomness).words(t)), liquidations: [], loads: bedFrom(0) };
  // THE SEED IS THE ROUND'S BEACON when the caller names it (a bonded chain's), the fixtures' RANDOMNESS otherwise.
  const st = loaded(init(seedWordForEntry(entry, randomness || RANDOMNESS)));
  for (let t = 0; t < who.ticks; t++) step(st, ...playFor(who, randomness).words(t));
  const mark = { roundId: rid, entryId: eid, tick: who.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of daemons) {
    const took = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    assert.equal(took.status, 201, `${who.name}'s handout: ${await took.text()}`);
    if (direct) {
      // JOINED BEFORE THE RELAY RULE: the door refuses a stake in a paying
      // round naming no relay now, so a test about one kept from before stores
      // the entry, and the stake it saw, the way they were kept.
      d.round.enter(entry);
      assumeStakeSeen(d.round, entry);
    } else {
      const joined = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      assert.equal(joined.status, 201, `${who.name}'s entry: ${await joined.text()}`);
      // THE STAKE IS A LOCK IN THE ROUND'S FEDERATION (§23.1 step 5), which a signer node verifies there;
      // no federation runs here, and these tests are about what follows a paid entry, not the verifying -
      // so the stake is taken as seen, as the lock fixtures do. The hold invoice this used to be asked for
      // (`/invoice`, `/stake` on the node's own Lightning) went with THRESHOLD_LN (§23.6).
      assumeStakeSeen(d.round, entry);
    }
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  // `otherFirstMark`: the player's SECOND first mark of this entry - the same tick, another state - signed by its session
  // key: with the first, §13B's portable proof of two first marks.
  const otherFirstMark = () => {
    const other = { ...mark, stateHash: sha256(mark.stateHash) };
    return joinSigned(encodeCheckpoint(other), ed25519.sign(checkpointId(other), session));
  };
  return { eid, entry, preimage, mid: checkpointId(mark), signedMark, otherFirstMark };
}

// AND THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED 2026-09-24): every daemon started with these opts reads the block clock.
// THE BEACON AFTER THE ROUND'S OWN COMMITTEE TIME: the same hash and height, timed 400 ms after it - for the fixtures'
// 1970 contracts that is the 900 it always was; a round moved to the present (`presentDay`) gets one after its own time.
const beaconFor = (q) => ({ ...BEACON, timeMs: q && q.contract && typeof q.contract.committeeTimeMs === 'bigint' ? q.contract.committeeTimeMs + 400n : BEACON.timeMs });
// AND THE SHARED CLOCK THAT SKIPS (test-clock.js, WINDOW-10-SPEC): every fixture daemon's round store reads it.
export const opts = { funded: () => true, randomnessFor: beaconFor, windowChain: CLOCK.chainView(), roundClock: testNow };
/**
 * ONE DAEMON ON A SEVEN-SIGNER NODE ROUND, the other six signer nodes' keys this test holds.
 * Two losers play on it and it signs its own result for each; then `sign` has
 * five of the other signer nodes sign - the same run it did, or a rewritten one - and
 * the run is PROVISIONALLY_FINAL on it.
 */
// `endMs`: put the round's end (protocol roundEndMs) at that instant (presentDay) - a window test's round, whose 600 s
// window is read on the wall clock; left out, the round sits in 1970 as it always did, its windows long closed.
// `peers` (test-only): where the holder asks its peers, as serve's `peers` - a counting fake in that test.
export async function sevenSignerNodes(windowMs, relays, { storedBeforeTheRule = false, finality = null, play = {}, endMs = null, peers = null } = {}) {
  // EVERY SIGNER NODE'S ADVERTISEMENT, as a census would give it: each names its own
  // bond outpoint, which a slash proof must name (5A.3B). Filled once the keys exist.
  const adverts = new Map();
  // A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): the lock fixture's port - the
  // test federation, two gateways, zero base fee - and its entries lock their stake and fee in it (joinAndPlay).
  // (Imported here, not at the top: lock-fixture imports this file and uses it as it loads.)
  const { lockPort, bondedChainSlot, bondedChainFor } = await import('./lock-fixture.js');
  // AND A CHAIN THAT BONDS THE ROUND'S SEVEN (RULED 2026-09-25: a paying round opens only on a signer node that reads the
  // chain; the round's beacon is that chain's). Six of the seven are keys no daemon stands behind, so the claim key is
  // handed - never a DKG toward a key that is not there.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const holder = await serve(openStore(':memory:'), { plugins: HOSTED, 
    port: 0, ...opts, stakeLocks: port, chainFor: slot.chainFor, randomnessFor: slot.randomnessFor,
    claimKeyFor: () => new Uint8Array(33).fill(2), advertsFor: () => adverts, ...(finality ? { finality } : {}), ...(peers ? { peers } : {}) });
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED 2026-09-24): the block clock every fixture daemon reads.
  holder.round.chainView = CLOCK.chainView();
  try {
    const others = Array.from({ length: 6 }, () => rand(32));
    [holder.round.pubkey, ...others.map((s) => schnorr.getPublicKey(s))].forEach((k, i) =>
      adverts.set(toHex(k), { nodePubkey: k, bondTxid: b32(0xb0 + i), bondVout: i }));
    const first = contractFor([holder.round.pubkey, ...others.map((s) => schnorr.getPublicKey(s))], BigInt(windowMs),
      relays === undefined ? [`http://127.0.0.1:${holder.port}`] : relays);
    const drafted = endMs === null ? first : presentDay(first, endMs);
    // ONLY THE FIELD THE CHAIN DICTATES (RULED 2026-09-25): the census root its bonds derive to; the committee time stands.
    const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${holder.port}`] }).censusRoot };
    const rid = roundId(c);
    // THE ROUND'S OWN BEACON: the players seed their marks from it, as the node replays them.
    const beacon = slot.randomnessFor({ contract: c });
    // A PAYING ROUND NAMING NO RELAY is refused at the door now; a test about
    // one stored before that rule stores it the way such a round was kept.
    if (storedBeforeTheRule) holder.round.open(c);
    else await fetch(`http://127.0.0.1:${holder.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeAssigned(holder.round, rid, c.nodes);
    const runs = {};
    for (const [name, key] of [['agrees', 5], ['dissents', 6]]) {
      // `play` names who plays a run instead of the loser - a run that stops while
      // still LIVE, for one (M3.3-34 walk-away step 7).
      runs[name] = await joinAndPlay([holder], c, rid, { ...(play[name] || LOSER), name, key: b32(key) }, 5,
        { direct: storedBeforeTheRule, port, randomness: beacon && beacon.hash });
      // FIVE OF SEVEN RECEIPTS MAKE THE TRANSCRIPT CANONICAL: its own and four signer nodes'.
      for (const secret of others.slice(0, 4)) {
        const receipt = { checkpointId: runs[name].mid, receivedAtMs: 1234n, nodePubkey: schnorr.getPublicKey(secret) };
        assert.equal(await say(holder.port, joinSignedReceipt(encodeCheckpointReceipt(receipt),
          schnorr.sign(receiptId(receipt), secret))), 'held');
      }
    }
    assert.equal(await say(holder.port, `close ${toHex(rid)}`), 'closed');
    for (const p of holder.verifier.done) await p;
    await holder.verifier.settling;

    // SIGNER NODES SAYING THEY POSTED THE RUN'S TRANSCRIPT (P2): the first `count` of
    // the other six, about the transcript the holder's own result names unless
    // `over` says otherwise. A result is FINAL only once five of these agree.
    const post = (name, count = 5, over = {}, keys = others) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      for (const secret of keys.slice(0, count)) {
        const p = { roundId: rid, playerPubkey: shape.playerPubkey, transcriptHash: shape.transcriptHash,
          signerNodePubkey: schnorr.getPublicKey(secret), blockHash: CLOCK.tipAt(Date.now()), ...over };
        holder.round.putPosting(rid, eid, p.signerNodePubkey,
          joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), secret)));
      }
    };
    // `expect`: the outcome the holder's own replay must have reached (the fixtures' runs lose; a test may play a winner).
    const sign = (name, rewrite, { posted = true, expect = 'FAILED' } = {}) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      assert.ok(mine, `the holder signed no result for ${name}`);
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      assert.equal(shape.outcome, expect, `${name} did not end ${expect}`);
      // THE RUN THEY SIGNED, which an objection contradicts and a re-run names.
      runs[name].contradicted = resultId({ ...shape, ...rewrite(shape), nodePubkey: new Uint8Array(32) });
      for (const secret of others.slice(0, 5)) {
        const r = { ...shape, ...rewrite(shape), nodePubkey: schnorr.getPublicKey(secret) };
        const id = resultId(r);
        holder.round.putResult(rid, eid, r.nodePubkey, id, joinSignedResult(encodePlayerResult(r), schnorr.sign(id, secret)));
      }
      if (posted) post(name);
    };
    // OTHER SIGNER NODES' RE-RUNS OF A SUSPENDED RESULT (13A): the first `count` of the
    // six re-run the holder's own replay - the same run - unless `over` says
    // otherwise, each tied to the run the five signed (or `contradicted`).
    // `block`: the block the re-run names (§13A, RULED 2026-09-24) - by default the chain's tip as it is made.
    // `signedAtMs`: when each signer signed it (§13A, WINDOW-10-SPEC) - by default the holder's clock now, so it counts.
    const rerunBy = (name, count, { keys = others, over = {}, contradicted = runs[name].contradicted, signedAtMs = null } = {}) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      for (const secret of keys.slice(0, count)) {
        const x = { contradictedRunId: contradicted, signedAtMs: BigInt(signedAtMs ?? holder.round.now()), result: { ...shape, ...over, nodePubkey: schnorr.getPublicKey(secret) } };
        holder.round.putRerun(rid, eid, x.result.nodePubkey,
          joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secret)));
      }
    };
    // OTHER SEATS' FINAL SIGNATURES (§13A, WINDOW-10-SPEC): the first `count` of the six sign FINAL on `run` (by default
    // the run the holder's threshold agreed) at `signedAtMs` (by default the holder's clock now), POSTed to the holder,
    // which checks each on arrival. Returns what it answered for each.
    const finalBy = async (name, count, { keys = others, run = null, signedAtMs = null } = {}) => {
      const eid = runs[name].eid;
      const f = resultFinality(holder.round, rid, eid);
      const runId = run || (f.runId ? fromHex(typeof f.runId === 'string' ? f.runId : toHex(f.runId)) : null);
      assert.ok(runId, `no agreed run for ${name} to sign FINAL on`);
      const said = [];
      for (const secret of keys.slice(0, count)) {
        const x = { roundId: rid, entryId: eid, runId, signerPubkey: schnorr.getPublicKey(secret), signedAtMs: BigInt(signedAtMs ?? holder.round.now()) };
        const r = await fetch(`http://127.0.0.1:${holder.port}/final-sig?round=${toHex(rid)}&entry=${toHex(eid)}`,
          { method: 'POST', body: signFinalSig(x, (d) => schnorr.sign(d, secret)) });
        said.push(`${r.status} ${await r.text()}`);
      }
      return said;
    };
    // FINAL AS THE HOLDER SEES IT (WINDOW-10-SPEC): the fixtures' clock skipped past the run's final_after, the holder's
    // own FINAL signature (asked for as a peer asks, handed back) and four of the six. Returns the holder's finality.
    const finalNow = async (name) => {
      const eid = runs[name].eid;
      skipTo(Number(resultFinality(holder.round, rid, eid).finalAfterMs) + 50);
      const q = `round=${toHex(rid)}&entry=${toHex(eid)}`;
      const own = await fetch(`http://127.0.0.1:${holder.port}/final-sig?${q}`);
      if (own.status === 200) await fetch(`http://127.0.0.1:${holder.port}/final-sig?${q}`, { method: 'POST', body: new Uint8Array(await own.arrayBuffer()) });
      await finalBy(name, 4);
      return resultFinality(holder.round, rid, eid);
    };
    return { holder, rid, runs, sign, post, rerunBy, finalBy, finalNow, others, adverts, contract: c, close: () => holder.close() };
  } catch (err) { await holder.close(); throw err; }
}

// AN OBJECTION NAMES THE BLOCK IT IS FILED IN (§13A, RULED 2026-09-24): by default the chain's tip as it is filed.
// ONE RETRY ON A RESET CONNECTION: a pooled keep-alive socket the daemon closed while idle (measured 2026-10-01: a second
// daemon started on a file store between two requests outlasted the holder's keep-alive, and the reused socket reset).
// AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13ARULED 2026-10-04): the bundle a player
// builds from what the holder hands out (GET /canonical, GET /receipts), claiming what the holder's OWN replay signed -
// the honest replay - against the run that stands now (the agreed re-run's, while one does). Where the committee signed
// the same run, that bundle is refused (422, "the replay agrees with the signed result"); where it signed another, it
// holds. `opts.body` posts those bytes instead (an empty body, a forged bundle); `opts.claimed` claims another result.
export async function objectionBundleFor(w, eid, opts = {}) {
  const round = w.holder.round;
  const f = resultFinality(round, w.rid, eid);
  const against = f.rerun && f.rerun.runId ? f.rerun.runId : f.runId;
  if (!against) throw new Error(`no signed run to object to: ${f.why}`);
  const me = toHex(round.pubkey);
  let own = null;
  if (f.rerun && f.rerun.runId) {
    const rec = round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === me);
    if (rec) own = decodeRerunResult(splitSignedRerun(rec.bytes).body).result;
  } else {
    const rec = round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === me);
    if (rec) own = decodePlayerResult(splitSignedResult(rec.bytes).body);
  }
  const anyResult = own || decodePlayerResult(splitSignedResult(round.results(w.rid, eid)[0].bytes).body);
  const claimed = opts.claimed || (own ? { outcome: own.outcome, score: own.score } : null);
  if (!claimed) throw new Error('the holder signed no result of its own to claim');
  return buildObjectionBundle({ base: `http://127.0.0.1:${w.holder.port}`, roundId: w.rid, entryId: eid, signedRunId: against,
    playerPubkey: anyResult.playerPubkey, claimed, objectorSecret: opts.objectorSecret, transcript: opts.transcript || null,
    receipts: opts.receipts || null });
}

export const object = async (w, eid, block = CLOCK.tipAt(Date.now()), opts = {}) => {
  const at = `http://127.0.0.1:${w.holder.port}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}&block=${toHex(block)}`;
  const body = opts.body !== undefined ? opts.body : (await objectionBundleFor(w, eid, opts)).bundle;
  try { return await fetch(at, { method: 'POST', body }); } catch (e) {
    if (!/ECONNRESET|other side closed/.test(String(e && e.cause && e.cause.message))) throw e;
    return fetch(at, { method: 'POST', body });
  }
};
