// THE OBJECTION WINDOW'S DAEMONS AND PLAYERS, shared by objection-window.test.js
// (M3.3-32) and publication-finality.test.js (P2): two seats that settle on a
// paid fake Lightning, and one daemon on a seven-seat round whose other six
// keys the test holds. Moved here unchanged, except that a contract can name
// publication relays.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
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
import {
  SIGNED_RECEIPT_BYTES, encodeCheckpointReceipt, receiptId, joinSignedReceipt,
} from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { encodeTranscriptPosting, transcriptPostingId, joinSignedPosting } from '../../protocol/src/posting.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun } from '../../protocol/src/rerun.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

export const b32 = (n) => new Uint8Array(32).fill(n);
export const rand = (n) => new Uint8Array(randomBytes(n));
export const RANDOMNESS = b32(0x9b);
export const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
export const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
export const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
export const STAKE = 100000n;
export const WINDOW_MS = 3000;
export const HTLC_EXPIRY = 500;   // the height the fake lnd says each paid HTLC expires at
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// second-closer's two players: the winner DELIVERS by tick 1320, the loser
// wrecks at tick 547.
export const WINNER = { name: 'winner', key: b32(0x0a), worldSecret: fromHex(`01${'00'.repeat(30)}d1`), ticks: 1320 };
export const LOSER = { name: 'loser', key: b32(5), worldSecret: b32(0x16), ticks: 1000 };

/** A Lightning node whose players have paid, and which writes down WHEN it was told to act. */
export function paidPort() {
  const amounts = new Map();
  const settled = [];
  const cancelled = [];
  return {
    settled, cancelled,
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a, expiryHeight: HTLC_EXPIRY }; },
    async settle({ paymentHash, preimage }) { settled.push({ paymentHash: toHex(paymentHash), preimage: toHex(preimage), at: Date.now() }); },
    async cancel({ paymentHash }) { cancelled.push({ paymentHash: toHex(paymentHash), at: Date.now() }); },
  };
}

// THE START DEADLINE THESE ROUNDS NAME (§15, a late start): every player here
// plants ONE first mark at the end of its run, so the round names a deadline
// past it (planted-marks.js says why); the omitted default is not moved.
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
export { PLANTED_FIRST_MARK_DEADLINE };

export const contractFor = (nodes, objectionWindowMs, publicationRelays = []) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE,
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays, donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
});

export const say = (port, message) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  ws.on('open', () => ws.send(message));
  ws.on('message', (d, bin) => { resolve(bin ? new Uint8Array(d) : d.toString()); ws.close(); });
  ws.on('error', reject);
});

export const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/** One player's stake dealt at `needed` to every seat, seated, paid and played on `daemons`. */
export async function seatAndPlay(daemons, c, rid, who, needed, { direct = false } = {}) {
  const session = ed25519.utils.randomSecretKey();
  const preimage = secretScalar();
  const e = rand(32);
  const dealt = await dealHandout({
    preimage, seats: c.nodes, roundId: rid, playerPubkey: who.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: who.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
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
    if (direct) {
      // SEATED BEFORE THE RELAY RULE: the door refuses a stake in a paying
      // round naming no relay now, so a test about one kept from before stores
      // the entry, and the stake it saw, the way they were kept.
      d.round.enter(entry);
      assumeStakeSeen(d.round, entry);
    } else {
      const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      assert.equal(seated.status, 201, `${who.name}'s entry: ${await seated.text()}`);
      const quote = await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`);
      assert.equal(quote.status, 200, `${who.name}'s invoice: ${await quote.text()}`);
      // SEEN THE WAY A PAGE SEES IT: `GET /stake` asks the node's own Lightning,
      // which is also when the node learns the HTLC's expiry height.
      const seen = await fetch(`http://127.0.0.1:${d.port}/stake?entry=${toHex(eid)}`);
      assert.equal(seen.status, 200, `${who.name}'s stake was not seen: ${await seen.text()}`);
    }
    assert.equal(await say(d.port, encodeInputBatch(input)), String(who.ticks));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { eid, entry, preimage, mid: checkpointId(mark) };
}

export const opts = { funded: () => true, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: 'test port' }) };
/**
 * ONE DAEMON ON A SEVEN-SEAT ROUND, the other six seats' keys this test holds.
 * Two losers play on it and it signs its own result for each; then `sign` has
 * five of the other seats sign - the same run it did, or a rewritten one - and
 * the run is PROVISIONALLY_FINAL on it.
 */
export async function sevenSeats(windowMs, relays, { storedBeforeTheRule = false, finality = null, play = {} } = {}) {
  // EVERY SEAT'S ADVERTISEMENT, as a census would give it: each names its own
  // bond outpoint, which a slash proof must name (5A.3B). Filled once the keys exist.
  const adverts = new Map();
  const holder = await serve(openStore(':memory:'), {
    port: 0, ...opts, lightning: paidPort(), advertsFor: () => adverts, ...(finality ? { finality } : {}) });
  try {
    const others = Array.from({ length: 6 }, () => rand(32));
    [holder.round.pubkey, ...others.map((s) => schnorr.getPublicKey(s))].forEach((k, i) =>
      adverts.set(toHex(k), { nodePubkey: k, bondTxid: b32(0xb0 + i), bondVout: i }));
    const c = contractFor([holder.round.pubkey, ...others.map((s) => schnorr.getPublicKey(s))], BigInt(windowMs),
      relays === undefined ? [`http://127.0.0.1:${holder.port}`] : relays);
    const rid = roundId(c);
    // A PAYING ROUND NAMING NO RELAY is refused at the door now; a test about
    // one stored before that rule stores it the way such a round was kept.
    if (storedBeforeTheRule) holder.round.open(c);
    else await fetch(`http://127.0.0.1:${holder.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(holder.round, rid, c.nodes);
    const runs = {};
    for (const [name, key] of [['agrees', 5], ['dissents', 6]]) {
      // `play` names who plays a run instead of the loser - a run that stops while
      // still LIVE, for one (M3.3-34 walk-away step 7).
      runs[name] = await seatAndPlay([holder], c, rid, { ...(play[name] || LOSER), name, key: b32(key) }, 5, { direct: storedBeforeTheRule });
      // FIVE OF SEVEN RECEIPTS MAKE THE TRANSCRIPT CANONICAL: its own and four seats'.
      for (const secret of others.slice(0, 4)) {
        const receipt = { checkpointId: runs[name].mid, receivedAtMs: 1234n, nodePubkey: schnorr.getPublicKey(secret) };
        assert.equal(await say(holder.port, joinSignedReceipt(encodeCheckpointReceipt(receipt),
          schnorr.sign(receiptId(receipt), secret))), 'held');
      }
    }
    assert.equal(await say(holder.port, `close ${toHex(rid)}`), 'closed');
    for (const p of holder.verifier.done) await p;
    await holder.verifier.settling;

    // SEATS SAYING THEY POSTED THE RUN'S TRANSCRIPT (P2): the first `count` of
    // the other six, about the transcript the holder's own result names unless
    // `over` says otherwise. A result is FINAL only once five of these agree.
    const post = (name, count = 5, over = {}, keys = others) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      for (const secret of keys.slice(0, count)) {
        const p = { roundId: rid, playerPubkey: shape.playerPubkey, transcriptHash: shape.transcriptHash,
          seatPubkey: schnorr.getPublicKey(secret), ...over };
        holder.round.putPosting(rid, eid, p.seatPubkey,
          joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), secret)));
      }
    };
    const sign = (name, rewrite, { posted = true } = {}) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      assert.ok(mine, `the holder signed no result for ${name}`);
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      assert.equal(shape.outcome, 'FAILED', `${name} did not lose`);
      // THE RUN THEY SIGNED, which an objection contradicts and a re-run names.
      runs[name].contradicted = resultId({ ...shape, ...rewrite(shape), nodePubkey: new Uint8Array(32) });
      for (const secret of others.slice(0, 5)) {
        const r = { ...shape, ...rewrite(shape), nodePubkey: schnorr.getPublicKey(secret) };
        const id = resultId(r);
        holder.round.putResult(rid, eid, r.nodePubkey, id, joinSignedResult(encodePlayerResult(r), schnorr.sign(id, secret)));
      }
      if (posted) post(name);
    };
    // OTHER SEATS' RE-RUNS OF A SUSPENDED RESULT (13A): the first `count` of the
    // six re-run the holder's own replay - the same run - unless `over` says
    // otherwise, each tied to the run the five signed (or `contradicted`).
    const rerunBy = (name, count, { keys = others, over = {}, contradicted = runs[name].contradicted } = {}) => {
      const eid = runs[name].eid;
      const mine = holder.round.results(rid, eid).find((r) => toHex(r.nodePubkey) === toHex(holder.round.pubkey));
      const shape = decodePlayerResult(splitSignedResult(mine.bytes).body);
      for (const secret of keys.slice(0, count)) {
        const x = { contradictedRunId: contradicted, result: { ...shape, ...over, nodePubkey: schnorr.getPublicKey(secret) } };
        holder.round.putRerun(rid, eid, x.result.nodePubkey,
          joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secret)));
      }
    };
    return { holder, rid, runs, sign, post, rerunBy, others, adverts, contract: c, close: () => holder.close() };
  } catch (err) { await holder.close(); throw err; }
}

export const object = (w, eid) => fetch(`http://127.0.0.1:${w.holder.port}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST' });
