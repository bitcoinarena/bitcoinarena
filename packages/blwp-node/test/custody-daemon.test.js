// THE DAEMON ACTUALLY HOLDS THE MONEY.
//
// `custody.test.js` measures the rules and `tools/custody-lnd.mjs` runs them
// against a real node. What was missing between the two is the thing a player
// meets: measured before this file existed, `new Custody` appeared in tools
// and tests only, `server.js` had ZERO references to it, no route offered an
// invoice, and the close called `Verifier.settleRound` - which replays and
// gathers and moves nothing at all.
//
// The port is injected, so none of this needs Lightning.
import { PLANTED_FIRST_MARK_DEADLINE } from './planted-marks.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Round } from '../src/round.js';
import { HELD, SETTLED } from '../src/custody.js';
import { assumeSeated } from './seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import {
  encodeRoundContract, roundId, encodeEntryContract, entryId,
} from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import {
  encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS,
} from '../../protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, receiptId, joinSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import {
  splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId,
} from '../../protocol/src/result.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { netStakeMsat } from "../../protocol/src/payout.js";
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const RANDOMNESS = b32(0x9b);
const BEACON = { hash: RANDOMNESS, height: 900001, timeMs: 900n };
// THE FIXTURE'S OWN WORLD, RE-MEASURED. Letter 36 gave the round its relief
// from its own seed, so this drive is on hills now and it DELIVERED where it
// used to wreck - and these tests are about a run that came to nothing. The
// world secret is the fixture's to choose and it chooses one where the drive
// still loses: b32(0x16) wrecks player 5 at tick 547 with a score of 128 and
// player 6 at 947. 1000 ticks is past both, and a run's state latches when it
// leaves LIVE.
const TICKS = 1000;
const wordsAt = (t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];

// The player's own secret and the commitment their contract carries.
const preimageOf = (n) => b32(n + 60);
const preimageFor = (id, e) => preimageOf(e.pubkey[0]);

const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();

const contractFor = (nodePubkey) => ({
  startDeadlineTicks: PLANTED_FIRST_MARK_DEADLINE, networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});
const entryFor = (rid, n = 5) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: sha256(preimageOf(n)), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/**
 * A Lightning node that keeps a call log and no money - and whose players have
 * paid: every hold it issued reads as held in full, which is what these tests
 * assume before they play (23.1 step 5; stake-committed.test.js covers unpaid).
 */
function fakePort() {
  const calls = [];
  const amounts = new Map();
  return {
    calls,
    acts: () => calls.filter((c) => c[0] === 'settle' || c[0] === 'cancel'),
    async createHeld({ paymentHash, amountMsat, entryId: id }) {
      calls.push(['createHeld', toHex(paymentHash)]);
      amounts.set(toHex(paymentHash), amountMsat);
      return { paymentHash, amountMsat, request: 'lnbcrt-' + toHex(id).slice(0, 12) };
    },
    async look({ paymentHash }) {
      calls.push(['look', toHex(paymentHash)]);
      const amountMsat = amounts.get(toHex(paymentHash)) || 0n;
      return { state: HELD, amountMsat, paidMsat: amountMsat };
    },
    async settle({ paymentHash }) { calls.push(['settle', toHex(paymentHash)]); },
    async cancel({ paymentHash }) { calls.push(['cancel', toHex(paymentHash)]); },
  };
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
const getJson = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await r.text();
  return { status: r.status, text, body: r.headers.get('content-type') === 'application/json' ? JSON.parse(text) : null };
};

test('a seated player is quoted the hold invoice their own entry names', async () => {
  const port = fakePort();
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, preflight: async () => ({ ready: true, why: "test port" }), lightning: port });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = roundId(c);
    await post(node.port, '/round', encodeRoundContract(c));
    const entry = entryFor(rid);
    const seated = await post(node.port, '/entry', encodeEntryContract(entry));

    // THE SEAT IS WHERE THE HOLD IS ISSUED. Nothing else had to ask for it.
    assert.equal(seated.status, 201);
    assert.equal(seated.headers.get('x-hold'), HELD);

    const eid = toHex(entryId(entry));
    const quote = await getJson(node.port, `/invoice?entry=${eid}`);
    assert.equal(quote.status, 200, quote.text);
    assert.equal(quote.body.entry, eid);
    assert.equal(quote.body.paymentHash, toHex(entry.stakeCommitment),
      'the invoice is for a hash the player never signed');
    assert.equal(quote.body.amountMsat, String(netStakeMsat(entry)), "the quote is not the net stake (22A)");
    assert.equal(quote.body.state, HELD);
    assert.match(quote.body.request, /^lnbcrt-/);

    // ASKED TWICE, ANSWERED THE SAME. A reloaded page must not become a
    // second claim on one stake.
    const again = await getJson(node.port, `/invoice?entry=${eid}`);
    assert.equal(again.body.request, quote.body.request);
    assert.equal(port.calls.filter((c) => c[0] === 'createHeld').length, 1);
  } finally { await node.close(); }
});

test('an entry this node never seated gets no invoice', async () => {
  const port = fakePort();
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED, preflight: async () => ({ ready: true, why: "test port" }), lightning: port });
  try {
    const stranger = await getJson(node.port, `/invoice?entry=${toHex(b32(0xee))}`);
    assert.equal(stranger.status, 404);
    assert.match(stranger.text, /does not invent invoices for strangers/);

    const nonsense = await getJson(node.port, '/invoice?entry=beef');
    assert.equal(nonsense.status, 400);
    assert.equal(port.calls.length, 0, 'a stranger made this node talk to Lightning');
  } finally { await node.close(); }
});

test('a daemon with no Lightning still seats, and says why it quotes nothing', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = roundId(c);
    await post(node.port, '/round', encodeRoundContract(c));
    const entry = entryFor(rid);
    const seated = await post(node.port, '/entry', encodeEntryContract(entry));

    // THE ENTRY IS STILL STORED. A Lightning node that is down is the
    // operator's problem, not a reason to throw away a signed contract.
    assert.equal(seated.status, 201);
    assert.equal(seated.headers.get('x-hold'), 'none');
    assert.match(seated.headers.get('x-hold-why'), /reaches no Lightning/);

    const quote = await getJson(node.port, `/invoice?entry=${toHex(entryId(entry))}`);
    assert.equal(quote.status, 503);
    assert.match(quote.text, /reaches no Lightning/);
    assert.equal(node.round.hold(entryId(entry)), null);
  } finally { await node.close(); }
});

/** A whole round through the daemon's own doors, ending in a close. */
async function roundThrough(node) {
  const c = contractFor(node.round.pubkey);
  const rid = roundId(c);
  await post(node.port, '/round', encodeRoundContract(c));
  assumeSeated(node.round, rid, c.nodes);

  const entry = entryFor(rid);
  const eid = entryId(entry);
  assert.equal((await post(node.port, '/entry', encodeEntryContract(entry))).status, 201);

  const ws = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
  const said = [];
  ws.on('message', (d, bin) => said.push(bin ? new Uint8Array(d) : d.toString()));
  await new Promise((r) => ws.once('open', r));
  const say = (m) => new Promise((resolve, reject) => {
    const n = said.length;
    let waited = 0;
    ws.send(m);
    const t = setInterval(() => {
      if (said.length > n) { clearInterval(t); return resolve(said[n]); }
      if ((waited += 2) > 20000) { clearInterval(t); reject(new Error('the daemon never answered')); }
    }, 2);
  });

  const rows = [];
  for (let t = 0; t < TICKS; t++) rows.push(wordsAt(t));
  const input = { roundId: rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: rows, liquidations: [] };
  assert.equal(await say(encodeInputBatch(input)), String(TICKS));

  const st = init(seedWordForEntry(entry, RANDOMNESS));
  for (let t = 0; t < TICKS; t++) step(st, ...wordsAt(t));
  const mark = {
    roundId: rid, entryId: eid, tick: TICKS,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: batchId(input), previousHash: NO_PREVIOUS,
    sessionPubkey: ed25519.getPublicKey(session),
  };
  const mid = checkpointId(mark);
  const receipted = await say(joinSigned(encodeCheckpoint(mark), ed25519.sign(mid, session)));
  assert.equal(receipted.length, SIGNED_RECEIPT_BYTES, 'the node refused the mark');

  // The second seat's receipt, which is what makes the transcript canonical.
  const receipt = { checkpointId: mid, receivedAtMs: 1234n, nodePubkey: schnorr.getPublicKey(peer) };
  assert.equal(await say(joinSignedReceipt(encodeCheckpointReceipt(receipt),
    schnorr.sign(receiptId(receipt), peer))), 'held');

  assert.equal(await say(`close ${toHex(rid)}`), 'closed');
  ws.close();
  return { rid, eid, contract: c, input };
}
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;

test('closing a round on the daemon reaches the money path, and moves no stake', async () => {
  // THE WIRE ITSELF. Before this, `close` called `Verifier.settleRound` -
  // replay and gather, which move nothing - and there was no second call at
  // all. Now the close ends in `Custody.settleHeldInvoices`, and the proof
  // that real entries reached 23.2's table is that its refusal names this
  // player's own stake.
  const port = fakePort();
  const node = await serve(openStore(':memory:'), {
    port: 0, ...FUNDED, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: "test port" }), lightning: port, preimageFor,
  });
  try {
    const { eid } = await roundThrough(node);
    for (const p of node.verifier.done) await p;
    await node.verifier.settling;
    const money = await node.stakes();

    // ONE SEAT OF TWO IS NOT A FINAL, and the close says so even though the
    // answer would have been "nothing moves" either way.
    assert.equal(money.considered, 1);
    assert.deepEqual(money.agreed, [], 'one seat of two was counted as an agreement');
    assert.equal(money.ok, false);
    assert.match(money.why, new RegExp(`a pool of ${netStakeMsat(entryFor(new Uint8Array(32)))} against 0 handed out`),
      'the close never reached the stake table with this round\'s own entries');
    assert.match(money.why, /expires to its player/);
    assert.equal(node.round.hold(eid).state, HELD);
    assert.deepEqual(port.acts(), [], 'a stake moved on a close');
  } finally { await node.close(); }
});

test('the committee agreeing on a round nobody finished still moves no stake', async () => {
  // MEASURED, AND IT IS THE COMMON CASE. The only outcome a transcript can
  // produce is DELIVERED or FAILED, and the drive this harness plays wrecks at
  // tick 631 - so the round has a pool of forfeited stakes and no qualifier to
  // hand it to. `payout.js` refuses to decide that in the operator's favour,
  // and the daemon's answer to a refusal is to move nothing: every hold stays
  // in flight and goes home on its own timelock.
  const port = fakePort();
  const node = await serve(openStore(':memory:'), {
    port: 0, ...FUNDED, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: "test port" }), lightning: port, preimageFor,
  });
  try {
    const { rid, eid } = await roundThrough(node);
    for (const p of node.verifier.done) await p;
    await node.verifier.settling;
    await node.stakes();

    // THE SECOND SEAT AGREES: the same run, signed by the other committee key.
    // Nothing is invented - the body is this node's own result with the signer
    // swapped, which is what a peer that replayed the same transcript produces.
    const mine = node.round.results(rid, eid)[0];
    const body = decodePlayerResult(splitSignedResult(mine.bytes).body);
    const theirs = { ...body, nodePubkey: schnorr.getPublicKey(peer) };
    const id = resultId(theirs);
    node.round.putResult(rid, eid, theirs.nodePubkey, id,
      joinSignedResult(encodePlayerResult(theirs), schnorr.sign(id, peer)));

    const closed = await node.verifier.settleRound(rid);
    const agreed = closed.gathered.find((g) => toHex(g.entryId) === toHex(eid));
    assert.equal(agreed.final, true, `the two seats did not agree: ${agreed.why}`);

    // THE WORD IS THE CORE'S, and it reached 23.2's table: the refusal names
    // this player's own stake, which is how we know real entries went in.
    const replayed = closed.replayed.find((r) => toHex(r.entryId) === toHex(eid));
    assert.equal(replayed.outcome, 'FAILED');
    assert.equal(replayed.stakeMsat, 100000n);
    assert.deepEqual(replayed.playerPubkey, b32(5));

    const money = await node.settleTheStakes(rid, closed);
    assert.deepEqual(money.agreed, [toHex(eid)],
      'the close did not take its finality from the gather it just ran');
    assert.equal(money.ok, false);
    assert.match(money.why, new RegExp(`a pool of ${netStakeMsat(entryFor(new Uint8Array(32)))} against 0 handed out`));
    assert.match(money.why, /expires to its player/);
    assert.equal(node.round.hold(eid).state, HELD);
    assert.deepEqual(port.acts(), [],
      'a stake moved in a round that had nobody to hand the pool to');
  } finally { await node.close(); }
});

test('a daemon asks Lightning about an act it died in the middle of, on start', async () => {
  // A tool an operator remembers to run is not a guarantee, so the question is
  // asked where a restart happens.
  const db = openStore(':memory:');
  const round = new Round(db);
  const c = contractFor(round.pubkey);
  const rid = round.open(c);
  const entry = entryFor(rid);
  round.enter(entry);
  const eid = entryId(entry);
  round.putHold({
    entryId: eid, roundId: rid, paymentHash: entry.stakeCommitment,
    amountMsat: entry.stakeMsat, state: 'SETTLE_REQUESTED', request: 'lnbcrt-x',
    why: 'about to settle; if this node dies here, ask Lightning',
  });

  const port = fakePort();
  port.look = async ({ paymentHash }) => { port.calls.push(['look', toHex(paymentHash)]); return { state: SETTLED }; };
  const node = await serve(db, { port: 0, ...FUNDED, preflight: async () => ({ ready: true, why: "test port" }), lightning: port });
  try {
    const asked = await node.reconciling;
    assert.equal(asked.ok, true, asked.why);
    assert.deepEqual(asked.asked.map((a) => a.state), [SETTLED]);
    assert.equal(round.hold(eid).state, SETTLED,
      'the node came back and never asked what it had already done');
    assert.deepEqual(port.acts(), [], 'it settled the same stake a second time');
  } finally { await node.close(); }
});

test('a daemon with no Lightning asks it nothing and says so', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const asked = await node.reconciling;
    assert.equal(asked.ok, false);
    assert.match(asked.why, /reaches no Lightning/);
  } finally { await node.close(); }
});

test('closing a round makes the daemon sign what it owes, and serve that signature', async () => {
  // MEASURED AFTER 8b WAS FIRST CALLED DONE: `new Payouts` appeared in tests
  // and one tool and in NO src file, server.js had zero references to a
  // payout, and `gather` fetched a `/payout` door that did not exist. The
  // rules were right and the daemon ran none of them - the same shape as the
  // stake table before M3.1 and the VSS rules before item 9.
  const port = fakePort();
  const node = await serve(openStore(':memory:'), {
    port: 0, ...FUNDED, randomnessFor: () => BEACON, preflight: async () => ({ ready: true, why: "test port" }), lightning: port, preimageFor,
  });
  try {
    const { rid, eid } = await roundThrough(node);
    for (const p of node.verifier.done) await p;
    await node.verifier.settling;
    await node.stakes();

    // THE NODE SIGNED THE TABLE IT COMPUTED, on the close, without being asked.
    const held = node.round.payoutSignatures(rid);
    assert.equal(held.length, 1, 'the close did not reach the payout at all');
    assert.deepEqual(held[0].nodePubkey, node.round.pubkey);

    // AND IT SERVES IT, which is the door `gather` reads on every other seat.
    const got = await fetch(`http://127.0.0.1:${node.port}/payout?round=${toHex(rid)}`);
    const bytes = new Uint8Array(await got.arrayBuffer());
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-payout-signatures'), '1');
    assert.equal(bytes.length, 128, 'a signed payout table is 128 bytes');
    assert.deepEqual(bytes, held[0].bytes);

    // ONE OF SEVEN IS NOT FIVE, so nothing is queued and no row exists.
    assert.equal(node.round.payout(rid), null, 'a payout was queued on one signature');
    assert.equal(got.headers.get('x-payout-state'), 'none');

    const nonsense = await fetch(`http://127.0.0.1:${node.port}/payout?round=beef`);
    assert.equal(nonsense.status, 400);
    void eid;
  } finally { await node.close(); }
});

test('a daemon with no chain asks it nothing about a payout', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const asked = await node.reconcilingPayouts;
    assert.equal(asked.ok, false);
    assert.match(asked.why, /reaches no chain/);
    assert.equal(node.payouts.canSpend, false);
  } finally { await node.close(); }
});
