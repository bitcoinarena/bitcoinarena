// A HOLD WHOSE HTLC HAS EXPIRED IS NOT LISTED HELD (M3.3-30).
//
// Measured on the regtest rehearsal: P3 - seated, paid, never played, VOID -
// timed out in lnd (CANCELED, the money back with the player) while BOTH
// daemons still listed it HELD, 35 of 35 runs. Nothing in the daemon moved a
// row to EXPIRED.
//
// The row now follows the CHAIN, not lnd's later label. When a daemon first
// sees a hold paid it records the one fact lnd supplies then: the HTLC's
// expiry height. Once the daemon's own chain view is past that height the row
// is EXPIRED - its own arithmetic. lnd is not asked again after seen-time, and
// a label lnd shows early does not move the row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, EXPIRED } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeSeated } from './seating.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();
const STAKE = 100000n;
const EXPIRY = 400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const contractFor = (nodePubkey) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});

/**
 * A Lightning node that holds one stake, paid, and says at seen-time when its
 * HTLC expires. `label` is what it would answer LATER - which the daemon must
 * not copy.
 */
function paidPort() {
  const port = {
    looks: 0, label: HELD,
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() { port.looks++; return { state: port.label, amountMsat: port.amount, paidMsat: port.amount, expiryHeight: EXPIRY }; },
    async settle() {}, async cancel() {},
  };
  return port;
}

test('a paid hold turns EXPIRED once the daemon\'s own chain is past its HTLC\'s expiry height - and not before, and not on lnd\'s word', async () => {
  const port = paidPort();
  let tip = 300;
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: port,
    chainTip: async () => tip, expiry: { everyMs: 50 },
  });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = roundId(c);
    await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(node.round, rid, c.nodes);
    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(65)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const eid = entryId(entry);
    const seated = await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
    const quote = await fetch(`http://127.0.0.1:${node.port}/invoice?entry=${toHex(eid)}`);
    assert.equal(quote.status, 200, await quote.text());
    // SEEN-TIME: the one moment lnd is asked, and the expiry height comes back with it.
    const seen = await fetch(`http://127.0.0.1:${node.port}/stake?entry=${toHex(eid)}`);
    assert.equal(seen.status, 200, await seen.text());
    const looksAtSeen = port.looks;
    const stateOf = () => (node.round.hold(eid) || {}).state;

    // lnd shows CANCELED EARLY and the chain is not there yet: the row stays HELD.
    port.label = CANCELLED;
    await wait(300);
    assert.equal(stateOf(), HELD, 'the row moved on lnd\'s label before the chain reached the expiry');

    tip = EXPIRY;
    await wait(300);
    assert.equal(stateOf(), HELD, `at the expiry height itself the HTLC can still be claimed; the row is ${stateOf()}`);

    tip = EXPIRY + 1;
    const stop = Date.now() + 3000;
    while (Date.now() < stop && stateOf() !== EXPIRED) await wait(50);
    assert.equal(stateOf(), EXPIRED, `the chain is past the HTLC's expiry and the row still says ${stateOf()}`);
    assert.match(node.round.hold(eid).why, new RegExp(`${EXPIRY}`), 'the row does not say which height it expired at');
    assert.equal(port.looks, looksAtSeen, 'the daemon asked lnd again after seen-time');
  } finally { await node.close(); }
});

test('only a HELD row with a recorded expiry height is expired: a settled, a cancelled or an unrecorded row is left alone', () => {
  const round = new Round(openStore(':memory:'));
  const custody = new Custody(round, { port: { async look() { throw new Error('the sweep asked lnd'); } } });
  const rows = { held: b32(1), settled: b32(2), cancelled: b32(3), unrecorded: b32(4) };
  const states = { held: HELD, settled: SETTLED, cancelled: CANCELLED, unrecorded: HELD };
  // foreign keys are on: a hold names an entry, an entry names a round
  round.db.prepare('INSERT INTO rounds (round_id, contract, opened_ms) VALUES (?, ?, ?)').run(Buffer.from(b32(9)), Buffer.from(b32(0)), 0);
  for (const [k, eid] of Object.entries(rows)) {
    round.db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(Buffer.from(eid), Buffer.from(b32(9)), Buffer.from(b32(0)), 0);
    round.putHold({ entryId: eid, roundId: b32(9), paymentHash: sha256(eid), amountMsat: STAKE, state: states[k], why: 'test' });
    if (k !== 'unrecorded') round.putHoldExpiry({ entryId: eid, expiryHeight: EXPIRY });
  }
  const out = custody.expire({ tipHeight: EXPIRY + 1 });
  assert.deepEqual(out.expired.map(toHex), [toHex(rows.held)]);
  assert.equal(round.hold(rows.held).state, EXPIRED);
  assert.equal(round.hold(rows.settled).state, SETTLED);
  assert.equal(round.hold(rows.cancelled).state, CANCELLED);
  assert.equal(round.hold(rows.unrecorded).state, HELD, 'a row with no recorded expiry was guessed at');
});

test('a launcher that gives only its own bitcoind (poolCall, as main.js does) still expires the hold on that chain\'s height', async () => {
  // `main.js` hands the daemon `poolCall` - its bitcoind - and no `chainTip`.
  // A daemon that read its height only from `chainTip` would never expire a
  // row in production while every test and rehearsal passed.
  const port = paidPort();
  let tip = 300;
  const asked = [];
  const poolCall = async (method) => {
    asked.push(method);
    if (method === 'getblockcount') return tip;
    throw new Error(`this test's bitcoind was asked ${method}`);
  };
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: port, poolCall, expiry: { everyMs: 50 },
  });
  try {
    const c = contractFor(node.round.pubkey);
    const rid = roundId(c);
    await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    assumeSeated(node.round, rid, c.nodes);
    const entry = {
      roundId: rid, playerPubkey: b32(6), sessionPubkey: ed25519.getPublicKey(session),
      stakeCommitment: sha256(b32(66)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE),
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const eid = entryId(entry);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status, 201);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/invoice?entry=${toHex(eid)}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${node.port}/stake?entry=${toHex(eid)}`)).status, 200);
    const stateOf = () => (node.round.hold(eid) || {}).state;
    await wait(300);
    assert.equal(stateOf(), HELD);
    tip = EXPIRY + 1;
    const stop = Date.now() + 3000;
    while (Date.now() < stop && stateOf() !== EXPIRED) await wait(50);
    assert.equal(stateOf(), EXPIRED, `the launcher's own bitcoind is past the expiry and the row still says ${stateOf()}`);
    assert.ok(asked.includes('getblockcount'), 'the daemon never asked its own bitcoind for a height');
  } finally { await node.close(); }
});
