// M3 W7: A SEAT STARTED ON A STORE FROM BEFORE THE RULE DOES NOT FALL OVER.
//
// Since W7 a paying FEDERATION round that names no federation is no contract: decoding refuses it.
// A seat's store written before W7 can hold exactly such a round - the hold-invoice rounds were
// labelled FEDERATION with a zero federation_id. The node decodes stored contracts in some fifty
// places, several inside timers, and in Node an unhandled rejection ends the process. Measured
// here: a seat restarted with its timers on, on a store whose one round carries those bytes -
// made by flipping the custody byte of a THRESHOLD_LN round, the exact bytes a build before W7
// stored for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeSeated } from './seating.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = ed25519.utils.randomSecretKey();
const peer = ed25519.utils.randomSecretKey();
const STAKE = 100000n;

const contractFor = (nodePubkey, custody = 'THRESHOLD_LN', stakeMsat = STAKE) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody,
  slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144,
  publicationRelays: ['http://127.0.0.1:9'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [nodePubkey, schnorr.getPublicKey(peer)],
});

/** A Lightning node that issues holds and records what it is asked; nobody pays. */
function holdPort() {
  const port = {
    settled: [], cancelled: [],
    async createHeld({ paymentHash, amountMsat }) { port.amount = amountMsat; return { paymentHash, amountMsat, request: 'lnbcrt-x', expirySeconds: 3600 }; },
    async look() { return { state: HELD, amountMsat: port.amount, paidMsat: 0n }; },
    async settle({ paymentHash }) { port.settled.push(toHex(paymentHash)); },
    async cancel({ paymentHash }) { port.cancelled.push(toHex(paymentHash)); },
  };
  return port;
}

test('a seat restarted on a store holding a paying FEDERATION round with no federation - the bytes a build before W7 stored - stays up, answers, and moves no money', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-round-'));
  const path = join(dir, 'node.sqlite');
  const port = holdPort();
  const seatOpts = { port: 0, funded: () => true, preflight: async () => ({ ready: true, why: 'test port' }), lightning: port,
    expiry: { everyMs: 50 }, finality: { everyMs: 100 }, closeAtEnd: { everyMs: 100 } };
  const rejections = [];
  const onRejection = (e) => rejections.push(String(e && e.message || e));
  process.on('unhandledRejection', onRejection);
  try {
    // 1. A HOLD ROUND AND ITS ISSUED HOLD, on a store file - by a seat with no timers. With its
    // close-at-end timer on (every 100 ms, the round's end long past) it closed the round before
    // the entry came in under load: measured 2026-09-15 07:57, /entry 400 "the round is closed".
    // The timers belong to the restart below, which is what this test measures.
    const { expiry, finality, closeAtEnd, ...setupOpts } = seatOpts;
    const first = await serve(openStore(path), setupOpts);
    const c = contractFor(first.round.pubkey);
    const rid = roundId(c);
    let eid;
    try {
      assert.equal((await fetch(`http://127.0.0.1:${first.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      assumeSeated(first.round, rid, c.nodes);
      const entry = {
        roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
        stakeCommitment: sha256(b32(65)), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE),
        donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
        feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
        feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
      };
      eid = entryId(entry);
      const seated = await fetch(`http://127.0.0.1:${first.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
      assert.equal(seated.status, 201, await seated.text());
      const quote = await fetch(`http://127.0.0.1:${first.port}/invoice?entry=${toHex(eid)}`);
      assert.equal(quote.status, 200, await quote.text());
      assert.equal(first.round.hold(eid).state, HELD);
    } finally { await first.close(); }

    // 2. THE BYTES A BUILD BEFORE W7 STORED FOR IT: the same round labelled FEDERATION, no federation.
    const free = (custody) => encodeRoundContract({ ...c, stakeMsat: 0n, custody });
    const a = free('THRESHOLD_LN'); const b = free('FEDERATION');
    const at = a.findIndex((x, i) => x !== b[i]);
    assert.ok(at > 0 && a.length === b.length, 'no custody byte found');
    const legacy = Uint8Array.from(encodeRoundContract(c));
    legacy[at] = b[at];
    assert.throws(() => decodeRoundContract(legacy), /takes a stake into a FEDERATION and names no federation_id/,
      'the flipped bytes are not the round W7 refuses');
    const db = openStore(path);
    db.prepare('UPDATE rounds SET contract = ? WHERE round_id = ?').run(Buffer.from(legacy), Buffer.from(rid));
    db.close();

    // 3. STARTED AGAIN ON IT, its timers on.
    const again = await serve(openStore(path), seatOpts);
    try {
      await wait(2500);
      const rounds = await fetch(`http://127.0.0.1:${again.port}/rounds`);
      const listed = rounds.ok ? (await rounds.json()).rounds.length : null;
      const bytes = await fetch(`http://127.0.0.1:${again.port}/round?id=${toHex(rid)}`);
      const quote = await fetch(`http://127.0.0.1:${again.port}/invoice?entry=${toHex(eid)}`);
      const quoteText = (await quote.text()).trim();
      const hold = again.round.hold(eid);
      console.log(`  after the restart: unhandled rejections ${rejections.length}; /rounds ${rounds.status} (${listed} listed); `
        + `/round ${bytes.status}; /invoice ${quote.status} "${quoteText.slice(0, 90)}"; hold ${hold && hold.state}; settled ${port.settled.length}, cancelled ${port.cancelled.length}`);
      assert.deepEqual(rejections, [], 'an unhandled rejection - the process would have ended');
      assert.equal(rounds.status, 200);
      assert.equal(listed, 0, 'a round that is no contract was listed');
      assert.equal(bytes.status, 200, 'the stored bytes are no longer served');
      // the invoice door answers every failure to quote as 503 with its reason - measured, not guessed
      assert.equal(quote.status, 503, `the invoice door answered ${quote.status} for a round it cannot read`);
      assert.match(quoteText, /names no federation_id/);
      assert.deepEqual(port.settled, [], 'a hold was settled on a round no seat can read');
    } finally { await again.close(); }
  } finally {
    process.off('unhandledRejection', onRejection);
    rmSync(dir, { recursive: true, force: true });
  }
});
