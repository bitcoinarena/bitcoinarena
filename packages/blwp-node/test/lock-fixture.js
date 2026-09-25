// A SIGNER NODE OF A PAYING FEDERATION ROUND, a player's stake dealt and joined, and a
// federation port that holds locks by outpoint - shared by signer-node-lock.test.js
// (W2) and lock-client.test.js (W1a). Moved here unchanged, except that the
// entry's stake_lock_outpoint can be given (zeros, for the refusal).
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { b32, rand, STAKE, WINDOW_MS, contractFor, opts } from './window-fixture.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';

const secretScalar = () => { let p = rand(32); while (scalarFrom32(p) >= FIELD) p = rand(32); return p; };
// HARNESS KEY: a claim key the tests hand a signer node (`claimKeyFor`), to measure the
// lock check in isolation. The shipping path's signer nodes make their own
// (claim-key-own.test.js).
export const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);

/** A federation port that holds locks by outpoint and counts every ask. */
// TWO GATEWAYS ON TWO LIGHTNING NODES, both answering - what §23.6 asks of a paying round's federation, and
// what the door counts through the port (`gateways()`). A test of that gate hands its own list.
// Each with its own terms for a Lightning send, as routing_info answers them - what a winnings contract is sized by.
const TERMS = { sendFeeDefault: { baseMsat: 4000n, ppm: 6000n }, expirationDeltaDefault: 1440, expirationDeltaMinimum: 144 };
export const TWO_GATEWAYS = [
  { url: 'http://gw-a.example/', live: true, lightningPublicKey: '02' + 'a1'.repeat(32), modulePublicKey: '02' + 'c3'.repeat(32), ...TERMS },
  { url: 'http://gw-b.example/', live: true, lightningPublicKey: '03' + 'b2'.repeat(32), modulePublicKey: '03' + 'd4'.repeat(32), ...TERMS },
];

/**
 * AN ENTRY AS PRODUCTION SHAPES IT, ON THIS PORT'S FEDERATION (RULED 2026-09-25: a paying round opens only on a signer node
 * that reaches a federation, and its entry door takes no staked entry that names no fee lock): the stake locked to the
 * entry's stake point, the 2% fee locked to H(F), both stored in `port`. Returns the entry with its fee preimage and both
 * outpoints named - call it before the entry's id is taken. `playerKey` is the key the refunds go to.
 */
export async function lockedEntry(port, entry, playerKey) {
  const feeSecret = rand(32);
  Object.assign(entry, { feePreimage: feeSecret, stakeLockOutpoint: { txid: rand(32), outIdx: 0n }, feeLockOutpoint: { txid: rand(32), outIdx: 1n } });
  const claimPk = new Uint8Array(33).fill(2);
  await port.put(entry.stakeLockOutpoint, { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk, refundPk: refundKeyOf(playerKey), expiration: port.height + 200 });
  await port.put(entry.feeLockOutpoint, { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat,
    claimPk, refundPk: refundKeyOf(playerKey), expiration: port.height + 200 });
  return entry;
}

export function lockPort({ height = 1000, gateways = TWO_GATEWAYS } = {}) {
  const locks = new Map();
  const port = {
    // THE STAND-IN FEDERATION'S ID (W7): a round on this port names it, never an id of its own.
    federationId: TEST_FEDERATION_ID,
    async gateways() { return { federationId: TEST_FEDERATION_ID, height: port.height, gateways }; },
    // A SENT WINNING, as a gateway answers it: the message the committee signs (here the invoice's hash, as the real
    // tool's consensus hash stands in), and - given the refund key's signature over it - the preimage it paid with.
    // Asked twice for one contract it answers the one payment it made, as the stock gateway joins its operation.
    preimages: new Map(),        // payment hash hex -> the preimage the recipient's invoice was made with
    gatewayPayments: [],
    async send({ gateway, paymentHash, amountMsat, expiration, claimPk, refundPk, invoice, auth = null }) {
      const message = sha256(new TextEncoder().encode(`auth:${invoice}`));
      const contractId = toHex(sha256(new TextEncoder().encode(JSON.stringify([paymentHash, String(amountMsat), String(expiration), claimPk, toHex(refundPk)]))));
      const said = { contractId, message };
      if (!auth) return said;
      let good = false;
      try { good = schnorr.verify(auth, message, refundPk.subarray(1)); } catch { good = false; }
      if (!good) return { ...said, sent: false, why: 'Invalid auth signature for the invoice data' };
      if (port.gatewayDown === gateway) return { ...said, sent: false, why: `${gateway} did not answer` };
      const preimage = port.preimages.get(String(paymentHash));
      if (!preimage) return { ...said, sent: false, why: 'the recipient knows no such invoice' };
      if (!port.gatewayPayments.some((x) => x.contractId === contractId)) port.gatewayPayments.push({ contractId, gateway, paymentHash, amountMsat });
      // AND THE GATEWAY CLAIMS THE CONTRACT with the preimage: it is no longer held.
      for (const [k, v] of locks) if (v.fields.paymentHash === String(paymentHash)) locks.delete(k);
      return { ...said, sent: true, preimage };
    },
    asked: 0, height, locks,
    async status(outpoint) {
      port.asked++;
      const at = locks.get(`${toHex(outpoint.txid)}:${outpoint.outIdx}`);
      return { blockCount: port.height, stored: at ? { contractId: at.id, blocksLeft: at.fields.expiration - port.height } : null };
    },
    // A stand-in for the stock client's hash of a contract: any function of every field.
    async contractId(f) {
      port.asked++;
      return toHex(sha256(new TextEncoder().encode(JSON.stringify([f.paymentImage.kind, toHex(f.paymentImage.bytes),
        String(f.amountMsat), toHex(f.claimPk), toHex(f.refundPk), f.expiration]))));
    },
    async put(outpoint, fields) { locks.set(`${toHex(outpoint.txid)}:${outpoint.outIdx}`, { fields, id: await port.contractId(fields) }); port.asked--; },
    // THE ROUND'S ONE SETTLEMENT (W4), checked as the guardians check it: every
    // claimed lock stored at its outpoint, each P the scalar of that lock's
    // point, the signature BIP-340 under the lock's claim_pk over the txid, and
    // the payouts and their fees inside what the locks pay. Accepted: the locks
    // are gone and the payouts stored. The txid stands in for the stock one: a
    // hash of every input, output and the nonce.
    // THE FEDERATION'S OWN LNv2 RULE BY DEFAULT - 1000 msat per input and output, 0 ppm,
    // as the regtest guardians answered (feeRule, W4). Under it a 100 sat round mints no
    // fee lock (Pick b's gate), so a round that is not about fees signer nodes its entries as it
    // always did; zero was no federation's rule, and under it the gate mints at 100 sat
    // and pick (a)'s door rightly refuses an entry that brings no fee lock. A test about
    // the fee arithmetic sets its own rule.
    // A FEDERATION BLWP WOULD ACCEPT (2026-09-21). This said 1000 msat - fedimintd 0.12.0's measured default,
    // kept in `protocol/test/lock-settlement.js` as REAL_RULE - and §22A requires the opposite: "Fedimint's own
    // base fees are 0: the federation runs with `disable_base_fees`". Once the node enforced that at the entry
    // door, every entry into a round on this port was 409 - 43 tests across five suites - because the fixture's
    // own federation was one the money law refuses. It is legal AT REST now; a suite that wants fedimintd's
    // default for settlement arithmetic sets `port.feeRule` after its entries are in, which is the mutation
    // this file's own lock-settlement suite already used.
    feeRule: { ppm: 0n, baseMsat: 0n },
    settlements: [],
    payouts: new Map(),
    async fees() { return port.feeRule; },
    async settle({ claimPk, claims, payouts, nonce, signature = null, refunds = [] }) {
      const message = sha256(new TextEncoder().encode(JSON.stringify([
        claims.map((c) => [toHex(c.outpoint.txid), String(c.outpoint.outIdx), toHex(c.preimage), String(c.amountMsat)]),
        ...(refunds.length ? [refunds.map((r) => ['refund', toHex(r.outpoint.txid), String(r.outpoint.outIdx), String(r.amountMsat)])] : []),
        payouts.map((p) => [toHex(p.payoutPk), String(p.msat), ...(p.sent ? [p.sent.paymentHash, p.sent.gatewayPk, String(p.sent.expiration)] : [])]), toHex(nonce)])));
      const said = { txid: toHex(message), message: toHex(message), accepted: false, error: null };
      if (!signature) return said;
      port.settlements.push({ claims, payouts, signature, refunds });
      // THE SAME BYTES AGAIN ARE ACCEPTED AGAIN, as the real guardians answered
      // (stake-lock-step3.sh, (c1)): two signer nodes submitting one txid is harmless.
      if (port.accepted.has(toHex(message))) return { ...said, accepted: true };
      const fee = (m) => port.feeRule.baseMsat + (m * port.feeRule.ppm) / 1000000n;
      for (const c of claims) {
        const at = locks.get(`${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`);
        if (!at) return { ...said, error: `no contract at ${toHex(c.outpoint.txid).slice(0, 12)}: already spent` };
        const opens = at.fields.paymentImage.kind === 'hash'
          ? toHex(sha256(c.preimage)) === toHex(at.fields.paymentImage.bytes)
          : toHex(feldmanGroup.pointFromScalar(scalarFrom32(c.preimage) % FIELD)) === toHex(at.fields.paymentImage.bytes);
        if (!opens) return { ...said, error: 'the preimage does not open that contract' };
        let good = false;
        try { good = schnorr.verify(signature, message, at.fields.claimPk.subarray(1)); } catch { good = false; }
        if (!good) return { ...said, error: 'a signature does not verify under the input\'s claim key' };
      }
      // AN EXPIRED CONTRACT SPENT BACK BY ITS REFUND KEY: only past its expiration, and only under that key.
      for (const r of refunds) {
        const at = locks.get(`${toHex(r.outpoint.txid)}:${r.outpoint.outIdx}`);
        if (!at) return { ...said, error: 'no contract at that outpoint: already spent' };
        if (port.height < at.fields.expiration) return { ...said, error: 'that contract has not expired: it cannot be refunded' };
        let good = false;
        try { good = schnorr.verify(signature, message, at.fields.refundPk.subarray(1)); } catch { good = false; }
        if (!good) return { ...said, error: 'a refund is not signed by the contract\'s refund key' };
      }
      const into = claims.reduce((t, c) => t + c.amountMsat - fee(c.amountMsat), 0n)
        + refunds.reduce((t, r) => t + r.amountMsat - fee(r.amountMsat), 0n);
      const out = payouts.reduce((t, p) => t + p.msat + fee(p.msat), 0n);
      if (out > into) return { ...said, error: 'the transaction is unbalanced' };
      for (const c of [...claims, ...refunds]) locks.delete(`${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`);
      payouts.forEach((p, i) => {
        port.payouts.set(`${toHex(message)}:${i}`, { payoutPk: p.payoutPk, msat: p.msat, sent: p.sent || null });
        // A PAYOUT IS A PRE-EXPIRED LOCK, stored where the federation stores locks.
        // A SENT WINNING is the gateway's to claim until its expiration, then its refund key's (the committee's).
        locks.set(`${toHex(message)}:${i}`, { fields: { amountMsat: p.msat, refundPk: p.payoutPk, claimPk: p.payoutPk,
          expiration: p.sent ? Number(p.sent.expiration) : 0, paymentHash: p.sent ? p.sent.paymentHash : null }, id: `payout-${i}` });
      });
      port.accepted.add(toHex(message));
      void claimPk;
      return { ...said, accepted: true };
    },
    accepted: new Set(),
  };
  return port;
}

/** One signer node of a paying FEDERATION round, a player's stake dealt and joined, the entry naming its lock. */
export async function joinedWithLock(extra = {}, { federationId = TEST_FEDERATION_ID, custody = 'FEDERATION', outpoint: given } = {}) {
  const port = lockPort();
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, stakeLocks: port, ...extra });
  let c; let rid;
  // A ROUND THE CODEC OR THE DOOR REFUSES (M3 W7) CLOSES THE SIGNER NODE IT STARTED: measured, a refused
  // contract left this signer node open and the test file never exited.
  try {
    c = { ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), [`http://127.0.0.1:${d.port}`]), custody, federationId };
    rid = roundId(c);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
  } catch (e) { await d.close(); throw e; }
  assumeAssigned(d.round, rid, c.nodes);
  const preimage = secretScalar();
  const e = rand(32);
  const player = rand(32);
  const dealt = await dealHandout({
    preimage, signerNodes: c.nodes, roundId: rid, playerPubkey: player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup,
  });
  assert.equal(dealt.ok, true, dealt.why);
  const outpoint = given || { txid: rand(32), outIdx: 0n };
  // THE FEE LOCK THE ENTRY NAMES (§23.1 step 5, pick a). A round that mints fee locks
  // takes no entry that brings none: the door refuses a zeroed `feePreimage` or a
  // zeroed `feeLockOutpoint` by name, and the stake would stay verified-but-unseen
  // behind it. `client.js:609` has always handed this lock right after the stake
  // lock; this fixture named neither, so four tests here asked the node to accept
  // the incomplete case. F is its own secret, never the stake's - claiming the fee
  // with the stake's preimage would publish P (F5).
  const feePreimage = rand(32);
  const feeLockOutpoint = { txid: rand(32), outIdx: 0n };
  const entry = {
    roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: b32(0x16), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage, stakeLockOutpoint: outpoint, feeLockOutpoint,
    claimKeyAttestationRef: new Uint8Array(32),
  };
  assert.equal((await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
  const joined = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
  assert.equal(joined.status, 201, await joined.text());
  const eid = entryId(entry);
  // THE LOCK THE PLAYER MADE, as the federation stores it.
  const fields = {
    paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry),
    claimPk: CLAIM, refundPk: refundKeyOf(player), expiration: port.height + 200,
  };
  await port.put(outpoint, fields);
  // AND THE FEE LOCK BESIDE IT, put in the federation and handed over the same way
  // the client hands it - so the stake is SEEN once its own lock is verified.
  const feeFields = {
    paymentImage: { kind: 'hash', bytes: sha256(entry.feePreimage) }, amountMsat: entry.feeMsat,
    claimPk: CLAIM, refundPk: refundKeyOf(player), expiration: port.height + 200,
  };
  await port.put(feeLockOutpoint, feeFields);
  // ONLY A FEDERATION ROUND HAS A FEE LOCK TO HAND, which is the client's own
  // condition (`if (this.stakeLock.feeLock)`): a round that names no federation
  // answers "its fee is not a lock" and there is nothing to verify.
  if (custody === 'FEDERATION') {
    const feeSaid = await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(eid)}`,
      { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
    assert.equal(feeSaid.status, 201, await feeSaid.text());
  }
  // THE COUNTER STARTS AT THE TEST, NOT AT THE SETUP. `port.asked` measures how often
  // the NODE asks the federation, and the test that reads it wants the two asks the
  // stake lock's own handover costs - status, then contract id. Before the fee lock
  // was handed here the fixture asked nothing and the count was already 2 by that
  // meaning; handing it adds two more of the fixture's own. Zeroing here keeps the
  // number the test asserts the number it was written to assert.
  port.asked = 0;
  return { d, port, c, rid, entry, eid, fields, outpoint, feeFields, feeLockOutpoint, close: () => d.close() };
}

