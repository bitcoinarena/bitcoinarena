// AN INVOICE NOBODY PAID DOES NOT SIT HELD FOR GOOD (M3.3-30).
//
// `Custody.hold` writes HELD - "in flight, in nobody's balance" - the moment
// the invoice is issued. For an invoice nobody paid that is false: nothing was
// ever sent, and lnd cancels the invoice at the expiry the daemon chose when it
// asked for it (`--expiry 3600` in lnd-port.js). The row now follows that
// number: issue time plus the expiry the daemon set, recorded when it issued
// the invoice, and once the daemon's own clock is past it an unpaid row still
// HELD is EXPIRED. The expiry is not read back from lnd.
//
// "Unpaid" is what this node knows: it never saw the stake paid. A player can
// pay and never be seen - the page shut before anyone asked - and that HTLC is
// held in lnd past any invoice expiry. So before the clock expires a row the
// sweep asks the one seen-time question, whether it is paid; a paid hold is
// then seen and follows the chain-height rule instead, never the clock.
//
// The tests do not wait an hour: the port says it set a 1 s expiry.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD, CANCELLED, EXPIRED } from '../src/custody.js';
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
const HTLC_EXPIRY = 400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const contractFor = (nodePubkey) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});

/**
 * A Lightning node that issues a hold invoice with the expiry the daemon sets,
 * and pays it or not as the test says. It records every act it is asked for.
 */
function invoicingPort({ expirySeconds = 1, paid = false } = {}) {
  const port = {
    paid, settled: [], cancelled: [], looks: 0,
    async createHeld({ paymentHash, amountMsat }) {
      port.amount = amountMsat;
      return { paymentHash, amountMsat, request: 'lnbcrt-x', expirySeconds };
    },
    async look() {
      port.looks++;
      return port.paid
        ? { state: HELD, amountMsat: port.amount, paidMsat: port.amount, expiryHeight: HTLC_EXPIRY }
        : { state: HELD, amountMsat: port.amount, paidMsat: 0n };
    },
    async settle({ paymentHash }) { port.settled.push(toHex(paymentHash)); },
    async cancel({ paymentHash }) { port.cancelled.push(toHex(paymentHash)); },
  };
  return port;
}

/** A paying entry seated on `node` and its hold issued - never played. */
async function issued(node, n = 5) {
  const c = contractFor(node.round.pubkey);
  const rid = roundId(c);
  await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
  assumeSeated(node.round, rid, c.nodes);
  const entry = {
    roundId: rid, playerPubkey: b32(n), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(b32(n + 60)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE),
    donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  const seated = await fetch(`http://127.0.0.1:${node.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(seated.status, 201, await seated.text());
  const quote = await fetch(`http://127.0.0.1:${node.port}/invoice?entry=${toHex(eid)}`);
  assert.equal(quote.status, 200, await quote.text());
  return eid;
}

const until = async (check, ms = 4000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop && !check()) await wait(50);
};

test('an issued invoice nobody paid is EXPIRED once the daemon\'s own clock is past the expiry it set - HELD before that, and no sats moved', async () => {
  const port = invoicingPort({ expirySeconds: 1 });
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: port, expiry: { everyMs: 50 },
  });
  try {
    const eid = await issued(node);
    const stateOf = () => (node.round.hold(eid) || {}).state;
    await wait(300);
    assert.equal(stateOf(), HELD, 'the row moved before the invoice\'s expiry');
    await until(() => stateOf() === EXPIRED);
    assert.equal(stateOf(), EXPIRED, `the invoice expired unpaid and the row still says ${stateOf()}`);
    assert.match(node.round.hold(eid).why, /unpaid|never paid|nothing was ever sent/, `the row does not say it was never paid: ${node.round.hold(eid).why}`);
    assert.deepEqual(port.settled, [], 'an unpaid invoice was settled');
    assert.deepEqual(port.cancelled, [], 'the daemon acted on an invoice lnd cancels by itself');
  } finally { await node.close(); }
});

test('a restarted daemon expires an unpaid invoice it issued before it stopped - the expiry lives in the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unpaid-expiry-'));
  const path = join(dir, 'node.sqlite');
  try {
    let eid;
    const first = await serve(openStore(path), {
      port: 0, funded: () => true, ...READY, lightning: invoicingPort({ expirySeconds: 1 }), expiry: { everyMs: 60000 },
    });
    try {
      eid = await issued(first);
      assert.equal((first.round.hold(eid) || {}).state, HELD);
    } finally { await first.close(); }
    await wait(1200);   // past the 1 s expiry while no daemon is running
    const again = await serve(openStore(path), {
      port: 0, funded: () => true, ...READY, lightning: invoicingPort({ expirySeconds: 1 }), expiry: { everyMs: 50 },
    });
    try {
      await until(() => (again.round.hold(eid) || {}).state === EXPIRED);
      assert.equal((again.round.hold(eid) || {}).state, EXPIRED,
        `the restarted daemon kept an unpaid, expired invoice ${(again.round.hold(eid) || {}).state}`);
    } finally { await again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hold that was paid but never seen is NOT expired by the invoice clock - it is seen, and then follows the chain height', async () => {
  const port = invoicingPort({ expirySeconds: 1, paid: true });
  let tip = 300;
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: port, chainTip: async () => tip, expiry: { everyMs: 50 },
  });
  try {
    const eid = await issued(node, 6);
    const stateOf = () => (node.round.hold(eid) || {}).state;
    await wait(1600);   // past the invoice's 1 s expiry, never asked /stake
    assert.equal(stateOf(), HELD, `a paid hold was expired by the invoice clock: ${stateOf()}`);
    assert.ok(node.round.stakeSeen(eid), 'the sweep did not see the paid hold before judging it');
    assert.equal(node.round.holdExpiry(eid), HTLC_EXPIRY, 'the paid hold\'s HTLC expiry was not recorded when it was seen');
    tip = HTLC_EXPIRY + 1;
    await until(() => stateOf() === EXPIRED);
    assert.equal(stateOf(), EXPIRED, 'the paid hold did not follow the chain height once seen');
    assert.match(node.round.hold(eid).why, new RegExp(`${HTLC_EXPIRY}`), 'it expired on the clock, not the chain');
  } finally { await node.close(); }
});

test('an unpaid invoice whose expiry the daemon set far out stays HELD - only the daemon\'s own number moves it', async () => {
  const port = invoicingPort({ expirySeconds: 3600 });
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, ...READY, lightning: port, expiry: { everyMs: 50 },
  });
  try {
    const eid = await issued(node, 7);
    port.label = CANCELLED;   // whatever lnd might say, the clock is not there
    await wait(500);
    assert.equal((node.round.hold(eid) || {}).state, HELD, 'an unpaid row moved before the expiry the daemon set');
  } finally { await node.close(); }
});
