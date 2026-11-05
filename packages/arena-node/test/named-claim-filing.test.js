// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT FILES A NAMED CLAIM'S OFFENCE (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1, rulings #1131 4, #1135 2). The seat reads its federation's
// signed sessions from the round's funding floor (session-export) and has the stake-lock tool read them offline (arena-claim-read); a claim of a lock
// its own acked body claims, under another body, is filed against each named signer but itself (row a); a forfeit of a lock whose entry a named signer
// signed as lost is filed against that signer (row b). The federation here is the tool's answers as it prints them; the round store is held in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { encodeRoundContract, roundId as roundIdOf, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeSettlementTable, settlementTableId } from '../../arena-protocol/src/settlement-ack.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { splitNamedClaimEvidence, NAMED_ROW_OFF_TABLE, NAMED_ROW_FORFEIT } from '../../arena-protocol/src/named-claim-proof.js';
import { readEvidence } from '../../arena-protocol/src/slash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { keepLockSessionFloor } from '../src/stake-lock-signer-node.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(0x40 + n); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const committee = seats.map((s) => s.pubkey);
const contract = {
  protocolVersion: 27, networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID,
  simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 600, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 100, rankNumerator: 3, rankDenominator: 4, nodes: committee,
};
const RID = roundIdOf(contract);
const FID = toHex(TEST_FEDERATION_ID);
const entryOf = (n) => ({
  roundId: RID, playerPubkey: b32(0xa0 + n), sessionPubkey: b32(0x0b), stakeCommitment: b32(0x0c), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(n), vssSharesRef: new Uint8Array(32), stakePoint: secp256k1.getPublicKey(b32(0x10 + n), true), feePreimage: b32(0x20 + n),
  stakeLockOutpoint: { txid: b32(0x30 + n), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x30 + n), outIdx: 1n }, claimKeyAttestationRef: new Uint8Array(32),
});
const E = [entryOf(1), entryOf(2)];
const EID = E.map((e) => entryId(e));
const op = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
// THE BODY THIS SEAT ACKED: claims of both entries' stake locks
const TABLE = { roundId: RID, rows: [], claims: E.map((e, i) => ({ entryId: EID[i], outpoint: e.stakeLockOutpoint, amountMsat: 98000n, kind: 'stake' })), payouts: [] };
const ACKED_BODY = 'aa'.repeat(32);
const OFF_BODY = 'cc'.repeat(32);
const THEFT = 'dd'.repeat(32);
const FORFEIT_TX = 'ee'.repeat(32);
// seat 2 signed entry 2 FAILED; seat 3 signed it DELIVERED below the floor: both lost
const lostResult = (seat, score = 0, outcome = 'FAILED') => {
  const body = { roundId: RID, playerPubkey: E[1].playerPubkey, outcome, score, transcriptHash: b32(0x44), simCoreHash: b32(1), nodePubkey: seat.pubkey };
  return joinSignedResult(encodePlayerResult(body), schnorr.sign(resultId(body), seat.secret));
};

function fakeRound({ floor = 3 } = {}) {
  const filed = [];
  return {
    filed,
    pubkey: seats[0].pubkey,
    plugins: [],
    get: (rid) => (toHex(rid) === toHex(RID) ? { contract: encodeRoundContract(contract) } : null),
    settlementAcksOf: () => [{ scope: '', txid: ACKED_BODY, tableId: settlementTableId(TABLE), table: encodeSettlementTable(TABLE), acks: new Uint8Array(0) }],
    entriesOf: () => E.map((entry, i) => ({ entryId: EID[i], entry })),
    results: (_rid, eid) => (toHex(eid) === toHex(EID[1]) ? [{ nodePubkey: seats[1].pubkey, bytes: lostResult(seats[1]) }, { nodePubkey: seats[2].pubkey, bytes: lostResult(seats[2], 5, 'DELIVERED') }] : []),
    entryFinalSigs: () => [],
    fundingSessionFloor: (rid, fid) => (floor !== null && fid === FID ? floor : null),
    fraudProof: (_rid, _eid, evidence) => { const bytes = Uint8Array.from([0x43, ...evidence]); return { id: sha256(bytes), bytes }; },
    fileNamedClaimProof: (rid, who, row, id, bytes) => { filed.push({ who: toHex(who), row, id: toHex(id), bytes }); return 1; },
  };
}
const xhex = (s) => toHex(s.pubkey);
const SPENDS = [
  // the claim off the acked body: seats 1..5 named, seat 1 (this seat) among them
  ...E.map((e) => ({ session: 4, txid: THEFT, outpoint: op(e.stakeLockOutpoint), kind: 'claim', signers: [0, 1, 2, 3, 4], named_keys: seats.slice(0, 5).map(xhex),
    lock: { round_id: toHex(RID) }, body_id: OFF_BODY, one_signer_set: true })),
  // the forfeit of entry 2's fee lock by seats 2..6
  { session: 5, txid: FORFEIT_TX, outpoint: op(E[1].feeLockOutpoint), kind: 'cancel', signers: [1, 2, 3, 4, 5], named_keys: seats.slice(1, 6).map(xhex), lock: { round_id: toHex(RID) } },
];
function fakePort(asked, spends = SPENDS) {
  return {
    sessionExport: async ({ from }) => { asked.push(['export', from]); return { federationId: FID, config: Uint8Array.from([9]), firstSession: from, sessions: [Uint8Array.from([1]), Uint8Array.from([2]), Uint8Array.from([3])] }; },
    arenaClaimRead: async (input) => { asked.push(['read', input]); return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends }; },
    sessionCount: async () => { asked.push(['count']); return 7; },
  };
}
const adverts = new Map(seats.map((s, i) => [xhex(s), { nodePubkey: s.pubkey, bondTxid: b32(0x90 + i), bondVout: i }]));

test('a seat files row (a) against each other named signer of a claim off its acked body, and row (b) against a named signer of a forfeit of an entry it signed lost', async () => {
  const asked = [];
  const round = fakeRound();
  const s = new LockSettlement(round, { port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false, why: 'not opened here' }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(asked.map((a) => a[0]), ['export', 'read']);
  assert.equal(asked[0][1], 3, 'the sessions are read from the round\'s funding floor');
  assert.deepEqual(asked[1][1], { config: '09', firstSession: 3, sessions: ['01', '02', '03'], roundId: toHex(RID) });
  const a = round.filed.filter((f) => f.row === NAMED_ROW_OFF_TABLE).map((f) => f.who).sort();
  const b = round.filed.filter((f) => f.row === NAMED_ROW_FORFEIT).map((f) => f.who).sort();
  // (a): seats 2..5 - never this seat itself; (b): seats 2 and 3 signed entry 2 lost and are named on its forfeit, seat 4..6 signed nothing of it
  assert.deepEqual(a, seats.slice(1, 5).map(xhex).sort());
  assert.deepEqual(b, [xhex(seats[1]), xhex(seats[2])].sort());
  assert.equal(report.filed.length, 6);
  // each record is a named claim's proof naming the spend, the accused and the bond it advertised
  for (const f of round.filed) {
    const got = splitNamedClaimEvidence(f.bytes);
    assert.equal(readEvidence(f.bytes).kind, 'named');
    assert.equal(toHex(got.proof.nodePubkey), f.who);
    assert.equal(toHex(got.proof.signedResultId), f.row === NAMED_ROW_OFF_TABLE ? THEFT : FORFEIT_TX);
    assert.equal(toHex(got.proof.bondTxid), toHex(adverts.get(f.who).bondTxid));
    assert.deepEqual([got.firstSession, got.sessions.length, toHex(got.config)], [3, 3, '09']);
    if (f.row === NAMED_ROW_OFF_TABLE) assert.equal(toHex(got.proof.transcriptHash), toHex(settlementTableId(TABLE)));
    else { assert.equal(toHex(got.proof.transcriptHash), toHex(EID[1])); assert.equal(toHex(got.proof.playerPubkey), toHex(E[1].playerPubkey)); }
  }
});

test('the rebuild of its own acked body, a claim of locks it never claimed, or a round with no funding floor files nothing', async () => {
  const honest = SPENDS.slice(0, 2).map((x) => ({ ...x, body_id: ACKED_BODY }));
  const elsewhere = SPENDS.slice(0, 2).map((x, i) => ({ ...x, outpoint: `${'ef'.repeat(32)}:${i}` }));
  for (const spends of [honest, elsewhere]) {
    const round = fakeRound();
    const s = new LockSettlement(round, { port: fakePort([], spends), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
    await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
    assert.deepEqual(round.filed, []);
  }
  const asked = [];
  const none = fakeRound({ floor: null });
  const s = new LockSettlement(none, { port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual([none.filed.length, asked.length], [0, 0]);
  assert.match(report.refused.join('; '), /no funding-session floor kept/);
});

test('the funding floor is the federation\'s session count when the round comes in, kept once', async () => {
  const kept = new Map();
  const asked = [];
  const round = { keepFundingSessionFloor: (rid, fid, n) => { if (!kept.has(fid)) kept.set(fid, n); }, fundingSessionFloor: (rid, fid) => (kept.has(fid) ? kept.get(fid) : null) };
  const s = new LockSettlement(round, { port: fakePort(asked), curve, stakeSecrets: {}, fetcher: async () => ({ ok: true }) });
  assert.deepEqual(await s.noteFundingFloor(RID, contract), [FID]);
  assert.deepEqual(await s.noteFundingFloor(RID, contract), []);
  assert.deepEqual([kept.get(FID), asked.filter((a) => a[0] === 'count').length], [7, 1]);
  // a round below protocol 27 keeps none
  assert.deepEqual(await s.noteFundingFloor(RID, { ...contract, protocolVersion: 26 }), []);
});

test('a seat\'s judge holds a filed row (b) on its own reading of the proof\'s sessions, and cannot say without a claim reader', async () => {
  const { createProofJudge } = await import('../src/proof-judge.js');
  const { encodeFraudProof } = await import('../../arena-protocol/src/slash.js');
  const round = fakeRound();
  const s = new LockSettlement(round, { port: fakePort([]), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  const filedB = round.filed.find((f) => f.row === NAMED_ROW_FORFEIT && f.who === xhex(seats[1]));
  const complete = encodeFraudProof({ evidence: filedB.bytes, contract: encodeRoundContract(contract) });
  const census = { ok: true, entries: seats.map((x, i) => ({ pubkey: x.pubkey, txid: b32(0x90 + i), vout: i, advert: {} })) };
  const reads = [];
  const judgeWith = (claimRead) => createProofJudge({ committeeOf: () => ({ ok: true, committee }), censusOf: () => census, coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => null,
    claimRead });
  const held = await judgeWith(async (input) => { reads.push(input); return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends: SPENDS }; })(complete);
  assert.equal(held.verdict, true, held.why);
  assert.equal(reads[0].roundId, toHex(RID));
  const cannot = await judgeWith(async () => null)(complete);
  assert.equal(cannot.verdict, undefined);
  // the same proof over sessions that do not verify is false
  const forged = await judgeWith(async (input) => ({ mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [3], spends: SPENDS }))(complete);
  assert.equal(forged.verdict, false);
});

// ---- ruling #1138 1 (i): the bound kept at the first verified lock, once per federation, the lower of it and POST /round's

test('the first verified lock of a round in a federation keeps that federation\'s session count as the bound, once, across a restart, the lower one standing', async () => {
  const db = openStore(':memory:');
  const round = new Round(db);
  const asked = [];
  const port = fakePort(asked);
  assert.equal(await keepLockSessionFloor({ round, port, roundId: RID, federationId: TEST_FEDERATION_ID }), 7);
  assert.equal(await keepLockSessionFloor({ round, port, roundId: RID, federationId: TEST_FEDERATION_ID }), null, 'a second lock reads no count');
  assert.equal(asked.filter((a) => a[0] === 'count').length, 1);
  assert.equal(new Round(db).fundingSessionFloor(RID, FID), 7, 'the bound survives a restart');
  // a second federation of the same round keeps its own
  const other = 'ab'.repeat(32);
  await keepLockSessionFloor({ round, port: { sessionCount: async () => 11 }, roundId: RID, federationId: Buffer.from(other, 'hex') });
  assert.equal(round.fundingSessionFloor(RID, other), 11);
  // the lower of two readings stands, whichever came first
  round.keepFundingSessionFloor(RID, FID, 9);
  assert.equal(round.fundingSessionFloor(RID, FID), 7);
  round.keepFundingSessionFloor(RID, FID, 4);
  assert.equal(round.fundingSessionFloor(RID, FID), 4);
  // a federation whose count cannot be read keeps nothing and fails nothing
  assert.equal(await keepLockSessionFloor({ round, port: { sessionCount: async () => { throw new Error('down'); } }, roundId: RID, federationId: b32(0x77) }), null);
  assert.equal(round.fundingSessionFloor(RID, toHex(b32(0x77))), null);
});

test('a lock funded below the bound kept at its verification is read back to its funding, and the claim is filed', async () => {
  // the claim's lock is funded in a session below the bound: the reader names no keys for it until the read reaches its funding
  const asked = [];
  const reads = [];
  const port = {
    sessionExport: async ({ from }) => { asked.push(from); return { federationId: FID, config: Uint8Array.from([9]), firstSession: from, sessions: [Uint8Array.from([1])] }; },
    arenaClaimRead: async (input) => {
      reads.push(input.firstSession);
      const funded = input.firstSession <= 20;
      return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: 1, unverified: [],
        spends: SPENDS.map((x) => ({ ...x, lock: funded ? x.lock : null, named_keys: funded ? x.named_keys : null, body_id: funded ? x.body_id : null })) };
    },
  };
  const round = fakeRound({ floor: 30 });
  const anyFed = { ...contract };
  const s = new LockSettlement({ ...round, get: () => ({ contract: encodeRoundContract(anyFed) }) }, { port, curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(asked, [30, 22, 14], 'the read reaches back, doubling, until the funding is in it');
  assert.equal(report.filed.length, 6, report.refused.join('; '));
  for (const f of round.filed) assert.equal(splitNamedClaimEvidence(f.bytes).firstSession, 14, 'the proof carries the sessions from the funding');
});
