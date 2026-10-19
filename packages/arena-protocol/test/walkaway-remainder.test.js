// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WALK-AWAY'S LOCK WITH NOBODY QUALIFYING (RULED 2026-09-30, destination 1), as `lockSettlement` builds it:
// claimed, 75% to the sitting signer nodes, 25% to the donation set by share_bps - and refused, never built on a guess,
// where the donation set or a donation send is missing. A FORFEIT not at the door keeps the no-qualifier expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockSettlement, donationSendId } from '../src/lock-settlement.js';
import { lockActions, CLAIM, EXPIRE } from '../src/lock-action.js';
import { FORFEIT, FAILED, DELIVERED } from '../src/payout.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rid = b32(1);
const nodes = [b32(0x71), b32(0x72)];
const contract = { nodes };
const fees = { ppm: 0n, baseMsat: 0n };
const entry = (n, outcome, atTheDoor = false) => ({ pubkey: b32(n), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, outcome, score: 0, ...(atTheDoor ? { atTheDoor } : {}) });
const lockOf = (n) => ({ outpoint: { txid: b32(0x40 + n), outIdx: 0n }, amountMsat: 98000n, refundPk: new Uint8Array(33).fill(n) });
const locks = (...ns) => new Map(ns.map((n) => [toHex(b32(n)), lockOf(n)]));

test('lockActions: with nobody qualifying the door walk-away is CLAIM and every other loser EXPIRE; without a walker nothing changes', () => {
  const h = lockActions({ roundId: rid, entries: [entry(5, FORFEIT, true), entry(6, FAILED), entry(7, FORFEIT)], minScore: 1 });
  assert.deepEqual(h.actions.map((a) => a.action), [CLAIM, EXPIRE, EXPIRE]);
  assert.equal(h.remainderMsat, 98000n);
  assert.throws(() => lockActions({ roundId: rid, entries: [entry(6, FAILED), entry(7, FORFEIT)], minScore: 1 }), /operator would keep/);
});

test('lockSettlement: the walker\'s lock is claimed, 75% evenly to the sitting signer nodes, 25% to the donation set by share_bps', () => {
  const p = lockSettlement({ roundId: rid, entries: [entry(5, FORFEIT, true), entry(6, FAILED)], minScore: 1, locks: locks(5, 6), fees, contract,
    donationSet: TEST_DONATION_SET_REGTEST });
  assert.equal(p.ok, true, p.why);
  assert.deepEqual(p.claims.map((c) => toHex(c.pubkey)), [toHex(b32(5))]);
  assert.deepEqual([p.remainder.nodesMsat, p.remainder.donationMsat], [73500n, 24500n]);
  const node = p.payouts.filter((x) => x.kind === 'remainder node');
  assert.deepEqual(node.map((x) => x.msat), [36750n, 36750n]);
  const don = p.payouts.filter((x) => x.kind === 'donation');
  assert.deepEqual(don.map((x) => [x.donation.index, x.msat]).sort(), [[0, 16335n], [1, 8165n]]);
  assert.equal(p.unspentMsat, 0n);
});

test('lockSettlement: the signed plan without a donation send is refused, and one with every send is built', () => {
  const args = { roundId: rid, entries: [entry(5, FORFEIT, true)], minScore: 1, locks: locks(5), fees, contract, donationSet: TEST_DONATION_SET_REGTEST };
  const refused = lockSettlement({ ...args, requireSends: true });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /no accepted Lightning-address send/);
  const refundPk = new Uint8Array(33).fill(9);
  const sends = new Map([[toHex(donationSendId(rid, 0)), { paymentHash: 'aa'.repeat(32), gatewayPk: '02'.repeat(33), refundPk, expiration: 500n, payoutMsat: 16335n }]]);
  assert.match(lockSettlement({ ...args, sends, requireSends: true }).why, /no accepted Lightning-address send/, 'one recipient\'s send is not the set\'s');
  sends.set(toHex(donationSendId(rid, 1)), { paymentHash: 'bb'.repeat(32), gatewayPk: '02'.repeat(33), refundPk, expiration: 500n, payoutMsat: 8165n });
  const built = lockSettlement({ ...args, sends, requireSends: true });
  assert.equal(built.ok, true, built.why);
  assert.equal(built.payouts.filter((x) => x.kind === 'sent').length, 2);
});

test('lockSettlement: no donation set held - refused; a FORFEIT not at the door - nothing of the stakes claimed', () => {
  const noSet = lockSettlement({ roundId: rid, entries: [entry(5, FORFEIT, true)], minScore: 1, locks: locks(5), fees, contract });
  assert.equal(noSet.ok, false);
  assert.match(noSet.why, /donation set/);
  const plain = lockSettlement({ roundId: rid, entries: [entry(7, FORFEIT)], minScore: 1, locks: locks(7), fees, contract, donationSet: TEST_DONATION_SET_REGTEST });
  assert.equal(plain.ok, false, 'a FORFEIT not at the door is refused as before - its lock expires back');
  assert.match(plain.why, /operator would keep/);
});

test('lockSettlement: a held donation share (the recipient did not answer) is a pre-expired contract under the committee key - the 75% unchanged', () => {
  const claimPk = new Uint8Array(33).fill(3);
  const held = (i, msat) => [toHex(donationSendId(rid, i)), { paymentHash: '', gatewayPk: '', refundPk: claimPk, expiration: 0n, payoutMsat: msat, held: true }];
  const p = lockSettlement({ roundId: rid, entries: [entry(5, FORFEIT, true)], minScore: 1, locks: locks(5), fees, contract, donationSet: TEST_DONATION_SET_REGTEST,
    sends: new Map([held(0, 16335n), held(1, 8165n)]), requireSends: true });
  assert.equal(p.ok, true, p.why);
  const h = p.payouts.filter((x) => x.kind === 'held');
  assert.deepEqual(h.map((x) => [toHex(x.payoutPk), x.msat, !!x.sent]).sort(), [[toHex(claimPk), 16335n, false], [toHex(claimPk), 8165n, false]].sort());
  assert.deepEqual(p.payouts.filter((x) => x.kind === 'remainder node').map((x) => x.msat), [36750n, 36750n]);
  assert.equal(p.remainder.heldMsat, 24500n);
  const wrong = lockSettlement({ roundId: rid, entries: [entry(5, FORFEIT, true)], minScore: 1, locks: locks(5), fees, contract, donationSet: TEST_DONATION_SET_REGTEST,
    sends: new Map([held(0, 16000n), held(1, 8165n)]), requireSends: true });
  assert.equal(wrong.ok, false, 'a held share of another amount is built on');
});

test('lockSettlement, WINNINGS-AUTO (RULED 2026-10-01): a qualifier beside a walker and a FAILED player, naming nothing - both losers\' locks are claimed and paid to the qualifier by its contract; no remainder split', () => {
  const winner = { pubkey: b32(8), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n, outcome: DELIVERED, score: 50 };
  const held = locks(5, 6, 8);
  const p = lockSettlement({ roundId: rid, entries: [winner, entry(5, FORFEIT, true), entry(6, FAILED)], minScore: 1, locks: held,
    fees, contract, donationSet: TEST_DONATION_SET_REGTEST });
  assert.equal(p.ok, true, p.why);
  assert.deepEqual(p.claims.map((c) => toHex(c.pubkey)).sort(), [toHex(b32(5)), toHex(b32(6))].sort(), 'not both losers\' locks were claimed');
  const won = p.payouts.filter((x) => x.kind === 'qualifier');
  assert.equal(won.length, 1);
  assert.equal(toHex(won[0].payoutPk), toHex(held.get(toHex(b32(8))).refundPk), 'the winnings are not a contract to the qualifier\'s own key');
  assert.equal(p.remainder, undefined, 'a remainder split was made although a qualifier is paid');
  assert.equal(p.inputFeesMsat + p.paidMsat + p.outputFeesMsat, p.poolMsat, 'the payout and its fees are not the claimed pot');
});

// A SET OF KEYS (2026-10-03): the 25% is paid as a winner is - a payout contract to each recipient's own key - and
// the signed plan needs no Lightning send for it.
test('lockSettlement: with a set of keys the donation share is a payout contract to each key, signed with no send', () => {
  const DEVS = { recipients: [
    { recipientPk: Uint8Array.of(2, ...new Uint8Array(32).fill(0xa1)), shareBps: 6667, label: 'dev a' },
    { recipientPk: Uint8Array.of(3, ...new Uint8Array(32).fill(0xb2)), shareBps: 3333, label: 'dev b' }] };
  const p = lockSettlement({ roundId: rid, entries: [entry(5, FORFEIT, true), entry(6, FAILED)], minScore: 1, locks: locks(5, 6), fees, contract,
    donationSet: DEVS, requireSends: true });
  assert.equal(p.ok, true, p.why);
  const keyed = p.payouts.filter((x) => x.kind === 'donation key');
  assert.deepEqual(keyed.map((x) => [Buffer.from(x.payoutPk).toString('hex').slice(0, 4), x.donation.label]), [['02a1', 'dev a'], ['03b2', 'dev b']]);
  assert.equal(p.payouts.filter((x) => x.kind === 'donation').length, 0, 'no share is left for a Lightning send');
  assert.ok(keyed[0].msat > keyed[1].msat);
});
