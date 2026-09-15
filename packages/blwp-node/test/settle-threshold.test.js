// A LOST STAKE OPENS AT THE ROUND'S THRESHOLD, THROUGH THE REAL SHARE ASK (M3.3-26).
//
// Measured on the regtest rehearsal before the fix: both daemons reached the
// loser's settle holding both shares of a stake dealt 2-of-2, and stopped at
// "2 of 5 shares" - the settle's `open()` asked SHARES_NEEDED, whatever the
// round. The door tests pin what a handout may be dealt at; this pins what the
// settle opens at. Two shapes, because two mutants: a settle that asks the
// default 5 is caught on 2 of 2; a settle that asks the SLOT COUNT - item 23's
// "every signer node a vote", moved from the page into the settle - is the same number
// as the threshold on two signer nodes, and is caught only on seven signer nodes with two of
// them down, where 5 shares exist and 7 are asked for.
//
// A lone loser moves no stake - the round's money rule refuses a pool with
// nobody handed anything ("the operator would keep 98000 msat") - so the close
// never reaches the settle here; the rehearsal, with a winner beside the
// loser, does. What the settle calls is the custody's `preimageFor`, which is
// the daemon's `fromTheCommittee`: its own share plus the other signer nodes', asked
// for over HTTP once the run is final on them, opened at the round's number.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned, assumeStakeSeen } from './assignment.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../protocol/src/receipt.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const TICKS = 1000;   // close-order's drive: this world secret wrecks at tick 547
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
// the threshold a settle opens at; objection-window.test.js pins the window
// (M3.3-32), and the watch's budget is named in `finality` instead.
// P2 (v4.6.2 §13A): the relays each run's transcript is posted to - the
// daemons' own doors - or no result of the round can become final.
const contractFor = (nodes, publicationRelays) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: nodes.length, settlementSlots: nodes.length, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
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

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };

/**
 * A round of `signer nodes` settlement signer nodes of which `up` run a daemon, one stake
 * dealt at the round's threshold to all of them, one run that wrecks played on
 * every daemon, closed on every daemon, and final on every daemon.
 */
async function lostStake({ signerNodes, up }) {
  const opts = { funded: () => true, randomnessFor: () => BEACON,
    preflight: async () => ({ ready: true, why: 'test port' }), finality: { everyMs: 50, windowMs: 10000 } };
  const daemons = [];
  for (let i = 0; i < up; i++) daemons.push(await serve(openStore(':memory:'), { port: 0, ...opts, lightning: paidPort() }));
  const close = async () => { for (const d of daemons) await d.close(); };
  try {
    for (const d of daemons) {
      // no census here: the operator's list, the same for every ask
      const others = daemons.filter((o) => o !== d).map((o) => `http://127.0.0.1:${o.port}`);
      d.verifier.peers = others;
      d.payouts.peers = others;
      d.preimages.peers = others;
    }
    const down = Array.from({ length: signerNodes - up }, () => schnorr.getPublicKey(rand(32)));
    const c = contractFor([...daemons.map((d) => d.round.pubkey), ...down], daemons.map((d) => `http://127.0.0.1:${d.port}`));
    const rid = roundId(c);
    const needed = receiptsNeeded(signerNodes);

    const preimage = secretScalar();
    const e = rand(32);
    const dealt = await dealHandout({
      preimage, signerNodes: c.nodes, roundId: rid, playerPubkey: b32(5),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
      coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed, curve: feldmanGroup,
    });
    assert.equal(dealt.ok, true, dealt.why);

    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x16), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0], feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
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

    for (const d of daemons) {
      await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
      assumeAssigned(d.round, rid, c.nodes);
      const took = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
      assert.equal(took.status, 201, await took.text());
      const joined = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      assert.equal(joined.status, 201, await joined.text());
      const quote = await fetch(`http://127.0.0.1:${d.port}/invoice?entry=${toHex(eid)}`);
      assert.equal(quote.status, 200, await quote.text());
      assumeStakeSeen(d.round, entry);
      assert.equal(await say(d.port, encodeInputBatch(input)), String(TICKS));
      assert.equal((await say(d.port, signedMark)).length, SIGNED_RECEIPT_BYTES);
    }
    for (const d of daemons) {
      assert.equal(await say(d.port, `close ${toHex(rid)}`), 'closed');
      await d.verifier.settling;
    }
    const final = async (d) => ((await d.stakes()).agreed || []).includes(toHex(eid));
    const stop = Date.now() + 10000;
    while (Date.now() < stop && !(await Promise.all(daemons.map(final))).every(Boolean)) await wait(50);
    for (const [i, d] of daemons.entries())
      assert.equal(await final(d), true, `the run never turned final on signer node ${i + 1} of the ${up} up`);
    return { daemons, entry, eid, rid, preimage, needed, close };
  } catch (err) { await close(); throw err; }
}

test('each daemon\'s settle opens a 2-of-2 stake with its 2 shares - not "2 of 5"', async () => {
  const w = await lostStake({ signerNodes: 2, up: 2 });
  try {
    for (const [name, d] of [['A', w.daemons[0]], ['B', w.daemons[1]]]) {
      const got = await d.custody.preimageFor(w.eid, w.entry, w.rid);
      assert.ok(got instanceof Uint8Array, `${name} opened no preimage from the 2 shares of a 2-of-2 stake`);
      assert.equal(toHex(got), toHex(w.preimage), `${name} opened a different preimage`);
    }
  } finally { await w.close(); }
});

test('seven signer nodes, two of them down: the settle opens a 5-of-7 stake with the 5 shares that exist - not "5 of 7"', async () => {
  const w = await lostStake({ signerNodes: 7, up: 5 });
  try {
    assert.equal(w.needed, 5);
    const got = await w.daemons[0].custody.preimageFor(w.eid, w.entry, w.rid);
    assert.ok(got instanceof Uint8Array, 'the settle opened no preimage from the 5 shares a 5-of-7 stake needs');
    assert.equal(toHex(got), toHex(w.preimage), 'the settle opened a different preimage');
  } finally { await w.close(); }
});
