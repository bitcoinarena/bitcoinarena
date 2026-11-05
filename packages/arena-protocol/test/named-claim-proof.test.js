// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROOF OF A NAMED CLAIM'S OFFENCE (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1, rulings #1131 4, #1135 2): its bytes, and the judge over the
// claim reader's answer. The round, entries, FINALs and plan are slash-table.test.js's (copied below). The reader's answer (arena-claim-read) is
// written out as the tool prints it; the tool's own reading of real sessions is measured on a regtest (phase 4).
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
  joinAcks, splitAcks, encodeSettlementAck, decodeSettlementAck, planTableRows, planTableBuild,
} from '../src/settlement-ack.js';
import { slashHoldsOnTable, slashHoldsOnWithheld, TABLE_IS_NOT_F, encodeSlashProof, joinTableSlashEvidence, splitTableSlashEvidence, cutTableSlashEvidence, tableSlashEvidenceBytesOf } from '../src/slash.js';
import { lockSettlement, lateSettlementNonce, settlementNonce } from '../src/lock-settlement.js';
import { federationSettlementNonce } from '../src/federation-settlement.js';
import { tableBuild } from '../src/settlement-rebuild.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { RESULT_TYPE } from '../src/manifest.js';
import { sha256 } from '../src/hash.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

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

// EACH ENTRY'S P IS THE SCALAR b32(0x10 + n): a real point in its contract, so a shown P either opens it or does not
const secretOf = (n) => b32(0x10 + n);
const pointOf = (scalar) => secp256k1.Point.BASE.multiply(scalar).toBytes(true);
const entryOf = (n) => ({
  roundId: ROUND, playerPubkey: b32(0xa0 + n), sessionPubkey: b32(0x0b), stakeCommitment: b32(0x0c), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(n), vssSharesRef: new Uint8Array(32), stakePoint: secp256k1.getPublicKey(secretOf(n), true), feePreimage: b32(0x20 + n),
  stakeLockOutpoint: { txid: b32(0x30 + n), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x30 + n), outIdx: 1n }, claimKeyAttestationRef: new Uint8Array(32),
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

// F over the four entries, as a seat's table: each row names its entry and what the seat held for it
const FEES = { ppm: 1000n, baseMsat: 100n };
const CLAIM_PK = refundKeyOf(b32(0xcc));
const inF = () => entries.map((e, i) => ({ entryId: entryId(e), pubkey: e.playerPubkey, outcome: OUTCOMES[i][0], score: OUTCOMES[i][1], stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: e.donationMsat }));
const honestRows = () => {
  const f = computePayoutTable({ roundId: ROUND, entries: inF(), minScore: contract.minScore });
  return f.activated.map((e, i) => ({ entryId: e.entryId, pubkey: e.pubkey, amountMsat: f.table[i].amountMsat, outcome: e.outcome, score: e.score }));
};
// THE PLAN THE SEATS BUILD, stake and fee part, listed in the table as the seats list it
const plan = () => lockSettlement({ roundId: ROUND, entries: inF(), minScore: contract.minScore, fees: FEES, contract, signerNodes: { gameVerify: committee, settlement: committee },
  locks: new Map(entries.map((e) => [toHex(e.playerPubkey), { outpoint: e.stakeLockOutpoint, amountMsat: netStakeMsat(e), refundPk: refundKeyOf(e.playerPubkey) }])),
  feeLocks: new Map(entries.map((e) => [toHex(e.playerPubkey), { outpoint: e.feeLockOutpoint, amountMsat: e.feeMsat, preimage: e.feePreimage }])) });
const entryByKey = new Map(entries.map((e) => [toHex(e.playerPubkey), entryId(e)]));
const built = () => planTableBuild(plan(), (c) => entryByKey.get(toHex(c.pubkey)));
const tableOf = (rows, over = {}) => ({ roundId: ROUND, rows, claimPk: CLAIM_PK, ...built(), ...over });
const preimages = () => new Map(entries.map((e, i) => [toHex(entryId(e)), secretOf(i + 1)]));
const shownEntries = () => new Map(entries.map((e) => [toHex(entryId(e)), e]));
// A STAND-IN FOR THE STOCK CLIENT'S HASH: everything the real one covers (settle in the stake-lock tool), in order
const txidOf = (b) => sha256(new TextEncoder().encode(JSON.stringify({ c: b.claims.map((c) => [toHex(c.outpoint.txid), String(c.outpoint.outIdx), toHex(c.preimage), String(c.amountMsat)]),
  p: b.payouts.map((x) => [toHex(x.payoutPk), String(x.msat), x.sent || null]), n: toHex(b.nonce) })));
const rebuilt = (t) => { const b = tableBuild({ table: decodeSettlementTable(encodeSettlementTable(t)), entries: shownEntries(), preimages: preimages(), pointOf }); assert.equal(b.ok, true, b.why); return txidOf(b.build); };
const ackBy = (seat, table, txid = TXID) => signSettlementAck({ roundId: table.roundId, payoutTableId: settlementTableId(table), settlementTxid: txid }, seat.pubkey, (d) => schnorr.sign(d, seat.secret));
const ask = (t, over = {}) => {
  const signedAck = ackBy(NODE, t);
  const { ack } = splitSignedAck(signedAck);
  return slashHoldsOnTable({
    proof: { roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE.pubkey, transcriptHash: ack.payoutTableId, signedResultId: settlementAckId(ack), bondTxid: BOND, bondVout: 3 },
    signedAck, acks: seats.slice(1, 5).map((s) => ackBy(s, t)), table: encodeSettlementTable(t), finals: finals(), contract, advert, committee, verify, ...over,
  });
};
const askWhole = (t, txid, over = {}) => {
  const signedAck = ackBy(NODE, t, txid);
  const { ack } = splitSignedAck(signedAck);
  return slashHoldsOnTable({ proof: { roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE.pubkey, transcriptHash: ack.payoutTableId, signedResultId: settlementAckId(ack), bondTxid: BOND, bondVout: 3 },
    signedAck, acks: seats.slice(1, 5).map((s) => ackBy(s, t, txid)), table: encodeSettlementTable(t), finals: [], entries, contract, advert, committee, verify, rebuiltTxid: rebuilt(t), feesOf: () => FEES, ...over });
};
const shaved = () => tableOf(honestRows().map((r) => (r.amountMsat > 0n ? { ...r, amountMsat: r.amountMsat - 1n } : r)));
import { resultId } from '../src/result.js';
import { fraudProofHash, readEvidence, encodeFraudProof, decodeFraudProof } from '../src/slash.js';
import { encodeRoundContract } from '../src/contracts.js';
import {
  joinNamedClaimEvidence, splitNamedClaimEvidence, slashHoldsOnNamedClaim, namedClaimProofBody, claimReadInput, NAMED_ROW_OFF_TABLE, NAMED_ROW_FORFEIT,
} from '../src/named-claim-proof.js';
import { OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from '../src/named-claim-offence.js';

const SPEND = 'dd'.repeat(32);
const REBUILT = 'bb'.repeat(32);
const OTHER_BODY = 'cc'.repeat(32);
const xhex = (s) => toHex(s.pubkey);
const op = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
const sessions = { config: Uint8Array.from([1, 2, 3]), firstSession: 3, sessions: [Uint8Array.from([4]), Uint8Array.from([5, 6])] };
const lock = { round_id: toHex(ROUND) };
const readOf = (spends, over = {}) => ({ mode: 'arena-claim-read', federation_id: toHex(TEST_FEDERATION_ID), first_session: 3, sessions: 2, unverified: [], spends, ...over });
// the accepted claim: every lock of the honest table, named by seats 1..5, its body id another than the correct table's
const claimSpends = (over = {}) => entries.map((e) => ({ session: 4, txid: SPEND, outpoint: op(e.stakeLockOutpoint), kind: 'claim', signers: [0, 1, 2, 3, 4],
  named_keys: seats.slice(0, 5).map(xhex), lock, body_id: OTHER_BODY, one_signer_set: true, ...over }));
const caseA = ({ table = tableOf(honestRows()), shownFinals = finals(), spends = claimSpends(), read = null, rebuiltBodyId = REBUILT, accused = NODE } = {}) => {
  const tbytes = encodeSettlementTable(table);
  const proof = namedClaimProofBody({ row: NAMED_ROW_OFF_TABLE, roundId: ROUND, accused: accused.pubkey, spendTxid: SPEND, tableId: settlementTableId(table), advert });
  const record = joinNamedClaimEvidence(encodeSlashProof(proof), { row: NAMED_ROW_OFF_TABLE, ...sessions, table: tbytes, entries, preimages: [], finals: shownFinals });
  const got = splitNamedClaimEvidence(record);
  return { record, held: slashHoldsOnNamedClaim({ got, read: read || readOf(spends), contract, committee, advert: { ...advert, nodePubkey: accused.pubkey }, verify, feesOf: () => FEES, rebuiltBodyId }) };
};

test('the record is cut back to its parts, read as a named claim, and its bytes are the proof', () => {
  const { record } = caseA();
  const got = splitNamedClaimEvidence(record);
  assert.equal(got.row, NAMED_ROW_OFF_TABLE);
  assert.deepEqual([got.firstSession, got.sessions.map(toHex), toHex(got.config)], [3, ['04', '0506'], '010203']);
  assert.equal(got.entries.length, entries.length);
  assert.equal(readEvidence(record).kind, 'named');
  const complete = encodeFraudProof({ evidence: record, contract: encodeRoundContract(contract) });
  assert.equal(toHex(decodeFraudProof(complete).evidence), toHex(record));
  assert.equal(fraudProofHash(complete).length, 32);
  assert.throws(() => splitNamedClaimEvidence(Uint8Array.from([...record, 0])), /not a published proof of a named claim/);
  assert.deepEqual(claimReadInput({ ...sessions, roundId: ROUND }), { config: '010203', firstSession: 3, sessions: ['04', '0506'], roundId: toHex(ROUND) });
});

test('row (a): five seats\' claim off the correct table slashes each named signer; the rebuild itself, or a table not shown exactly F, slashes nobody', () => {
  const held = caseA().held;
  assert.equal(held.slashed, true, held.why);
  assert.equal(held.offence, OFF_TABLE_CLAIM);
  assert.equal(toHex(held.bond.txid), toHex(BOND));
  // THE CORRECT REBUILD IS NO OFFENCE, whoever signed it
  assert.match(caseA({ rebuiltBodyId: OTHER_BODY }).held.why, /is the rebuild of the correct table/);
  // claims naming different signer sets are false by themselves
  const mixed = claimSpends({ one_signer_set: false, body_id: null });
  assert.equal(caseA({ spends: mixed, rebuiltBodyId: OTHER_BODY }).held.slashed, true);
  // A TABLE NOT SHOWN CORRECT: one msat off F, or a row without its threshold of FINALs
  assert.match(caseA({ table: shaved() }).held.why, /not a correct table/);
  assert.match(caseA({ shownFinals: finals().slice(1) }).held.why, /not shown to be exactly F/);
  // the sessions must verify, be the proof's, and the accused must be named
  assert.match(caseA({ read: readOf(claimSpends(), { unverified: [4] }) }).held.why, /do not verify/);
  assert.match(caseA({ read: readOf(claimSpends(), { sessions: 1 }) }).held.why, /not the proof's/);
  assert.match(caseA({ read: readOf(claimSpends(), { federation_id: 'ee'.repeat(32) }) }).held.why, /the table settles in/);
  assert.match(caseA({ accused: seats[6] }).held.why, /not a named signer/);
  // a transaction that claims none of the table's locks (a late entry's own) is not read against it
  const elsewhere = claimSpends().map((x, i) => ({ ...x, outpoint: `${'ef'.repeat(32)}:${i}` }));
  assert.match(caseA({ spends: elsewhere }).held.why, /claims no lock the round's table claims/);
  assert.match(caseA({ rebuiltBodyId: null }).held.why, /not rebuilt/);
});

const lostBy = seats[1];
const signedResultOf = (i, by, over = {}) => {
  const body = resultOf(i, { nodePubkey: by.pubkey, ...over });
  return joinSignedResult(encodePlayerResult(body), schnorr.sign(resultId(body), by.secret));
};
const caseB = ({ i = 2, by = lostBy, signed = signedResultOf(i, by), spends = null, accused = by } = {}) => {
  const e = entries[i];
  const proof = namedClaimProofBody({ row: NAMED_ROW_FORFEIT, roundId: ROUND, accused: accused.pubkey, spendTxid: SPEND, entry: e, advert });
  const record = joinNamedClaimEvidence(encodeSlashProof(proof), { row: NAMED_ROW_FORFEIT, ...sessions, entry: e, signedResult: signed });
  const cancel = spends || [{ session: 4, txid: SPEND, outpoint: op(e.stakeLockOutpoint), kind: 'cancel', signers: [1, 2, 3, 4, 5], named_keys: seats.slice(1, 6).map(xhex), lock }];
  return slashHoldsOnNamedClaim({ got: splitNamedClaimEvidence(record), read: readOf(cancel), contract, committee, advert: { ...advert, nodePubkey: accused.pubkey }, verify });
};

test('row (b): a named signer of a forfeit of an entry it signed as lost is slashed; a qualifier\'s, a VOID, or another key\'s result slashes nobody', () => {
  const held = caseB();
  assert.equal(held.slashed, true, held.why);
  assert.equal(held.offence, FORFEIT_OF_LOST_ENTRY);
  assert.match(caseB({ i: 0 }).why, /signed that entry as a qualifier/);
  assert.match(caseB({ signed: signedResultOf(2, lostBy, { outcome: 'VOID', score: 0 }) }).why, /a VOID is not a lost result/);
  // the result's signature must be the accused's own
  const forged = joinSignedResult(encodePlayerResult(resultOf(2, { nodePubkey: lostBy.pubkey })), schnorr.sign(resultId(resultOf(2, { nodePubkey: lostBy.pubkey })), seats[2].secret));
  assert.match(caseB({ signed: forged }).why, /not the accused node's/);
  // a forfeit of another lock, or one not naming the accused
  const e = entries[2];
  assert.match(caseB({ spends: [{ txid: SPEND, outpoint: `${'ef'.repeat(32)}:0`, kind: 'cancel', named_keys: seats.slice(1, 6).map(xhex), lock }] }).why, /forfeits no lock of the entry/);
  assert.match(caseB({ spends: [{ txid: SPEND, outpoint: op(e.stakeLockOutpoint), kind: 'cancel', named_keys: seats.slice(2, 7).map(xhex), lock }] }).why, /forfeits no lock of the entry/);
  // the fee lock is the entry's lock too
  assert.equal(caseB({ spends: [{ txid: SPEND, outpoint: op(e.feeLockOutpoint), kind: 'cancel', named_keys: seats.slice(1, 6).map(xhex), lock }] }).slashed, true);
});
