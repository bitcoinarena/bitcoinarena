// THE PAGE SAYS WHERE THE STAKE STANDS AFTER THE RUN (MF item 14, the page's half).
//
// "Waiting for settlement. Held stake, threshold signing, refund on expiry. The
// player is waiting on other people's machines and must be told so, with the
// refund path visible the whole time." Since M3.3-32 that wait is a whole
// objection window, and measured before this file: once the stake was
// committed the chip read "stake seen by 2 of 2 nodes (2 needed) · committed"
// and nothing else, whether the round was still inside its window, the stake
// had been settled, or it had been handed back. The client stopped asking.
//
// Each settlement seat now answers `GET /settlement` (the node's half). The
// client asks every seat, once the stake is committed, until every seat that
// answers has moved the hold; the chip adds what the seats said.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../../blwp-node/src/cores.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { HELD, SETTLED, CANCELLED } from '../../blwp-node/src/custody.js';
import { assumeSeated } from '../../blwp-node/test/seating.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { encodeTranscriptPosting, transcriptPostingId, joinSignedPosting } from '../../protocol/src/posting.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex } from '../../protocol/src/hash.js';
import { Client } from '../src/client.js';
import { stakeLine, settlementLine } from '../src/ghost-field.js';
import * as join from '../src/join.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const STAKE = 100000n;
const HTLC_EXPIRY = 500;
const WINDOW_MS = 600000n;

/** A Lightning node whose one invoice is paid when the test says so, naming its HTLC's expiry. */
function payablePort() {
  const port = {
    paid: false,
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() {
      return { state: HELD, amountMsat: port.amount, paidMsat: port.paid ? port.amount : 0n, expiryHeight: HTLC_EXPIRY };
    },
    async settle() {}, async cancel() {},
  };
  return port;
}

/** Two daemons, one paying round with the reference window, one seated entry. */
async function committee() {
  const ports = [payablePort(), payablePort()];
  const nodes = [];
  for (const port of ports) nodes.push(await serve(openStore(':memory:'), { port: 0, ...FUNDED, ...READY, lightning: port }));
  const keys = nodes.map((d) => d.round.pubkey);
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
    entryCloseMs: 2000n, objectionWindowMs: WINDOW_MS, custody: 'THRESHOLD_LN',
    slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144,
    // P2: the two seats' own relay doors, where each run's transcript is posted.
    publicationRelays: nodes.map((d) => `http://127.0.0.1:${d.port}`), donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
    censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
    randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n,
    blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: keys,
  };
  const rid = roundId(contract);
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: b32(7), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  for (const d of nodes) {
    const base = `http://127.0.0.1:${d.port}`;
    await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(contract) });
    assumeSeated(d.round, rid, keys);
    const seated = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(seated.status, 201, await seated.text());
  }
  const eid = entryId(entry);
  const bases = nodes.map((d) => `http://127.0.0.1:${d.port}`);
  return {
    nodes, ports, keys, contract, rid, entry, eid, bases,
    // PAID, and seen through each node's own `/stake` - which is when a node
    // learns the HTLC's expiry height.
    pay: async () => {
      for (const p of ports) p.paid = true;
      for (const base of bases) assert.equal((await fetch(`${base}/stake?entry=${toHex(eid)}`)).status, 200);
    },
    // THE ROUND CLOSED AND BOTH SEATS SIGNED THE SAME LOST RUN, AND BOTH POSTED
    // ITS TRANSCRIPT (v4.6.2 §13A, P2): its result is provisionally final and
    // the objection window is running.
    agree: () => {
      for (const d of nodes)
        for (const signer of nodes) {
          const r = { roundId: rid, playerPubkey: entry.playerPubkey, outcome: 'FAILED', score: 0,
            transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: signer.round.pubkey };
          const id = resultId(r);
          d.round.putResult(rid, eid, signer.round.pubkey, id,
            joinSignedResult(encodePlayerResult(r), schnorr.sign(id, signer.round.identity.secret)));
          const p = { roundId: rid, playerPubkey: entry.playerPubkey, transcriptHash: b32(0x11), seatPubkey: signer.round.pubkey };
          d.round.putPosting(rid, eid, signer.round.pubkey,
            joinSignedPosting(encodeTranscriptPosting(p), schnorr.sign(transcriptPostingId(p), signer.round.identity.secret)));
        }
    },
    // EVERY SEAT MOVES THE HOLD, as a settle or a cancel writes it.
    move: (state) => {
      for (const d of nodes) {
        const row = d.round.hold(eid);
        d.round.putHold({ entryId: eid, roundId: row.roundId, paymentHash: row.paymentHash,
          amountMsat: row.amountMsat, state, why: `test: ${state}` });
      }
    },
    close: async () => { for (const d of nodes) { try { await d.close(); } catch { /* gone */ } } },
  };
}

test('after the close the chip names the objection window and the refund height, then says the stake settled - where it kept saying "committed"', async () => {
  const c = await committee();
  try {
    await c.pay();
    const two = await join.stakeSeenBy({ entryId: c.eid, seats: c.keys, nodes: c.bases, contract: c.contract });
    assert.equal(two.committed, true);
    c.agree();
    const agreedAt = Date.now();

    assert.equal(typeof join.settlementBy, 'function', 'the page has no way to ask where a stake stands');
    const s = await join.settlementBy({ entryId: c.eid, seats: c.keys, nodes: c.bases });
    assert.deepEqual([s.of, s.answered, s.hold, s.finality, s.refundHeight], [2, 2, HELD, 'PROVISIONALLY_FINAL', HTLC_EXPIRY]);
    assert.ok(s.windowClosesAtMs >= agreedAt + Number(WINDOW_MS) - 2000 && s.windowClosesAtMs <= Date.now() + Number(WINDOW_MS),
      `the window's end is ${s.windowClosesAtMs - agreedAt} ms after the agreement, for ${WINDOW_MS} ms`);
    const inside = stakeLine({ dealt: true, seen: { ...two, settlement: s } }, s.windowClosesAtMs - 125000);
    console.log(`  inside the window: "${inside}"`);
    assert.equal(inside, ' · stake seen by 2 of 2 nodes (2 needed) · committed'
      + ' · waiting for the objection window, 2:05 left · refunds at block 500 if nobody acts');

    c.move(SETTLED);
    const after = await join.settlementBy({ entryId: c.eid, seats: c.keys, nodes: c.bases });
    assert.equal(after.hold, SETTLED);
    const settled = stakeLine({ dealt: true, seen: { ...two, settlement: after } });
    console.log(`  after it: "${settled}"`);
    assert.equal(settled, ' · stake seen by 2 of 2 nodes (2 needed) · committed · stake settled: this run lost it');
  } finally { await c.close(); }
});

test('the client asks by itself once the stake is committed, and stops once every seat has moved the hold', async () => {
  const c = await committee();
  const client = new Client({ base: c.bases[0], core, sign, verify });
  try {
    await client.join(c.entry);
    await c.pay();
    await client.watchStake({ seats: c.keys, nodes: c.bases, contract: c.contract, everyMs: 50, settlementEveryMs: 50 });
    assert.equal(client.stakeCommitted, true);
    c.agree();
    const until = async (ok, ms = 5000) => { const stop = Date.now() + ms; while (Date.now() < stop && !ok()) await wait(25); };
    await until(() => client.stakeCount && client.stakeCount.settlement && client.stakeCount.settlement.finality === 'PROVISIONALLY_FINAL');
    assert.equal(client.stakeCount?.settlement?.finality, 'PROVISIONALLY_FINAL', 'the client never asked where the committed stake stands');
    assert.ok(client.settlementWatch, 'the watch stopped while the hold was still in flight');

    c.move(CANCELLED);
    await until(() => client.stakeCount.settlement.hold === CANCELLED && !client.settlementWatch);
    assert.equal(client.stakeCount.settlement.hold, CANCELLED);
    assert.equal(client.settlementWatch, null, 'the client kept asking after every seat had handed the stake back');
    const polls = client.settlementPolls;
    await wait(200);
    assert.equal(client.settlementPolls, polls, 'a finished settlement was asked about again');
    assert.match(stakeLine({ dealt: true, seen: client.stakeCount }), /stake handed back$/);
  } finally { client.close(); await c.close(); }
});

test('every state has its words, and a result nobody has agreed on adds none', () => {
  const at = 1_000_000;
  const base = { of: 2, answered: 2, refundHeight: 500, windowClosesAtMs: at + 61000 };
  assert.equal(settlementLine({ ...base, hold: HELD, finality: null }, at), '');
  assert.equal(settlementLine({ ...base, hold: HELD, finality: 'PROVISIONALLY_FINAL' }, at),
    ' · waiting for the objection window, 1:01 left · refunds at block 500 if nobody acts');
  assert.equal(settlementLine({ ...base, hold: HELD, finality: 'FINAL' }, at),
    ' · final: the committee is settling it · refunds at block 500 if nobody acts');
  assert.equal(settlementLine({ ...base, hold: HELD, finality: 'SUSPENDED' }, at),
    ' · suspended by an objection · refunds at block 500 if nobody acts');
  assert.equal(settlementLine({ ...base, hold: SETTLED, finality: 'FINAL' }, at), ' · stake settled: this run lost it');
  assert.equal(settlementLine({ ...base, hold: CANCELLED, finality: 'FINAL' }, at), ' · stake handed back');
  assert.equal(settlementLine({ ...base, hold: 'EXPIRED', finality: null }, at), ' · stake refunded: its hold expired');
  assert.equal(settlementLine({ ...base, hold: HELD, finality: 'PROVISIONALLY_FINAL', refundHeight: null }, at),
    ' · waiting for the objection window, 1:01 left');
  assert.equal(settlementLine({ ...base, answered: 0, hold: null, finality: null }, at), '');
});
