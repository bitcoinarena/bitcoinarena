// FINALITY THAT DOES NOT DEPEND ON WHICH SEAT CLOSES FIRST (M3.3-25).
//
// Measured on the regtest rehearsal (--close-order=AB|BA): the first daemon to
// close is left one committee result short, whichever it is. Its one gather
// answered 126-171 ms before the other seat had stored that run's result, and
// nothing asked again: AB left A at "1 of 2 agree" and its payout table at
// "1 of 2 seats signed"; BA left B there. After a close the verifier now
// gathers every stored run that is not final again, every `everyMs`, until it
// is final or the round's objection window has passed - and a run that turns
// final re-runs that round's close logic: settle and cancel, then the payout
// table's gather and queue. No second close path.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { assumeSeated, assumeStakeSeen } from './seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const TICKS = 1000;   // the node fixture's drive: this world secret wrecks at tick 547
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
const session = ed25519.utils.randomSecretKey();
const STAKE = 100000n;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Lightning node whose players have paid: every hold reads held in full. */
function paidPort() {
  const amounts = new Map();
  return {
    async createHeld({ paymentHash, amountMsat }) { amounts.set(toHex(paymentHash), amountMsat); return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look({ paymentHash }) { const a = amounts.get(toHex(paymentHash)) || 0n; return { state: HELD, amountMsat: a, paidMsat: a }; },
    async settle() {}, async cancel() {},
  };
}

// A ROUND WITH NO OBJECTION WINDOW: final at the quorum. This file is about
// who closes first, not the window - objection-window.test.js pins that
// (M3.3-32) - so the watch's budget is named in `finality` instead.
// P2 (v4.6.2 §13A): the relays each run's transcript is posted to - the
// daemons' own doors - or no result of the round can become final.
const contractFor = (nodes, publicationRelays) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 0n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
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

/** Two daemons on a paying round, one run played on both, each receipting its own half. */
async function played({ finality } = {}) {
  const opts = { funded: () => true, randomnessFor: () => BEACON,
    preflight: async () => ({ ready: true, why: 'test port' }), ...(finality ? { finality } : {}) };
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort() });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort() });
  a.verifier.peers = [`http://127.0.0.1:${b.port}`];
  b.verifier.peers = [`http://127.0.0.1:${a.port}`];
  a.payouts.peers = [`http://127.0.0.1:${b.port}`];
  b.payouts.peers = [`http://127.0.0.1:${a.port}`];
  const c = contractFor([a.round.pubkey, b.round.pubkey], [a, b].map((d) => `http://127.0.0.1:${d.port}`));
  const rid = roundId(c);
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(b32(0x41)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
    ticks: Array.from({ length: TICKS }, (_, t) => wordsAt(t)), liquidations: [] };
  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < TICKS; t++) step(st, ...wordsAt(t));
  const mark = { roundId: rid, entryId: eid, tick: TICKS,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), session));
  for (const d of [a, b]) {
    await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(d.round, rid, c.nodes);
    const seated = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    assumeStakeSeen(d.round, entry);
    assert.equal(await say(d.port, encodeInputBatch(input)), String(TICKS));
    assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
  }
  return { a, b, rid, eid, close: async () => { await a.close(); await b.close(); } };
}

/** One daemon's close, carried through its own first settle. */
async function closeOn(d, rid) {
  assert.equal(await say(d.port, `close ${toHex(rid)}`), 'closed');
  await d.verifier.settling;
  return d.stakes();
}

/** What a daemon's latest close believes: the run final, and the table's state. */
async function state(d, rid, eid) {
  const money = await d.stakes();
  const row = d.round.payout(rid);
  return { final: (money.agreed || []).includes(toHex(eid)), table: row ? row.state : 'none',
    signed: d.round.payoutSignatures(rid).length };
}

async function settles(d, rid, eid, ms = 8000) {
  const stop = Date.now() + ms;
  for (;;) {
    const s = await state(d, rid, eid);
    if (s.final && s.table !== 'none') return s;
    if (Date.now() > stop) return s;
    await wait(50);
  }
}

for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
  test(`closing ${first.toUpperCase()} first and ${second.toUpperCase()} later: both end with the run final and the payout table 2 of 2`, async () => {
    const w = await played({ finality: { everyMs: 50, windowMs: 10000 } });
    try {
      // THE FIRST TO CLOSE IS SHORT - its one gather finds nobody else's result.
      const early = await closeOn(w[first], w.rid);
      assert.deepEqual(early.agreed, [], `the first closer was final before the other had replayed: ${JSON.stringify(early)}`);
      assert.equal(w[first].round.payout(w.rid), null, 'the first closer queued a table nobody else had signed');

      await closeOn(w[second], w.rid);
      const one = await settles(w[first], w.rid, w.eid);
      const two = await settles(w[second], w.rid, w.eid);
      assert.equal(one.final, true, `the first to close never saw the run final: ${JSON.stringify(one)}`);
      assert.equal(two.final, true, `the second to close did not see the run final: ${JSON.stringify(two)}`);
      assert.equal(one.signed, 2, `the first closer's table has ${one.signed} of 2 seats`);
      assert.equal(two.signed, 2, `the second closer's table has ${two.signed} of 2 seats`);
      assert.notEqual(one.table, 'none');
      assert.equal(one.table, two.table, 'the two seats queued different tables');
    } finally { await w.close(); }
  });
}

// RULED 2026-09-12 (M3.3-34): the window is for objections, not for abandoning
// 2 of 2 - a seat still short of the second signature keeps asking after it.
// What this test guarded stays guarded: a run that never turns final is asked
// about EVER MORE RARELY, backing off to `maxEveryMs`, never at the watch's
// cadence for ever. Measured before the ruling: A stopped asking at the window.
test('a run that never turns final is asked about ever more rarely after the round\'s window, never given up', async () => {
  const w = await played({ finality: { everyMs: 20, windowMs: 200, maxEveryMs: 400 } });
  const asks = [];
  const gather = w.a.verifier.gather.bind(w.a.verifier);
  w.a.verifier.gather = async (...x) => { asks.push(Date.now()); return gather(...x); };
  try {
    await closeOn(w.a, w.rid);            // B never closes, so B never signs a result
    await wait(600);
    const atDeadline = asks.length;
    assert.ok(atDeadline >= 3, `A asked again only ${atDeadline} times before its window closed`);
    await wait(1500);
    const after = asks.slice(atDeadline);
    const gaps = after.slice(1).map((t, i) => t - after[i]);
    console.log('  FACTS (never final):', JSON.stringify({ inWindow: atDeadline, afterWindow: after.length, gapsMs: gaps }));
    assert.ok(after.length >= 1, 'A gave up the second signature at the window');
    assert.ok(after.length <= 8, `A asked ${after.length} times in 1.5 s after its window: not backing off (at its 20 ms cadence it would be ~75)`);
    assert.ok(gaps.length && gaps[gaps.length - 1] >= 350, `the last gap was ${gaps[gaps.length - 1]} ms: not backed off to the 400 ms cap`);
    assert.equal((await state(w.a, w.rid, w.eid)).final, false);
  } finally { await w.close(); }
});
