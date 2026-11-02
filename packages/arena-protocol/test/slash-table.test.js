// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §5A.3: A TABLE THAT IS NOT F, ON THE SEAT'S OWN ACK (RULED 2026-11-02, kanban #1035, #1040). The accused's SettlementAck is the evidence,
// a threshold of acks shows a settlement stood on the table, and F reads only entries with a threshold of FINAL signatures: a §13C
// outcome is one seat's clock, so an entry decided that way is left out and the table is not false on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../src/hash.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { entryFeeMsat } from '../src/fee.js';
import { entryId, roundId } from '../src/contracts.js';
import { computePayoutTable, netStakeMsat } from '../src/payout.js';
import { encodePlayerResult, joinSignedResult } from '../src/result.js';
import { runOf } from '../src/rerun.js';
import { windowsOf } from '../src/window.js';
import { signFinalSig } from '../src/final-sig.js';
import {
  signSettlementAck, settlementAckId, encodeSettlementTable, decodeSettlementTable, settlementTableId, splitSignedAck, countAcks, checkAck,
  joinAcks, splitAcks, encodeSettlementAck, decodeSettlementAck, planTableRows,
} from '../src/settlement-ack.js';
import { slashHoldsOnTable, slashHoldsOnWithheld, slashCommitment, TABLE_IS_NOT_F } from '../src/slash.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(0x40 + n); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const committee = seats.map((s) => s.pubkey);
const NODE = seats[0];
const BOND = b32(0x55);
const contract = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000, corridorHalfWidth: 40,
  spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 100,
  rankNumerator: 3, rankDenominator: 4, nodes: committee,
};
const ROUND = roundId(contract);
const TXID = b32(0x77);
const advert = { nodePubkey: NODE.pubkey, bondTxid: BOND, bondVout: 3 };
const { finalAfterMs } = windowsOf(contract);

const entryOf = (n) => ({
  roundId: ROUND, playerPubkey: b32(0xa0 + n), sessionPubkey: b32(0x0b), stakeCommitment: b32(0x0c), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(n), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const OUTCOMES = [['DELIVERED', 900], ['DELIVERED', 500], ['FAILED', 0], ['FORFEIT', 0]];
const entries = OUTCOMES.map((_, i) => entryOf(i + 1));

const resultOf = (i, over = {}) => {
  const [outcome, score] = OUTCOMES[i];
  return { roundId: ROUND, playerPubkey: entries[i].playerPubkey, outcome, score, transcriptHash: b32(0x44 + i), simCoreHash: b32(1), nodePubkey: committee[0], ...over };
};
const finalOf = (i, over = {}, signers = seats.slice(0, 5)) => ({
  entry: entries[i],
  signedResult: joinSignedResult(encodePlayerResult(resultOf(i, over)), new Uint8Array(64).fill(7)),
  finalSigs: signers.map((s) => signFinalSig({ roundId: ROUND, entryId: entryId(entries[i]), runId: runOf(resultOf(i, over)), signerPubkey: s.pubkey, signedAtMs: finalAfterMs + 1n },
    (d) => schnorr.sign(d, s.secret))),
});
const finals = () => entries.map((_, i) => finalOf(i));

// F over the four entries, as a seat's table: each row names its entry
const honestRows = () => {
  const inF = entries.map((e, i) => ({ entryId: entryId(e), pubkey: e.playerPubkey, outcome: OUTCOMES[i][0], score: OUTCOMES[i][1], stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat }));
  const f = computePayoutTable({ roundId: ROUND, entries: inF, minScore: contract.minScore });
  return f.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: f.table[i].amountMsat }));
};
const tableOf = (rows, over = {}) => ({ roundId: ROUND, rows, ...over });
const ackBy = (seat, table, txid = TXID) => signSettlementAck({ roundId: table.roundId, payoutTableId: settlementTableId(table), settlementTxid: txid }, seat.pubkey, (d) => schnorr.sign(d, seat.secret));
const ask = (t, over = {}) => {
  const signedAck = ackBy(NODE, t);
  const { ack } = splitSignedAck(signedAck);
  return slashHoldsOnTable({
    proof: { roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE.pubkey, transcriptHash: ack.payoutTableId, signedResultId: settlementAckId(ack), bondTxid: BOND, bondVout: 3 },
    signedAck, acks: seats.slice(1, 5).map((s) => ackBy(s, t)), table: encodeSettlementTable(t), finals: finals(), contract, advert, committee, verify, ...over,
  });
};
const shaved = () => tableOf(honestRows().map((r) => (r.amountMsat > 0n ? { ...r, amountMsat: r.amountMsat - 1n } : r)));

test('an honest table stands, one millisatoshi off it slashes the bond that acked it', () => {
  const honest = ask(tableOf(honestRows()));
  assert.equal(honest.slashed, false, honest.why);
  assert.equal(honest.bond, undefined);
  assert.match(honest.why, /exactly F/);

  const moved = honestRows();
  const from = moved.findIndex((r) => r.amountMsat > 0n);
  moved[from] = { ...moved[from], amountMsat: moved[from].amountMsat - 1n };
  const t = tableOf(moved);
  const after = ask(t);
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, TABLE_IS_NOT_F);
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.equal(after.complete, true);
  assert.equal(after.differs.length, 1);
  const { ack } = splitSignedAck(ackBy(NODE, t));
  assert.equal(toHex(after.commitment), toHex(slashCommitment({ roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE.pubkey,
    transcriptHash: ack.payoutTableId, signedResultId: settlementAckId(ack), bondTxid: BOND, bondVout: 3 })));
});

test('the ack has to be the accused\'s own signature: an unsigned one, or another key\'s, slashes nobody', () => {
  const t = shaved();
  const signedAck = ackBy(NODE, t);
  const blanked = signedAck.slice();
  blanked.fill(0, blanked.length - 64);
  const noSig = ask(t, { signedAck: blanked });
  assert.equal(noSig.slashed, false);
  assert.match(noSig.why, /not the accused node's/);
  const forged = signedAck.slice();
  forged.set(schnorr.sign(settlementAckId(splitSignedAck(signedAck).ack), seats[1].secret), forged.length - 64);
  assert.equal(ask(t, { signedAck: forged }).slashed, false);
  assert.equal(ask(t, { signedAck: ackBy(seats[1], t) }).slashed, false, 'an ack by another seat');
  assert.match(ask(t, { verify: undefined }).why, /needs a verifier/);
});

test('a table short of the threshold of acks moved nothing, so nobody is slashed for it', () => {
  const t = shaved();
  const no = ask(t, { acks: seats.slice(1, 4).map((s) => ackBy(s, t)) });
  assert.equal(no.slashed, false);
  assert.match(no.why, /4 of the 5 seats acked/);
  const twice = ask(t, { acks: [ackBy(NODE, t), ackBy(NODE, t), ackBy(seats[1], t)] });
  assert.match(twice.why, /2 of the 5 seats/, 'one seat acking twice is one ack');
  const another = ask(t, { acks: seats.slice(1, 5).map((s) => ackBy(s, t, b32(0x78))) });
  assert.match(another.why, /1 of the 5 seats/, 'acks over another transaction are not this settlement\'s');
});

test('an entry with no signed FINAL is left out: a §13C row makes no honest table false, and a short FINAL is not one', () => {
  // the seat decided entry 4 (FORFEIT) on its own clock: no threshold of FINAL signatures exists for it
  const noFourth = [finalOf(0), finalOf(1), finalOf(2)];
  const honest = ask(tableOf(honestRows()), { finals: noFourth });
  assert.equal(honest.slashed, false, honest.why);
  assert.match(honest.why, /not false on any entry with a signed FINAL/);
  // F of the three proved alone is another table (the pool is smaller): it must not be read as the exact F
  const short = ask(tableOf(honestRows()), { finals: [finalOf(0), finalOf(1), finalOf(2), finalOf(3, {}, seats.slice(0, 4))] });
  assert.equal(short.slashed, false, 'four FINAL signatures are not FINAL');
  // and a filer who writes a losing result for a winner has no threshold for that run
  const fed = ask(tableOf(honestRows()), { finals: [{ ...finalOf(0), signedResult: finalOf(0, { outcome: 'FAILED', score: 0 }).signedResult }, ...[1, 2, 3].map((i) => finalOf(i))] });
  assert.equal(fed.slashed, false, fed.why);
  const late = finalOf(3, {}, seats.slice(0, 5).map((s) => s));
  late.finalSigs = seats.slice(0, 5).map((s) => signFinalSig({ roundId: ROUND, entryId: entryId(entries[3]), runId: runOf(resultOf(3)), signerPubkey: s.pubkey, signedAtMs: finalAfterMs - 1n }, (d) => schnorr.sign(d, s.secret)));
  assert.equal(ask(shaved(), { finals: [late] }).slashed, false, 'FINAL signed before the window closed counts for nothing');
});

test('with a row unproved only what F owes whatever it was is read: a proved loser paid, a proved qualifier under its stake', () => {
  const rows = honestRows();
  const three = [finalOf(0), finalOf(1), finalOf(2)];
  const at = (i) => rows.findIndex((r) => toHex(r.entryId) === toHex(entryId(entries[i])));
  const paidLoser = rows.map((r, i) => (i === at(2) ? { ...r, amountMsat: 1n } : r));
  const a = ask(tableOf(paidLoser), { finals: three });
  assert.equal(a.slashed, true, a.why);
  assert.equal(a.complete, false);
  assert.match(a.why, /did not qualify/);
  const under = rows.map((r, i) => (i === at(0) ? { ...r, amountMsat: netStakeMsat(entries[0]) - 1n } : r));
  const b = ask(tableOf(under), { finals: three });
  assert.equal(b.slashed, true, b.why);
  assert.match(b.why, /under its own net stake/);
  // moving the pool between proved qualifiers cannot be read with a row out: F's split depends on it
  const shifted = rows.map((r, i) => (i === at(0) ? { ...r, amountMsat: r.amountMsat - 1n } : i === at(1) ? { ...r, amountMsat: r.amountMsat + 1n } : r));
  assert.equal(ask(tableOf(shifted), { finals: three }).slashed, false);
});

test('an entry shown without FINAL contradicts a row only by its own bytes', () => {
  const rows = honestRows();
  const stolen = rows.map((r) => (toHex(r.entryId) === toHex(entryId(entries[0])) ? { ...r, pubkey: b32(0xee) } : r));
  const no = ask(tableOf(rows), { finals: [], entries });
  assert.equal(no.slashed, false, no.why);
  const yes = ask(tableOf(stolen), { finals: [], entries });
  assert.equal(yes.slashed, true, yes.why);
  assert.match(yes.why, /another player's/);
});

test('a table F did not make is not read: a late loser\'s, and one that names no entries', () => {
  const late = ask(tableOf(honestRows(), { lateEntryId: b32(0x31) }));
  assert.equal(late.slashed, false);
  assert.match(late.why, /late loser/);
  const plan = ask(tableOf(planTableRows({ payouts: [{ payoutPk: b32(0xa1), msat: 5n }] })));
  assert.equal(plan.slashed, false);
  assert.match(plan.why, /names no entries/);
});

test('the proof, the contract, the table and the bond are each bound', () => {
  const t = shaved();
  assert.match(ask(t, { contract: { ...contract, minScore: 600 } }).why, /not this round's/);
  assert.match(ask(t, { contract: undefined }).why, /no round contract/);
  assert.match(ask(t, { table: encodeSettlementTable(tableOf(honestRows())) }).why, /not the one the ack names/);
  assert.match(ask(t, { table: new Uint8Array(9) }).why, /not a settlement table/);
  assert.match(ask(t, { signedAck: new Uint8Array(9) }).why, /not a signed ack/);
  const proofWith = (over) => { const a = splitSignedAck(ackBy(NODE, t)).ack; return { roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE.pubkey, transcriptHash: a.payoutTableId, signedResultId: settlementAckId(a), bondTxid: BOND, bondVout: 3, ...over }; };
  assert.match(ask(t, { proof: proofWith({ playerPubkey: b32(1) }) }).why, /names no player/);
  assert.match(ask(t, { proof: proofWith({ transcriptHash: b32(1) }) }).why, /different table/);
  assert.match(ask(t, { proof: proofWith({ signedResultId: b32(1) }) }).why, /not the one this proof names/);
  assert.match(ask(t, { proof: proofWith({ bondTxid: b32(0x99) }) }).why, /the proof names bond 9999/);
  assert.equal(ask(t, { proof: proofWith({ bondVout: 4 }) }).slashed, false);
  assert.match(ask(t, { advert: undefined }).why, /no advertisement/);
  assert.match(ask(t, { committee: [seats[1].pubkey] }).why, /not on this round's committee/);
  assert.match(ask(t, { committee: [] }).why, /no committee/);
  for (const bad of [{ finals: [{ entry: {} }, null, {}] }, { entries: [{}, null] }])
    assert.doesNotThrow(() => ask(t, bad), 'a decision function answers, it does not raise');
});

test('the ack and the table are bytes that survive, and every field is in their ids', () => {
  const a = { roundId: ROUND, payoutTableId: b32(2), settlementTxid: b32(3) };
  assert.deepEqual(decodeSettlementAck(encodeSettlementAck(a)), a);
  const was = toHex(settlementAckId(a));
  for (const over of [{ roundId: b32(9) }, { payoutTableId: b32(9) }, { settlementTxid: b32(9) }])
    assert.notEqual(toHex(settlementAckId({ ...a, ...over })), was);
  const longer = new Uint8Array(encodeSettlementAck(a).length + 1);
  longer.set(encodeSettlementAck(a));
  assert.throws(() => decodeSettlementAck(longer), /trailing bytes/);

  const t = tableOf(honestRows());
  assert.equal(toHex(settlementTableId(decodeSettlementTable(encodeSettlementTable(t)))), toHex(settlementTableId(t)));
  assert.equal(toHex(settlementTableId(tableOf([...t.rows].reverse()))), toHex(settlementTableId(t)), 'the same rows in another order are the same table');
  assert.notEqual(toHex(settlementTableId({ ...t, lateEntryId: b32(1) })), toHex(settlementTableId(t)));
  assert.notEqual(toHex(settlementTableId(tableOf(t.rows.map((r, i) => (i ? r : { ...r, entryId: b32(0xfe) }))))), toHex(settlementTableId(t)), 'the entry is in the id');

  const acks = seats.slice(0, 6).map((s) => ackBy(s, t));
  assert.equal(splitAcks(joinAcks(acks)).length, 6);
  const c = countAcks({ acks: [...acks, acks[0], new Uint8Array(3)], seats: committee, slots: 7, roundId: ROUND, payoutTableId: settlementTableId(t), settlementTxid: TXID, verify });
  assert.deepEqual([c.agreed, c.needed, c.final, c.refused.length], [6, 5, true, 1]);
  const stranger = { secret: b32(0x7f), pubkey: schnorr.getPublicKey(b32(0x7f)) };
  assert.match(checkAck(ackBy(stranger, t), { seats: committee, roundId: ROUND, payoutTableId: settlementTableId(t), settlementTxid: TXID, verify }).why, /not one of the round's seats/);
});

test('a withheld signature refuses by name: an ack, a transaction and an expiry do not show who did not sign', () => {
  const no = slashHoldsOnWithheld();
  assert.equal(no.slashed, false);
  assert.match(no.why, /do not show which seat/);
});
