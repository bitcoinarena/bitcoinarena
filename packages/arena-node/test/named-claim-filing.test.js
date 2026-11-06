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
import { splitNamedClaimEvidence, NAMED_ROW_OFF_TABLE, NAMED_ROW_FORFEIT, NAMED_ROW_PAYEE } from '../../arena-protocol/src/named-claim-proof.js';
import { readEvidence } from '../../arena-protocol/src/slash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { keepLockSessionFloor, forgetLockSearches } from '../src/stake-lock-signer-node.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
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

// `nobodyWon`: no entry qualifies (forfeit.js nobodyWonReturn); by default entry 1 DELIVERED above the minimum - a winner
function fakeRound({ floor = 3, nobodyWon = false } = {}) {
  const filed = [];
  return {
    filed,
    now: () => Date.now(),
    signerNodes: () => committee,
    settlementState: () => 'ACCEPTED',
    lockSettlementShares: () => (nobodyWon ? [] : [{ pubkey: E[0].playerPubkey, msat: 98000n }]),
    entryVoid: () => null,
    resultOf: (eid) => (!nobodyWon && toHex(eid) === toHex(EID[0]) ? { outcome: 'DELIVERED', score: 1000 } : { outcome: 'FAILED', score: 0 }),
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
    namedClaimProofs: () => filed.map((f) => ({ nodePubkey: Buffer.from(f.who, 'hex'), row: f.row, bytes: f.bytes })),
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
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false, why: 'not opened here' }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(asked.map((a) => a[0]), ['count', 'export', 'read']);
  assert.equal(asked[1][1], 3, 'the sessions are read from the round\'s funding floor');
  assert.deepEqual(asked[2][1], { config: '09', firstSession: 3, sessions: ['01', '02', '03'], roundId: toHex(RID) });
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
    const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([], spends), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
    await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
    assert.deepEqual(round.filed, []);
  }
  const asked = [];
  const none = fakeRound({ floor: null });
  const s = new LockSettlement(none, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual([none.filed.length, asked.length], [0, 0]);
  assert.match(report.refused.join('; '), /no funding-session floor kept/);
});

test('the funding floor is the federation\'s session count when the round comes in, kept once', async () => {
  const kept = new Map();
  const asked = [];
  const round = { keepFundingSessionFloor: (rid, fid, n) => { if (!kept.has(fid)) kept.set(fid, n); }, fundingSessionFloor: (rid, fid) => (kept.has(fid) ? kept.get(fid) : null) };
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort(asked), curve, stakeSecrets: {}, fetcher: async () => ({ ok: true }) });
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
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([]), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  const filedB = round.filed.find((f) => f.row === NAMED_ROW_FORFEIT && f.who === xhex(seats[1]));
  const complete = encodeFraudProof({ evidence: filedB.bytes, contract: encodeRoundContract(contract) });
  const census = { ok: true, entries: seats.map((x, i) => ({ pubkey: x.pubkey, txid: b32(0x90 + i), vout: i, advert: {} })) };
  const reads = [];
  const judgeWith = (claimRead, lostForfeitOf = () => ({ allowed: false })) => createProofJudge({ committeeOf: () => ({ ok: true, committee }), censusOf: () => census, coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => null,
    claimRead, lostForfeitOf });
  const held = await judgeWith(async (input) => { reads.push(input); return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends: SPENDS }; })(complete);
  assert.equal(held.verdict, true, held.why);
  assert.equal(reads[0].roundId, toHex(RID));
  const cannot = await judgeWith(async () => null)(complete);
  assert.equal(cannot.verdict, undefined);
  // the same proof over sessions that do not verify is false
  const forged = await judgeWith(async (input) => ({ mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [3], spends: SPENDS }))(complete);
  assert.equal(forged.verdict, false);
});

// ---- ruling #1139 B: the bound is the lock's own funding session, found when the lock is verified; the filer never searches

// a federation whose lock (txid 0x31.., index 0) was funded in session `fundedIn`, `count` sessions finished; `finishLater` sessions finish one per count read
function fundingPort({ fundedIn, count, asked, finishLater = 0 }) {
  let finished = count;
  return {
    sessionCount: async () => { asked.push(['count']); const c = finished; if (finishLater > 0) { finished += 1; finishLater -= 1; } return c; },
    sessionExport: async ({ from }) => { asked.push(['export', from]); return { federationId: FID, config: Uint8Array.from([9]), firstSession: from, sessions: Array.from({ length: Math.max(0, finished - from) }, () => Uint8Array.from([1])) }; },
    arenaClaimRead: async (input) => {
      const last = input.firstSession + input.sessions.length;
      const fundings = fundedIn >= input.firstSession && fundedIn < last ? [{ session: fundedIn, outpoint: op(E[0].stakeLockOutpoint), round_id: toHex(RID) }] : [];
      return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends: [], fundings };
    },
  };
}
const noSleep = async () => {};

test('a verified lock reads back, doubling, to its own funding session and keeps it as the bound, across a restart, the lower one standing', async () => {
  const db = openStore(':memory:');
  const round = new Round(db);
  const asked = [];
  // funded 41 sessions back: nothing read until the session running at verification (100) finished, then 8, 16, 32, 64 back from 101
  forgetLockSearches();
  const got = await keepLockSessionFloor({ round, port: fundingPort({ fundedIn: 60, count: 100, asked, finishLater: 1 }), roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 });
  assert.equal(got, 60);
  assert.deepEqual(asked.filter((a) => a[0] === 'export').map((a) => a[1]), [93, 85, 69, 37]);
  assert.deepEqual(asked.slice(0, 3).map((a) => a[0]), ['count', 'count', 'export'], 'no read before a session after the verification finished');
  assert.equal(new Round(db).fundingSessionFloor(RID, FID), 60, 'the bound is the funding session, and it survives a restart');
  // a later lock funded higher leaves the lower bound; one funded lower moves it down
  forgetLockSearches();
  await keepLockSessionFloor({ round, port: fundingPort({ fundedIn: 99, count: 100, asked: [], finishLater: 1 }), roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 });
  assert.equal(round.fundingSessionFloor(RID, FID), 60);
  round.keepFundingSessionFloor(RID, FID, 4);
  assert.equal(round.fundingSessionFloor(RID, FID), 4);
});

test('a funding in the session still running is found when it finishes; one not within 1024 sessions, or a session that never finishes, leaves the lock unread', async () => {
  const round = new Round(openStore(':memory:'));
  const asked = [];
  // the funding sits in session 100, the one running at verification
  forgetLockSearches();
  const got = await keepLockSessionFloor({ round, port: fundingPort({ fundedIn: 100, count: 100, asked, finishLater: 1 }), roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 });
  assert.equal(got, 100);
  assert.equal(round.fundingSessionFloor(RID, FID), 100);
  // funded 2000 sessions back: no farther than 1024, nothing kept, logged
  const round2 = new Round(openStore(':memory:'));
  const said = [], asked2 = [];
  forgetLockSearches();
  const none = await keepLockSessionFloor({ round: round2, port: fundingPort({ fundedIn: 1000, count: 3000, asked: asked2, finishLater: 1 }), roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0, log: (l) => said.push(l) });
  assert.equal(none, null);
  assert.equal(round2.fundingSessionFloor(RID, FID), null);
  assert.equal(Math.min(...asked2.filter((a) => a[0] === 'export').map((a) => a[1])), 3001 - 1024);
  assert.match(said.join('\n'), /not within 1024 sessions.*unread/);
  // the running session never finishes within maxWaitMs: nothing read, nothing kept, logged
  let t = 0;
  const stuck = [];
  forgetLockSearches();
  assert.equal(await keepLockSessionFloor({ round: round2, port: fundingPort({ fundedIn: 5, count: 5, asked: stuck }), roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint,
    sleep: async (ms) => { t += ms; }, now: () => t, countKeepMs: 0, waitMs: 1000, maxWaitMs: 5000, log: (l) => said.push(l) }), null);
  assert.equal(stuck.filter((a) => a[0] === 'export').length, 0);
  assert.match(said.join('\n'), /no session of federation .* finished after 5 within 0 min/);
  // a federation that cannot be read keeps nothing and fails nothing
  forgetLockSearches();
  assert.equal(await keepLockSessionFloor({ round: round2, port: { ...fundingPort({ fundedIn: 1, count: 3, asked: [] }), sessionCount: async () => { throw new Error('down'); } }, roundId: RID, federationId: b32(0x77), outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 }), null);
});

test('the filer reads from the bound once and never searches; a lock funded below it is unread, not filed', async () => {
  const asked = [];
  const reads = [];
  const port = {
    sessionExport: async ({ from }) => { asked.push(from); return { federationId: FID, config: Uint8Array.from([9]), firstSession: from, sessions: [Uint8Array.from([1])] }; },
    arenaClaimRead: async (input) => {
      reads.push(input.firstSession);
      // funded at 20, below the bound 30: the reader names no keys for those spends
      return { mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: 1, unverified: [],
        spends: SPENDS.map((x) => ({ ...x, lock: null, named_keys: null, body_id: null })) };
    },
  };
  const round = fakeRound({ floor: 30 });
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port, curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(asked, [30], 'one read, from the bound');
  assert.equal(report.filed.length, 0);
  assert.match(report.refused.join('; '), /funded below the bound 30: unread/);
});

// ---- level 2 of row (a), who is paid (rulings #1138 2, #1140): every claim of the round, read against the payees the seat holds

test('a claim paying a key the round may not pay is filed at level 2 against each other named signer; an honest one, or no payees read, files nothing', async () => {
  const thief = '02' + 'ee'.repeat(32);
  const player = toHex(refundKeyOf(E[0].playerPubkey));
  const outputs = (to) => [{ out_idx: 0, kind: 'outgoing', claim_pk: to, refund_pk: to, amount_msat: 97000 }];
  // a claim of entry 2's stake lock under the body this seat acked (no level-1 offence), named by seats 1..5
  const claim = (to) => [{ session: 4, txid: THEFT, outpoint: op(E[1].stakeLockOutpoint), kind: 'claim', signers: [0, 1, 2, 3, 4], named_keys: seats.slice(0, 5).map(xhex),
    lock: { round_id: toHex(RID), amount_msat: 98000, refund_pk: toHex(refundKeyOf(E[1].playerPubkey)), payment_image: { point: '02' } }, body_id: ACKED_BODY, one_signer_set: true,
    agg_key: 'ab'.repeat(32), outputs: outputs(to) }];
  const payeesFor = async () => ({ nodeKeys: new Set(committee.map((k) => toHex(refundKeyOf(k)))), donationKeys: new Set(), reserveKeys: new Set() });
  const run = async (spends, opts = { payeesFor }) => {
    const round = fakeRound();
    const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([], spends), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }), ...opts });
    return { round, report: await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null }) };
  };
  const off = await run(claim(thief));
  assert.deepEqual(off.round.filed.map((f) => f.row), [NAMED_ROW_PAYEE, NAMED_ROW_PAYEE, NAMED_ROW_PAYEE, NAMED_ROW_PAYEE]);
  assert.deepEqual(off.round.filed.map((f) => f.who).sort(), seats.slice(1, 5).map(xhex).sort(), 'never this seat itself');
  for (const f of off.round.filed) {
    const got = splitNamedClaimEvidence(f.bytes);
    assert.equal(toHex(got.proof.signedResultId), THEFT);
    assert.equal(got.entries.length, 2, 'the proof carries the round\'s entries this seat holds');
  }
  assert.ok(off.report.filed.every((x) => x.row === 'a2'));
  assert.equal((await run(claim(player))).round.filed.length, 0, 'paying the qualifier is honest');
  const none = await run(claim(thief), {});
  assert.equal(none.round.filed.length, 0);
  assert.match(none.report.refused.join('; '), /no payees read for the round: level 2 not read/);
});

test('no session finished since the bound: nothing is exported (the tool refuses an empty range), and it is said', async () => {
  const asked = [];
  const round = fakeRound({ floor: 7 });
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(asked.map((a) => a[0]), ['count']);
  assert.equal(round.filed.length, 0);
  assert.match(report.refused.join('; '), /no session finished since the bound 7 yet/);
});

// ---- the MacBook load of 2026-11-05 (150): a lock verified again and again started a read-back each time, and every filer pass re-exported every round

test('a lock is searched once: a second verification of it reads nothing, and searches of several locks export one after another', async () => {
  forgetLockSearches();
  const round = new Round(openStore(':memory:'));
  const asked = [];
  const port = fundingPort({ fundedIn: 98, count: 100, asked, finishLater: 1 });
  assert.equal(await keepLockSessionFloor({ round, port, roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 }), 98);
  const before = asked.length;
  assert.equal(await keepLockSessionFloor({ round, port, roundId: RID, federationId: TEST_FEDERATION_ID, outpoint: E[0].stakeLockOutpoint, sleep: noSleep, countKeepMs: 0 }), null);
  assert.equal(asked.length, before, 'no count, no export for a lock already searched');
  // two locks at once: never two exports running together
  let running = 0, most = 0;
  const slow = { ...fundingPort({ fundedIn: 40, count: 100, asked: [], finishLater: 2 }) };
  const exp = slow.sessionExport;
  slow.sessionExport = async (a) => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 5)); try { return await exp(a); } finally { running -= 1; } };
  await Promise.all([E[0].feeLockOutpoint, E[1].stakeLockOutpoint].map((outpoint) => keepLockSessionFloor({ round, port: slow, roundId: RID, federationId: TEST_FEDERATION_ID, outpoint, sleep: noSleep, countKeepMs: 0 })));
  assert.equal(most, 1);
});

test('a filer pass with no session finished since its last read of the round exports nothing', async () => {
  const asked = [];
  const round = fakeRound();
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort(asked), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.equal(asked.filter((a) => a[0] === 'export').length, 1);
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.equal(asked.filter((a) => a[0] === 'export').length, 1, 'the second pass reads the count only');
  assert.match(report.refused.join('; '), /no session finished since the last read \(7\)/);
});

test('the searches of several locks share one session count of their federation, and one export of each range', async () => {
  forgetLockSearches();
  const round = new Round(openStore(':memory:'));
  const asked = [];
  let t = 0;
  const locks = [E[0].stakeLockOutpoint, E[0].feeLockOutpoint, E[1].stakeLockOutpoint, E[1].feeLockOutpoint];
  const base = fundingPort({ fundedIn: 98, count: 100, asked, finishLater: 1 });
  // all four funded in session 98
  const port = { ...base, arenaClaimRead: async (input) => { const r = await base.arenaClaimRead(input); return { ...r, fundings: r.fundings.length ? locks.map((o) => ({ session: 98, outpoint: op(o), round_id: toHex(RID) })) : [] }; } };
  await Promise.all(locks.map((outpoint) => keepLockSessionFloor({ round, port, roundId: RID, federationId: TEST_FEDERATION_ID, outpoint, now: () => t, sleep: async (ms) => { t += ms; } })));
  // one count at the start for all four, and one after the wait (20 s > the 15 s it is kept)
  assert.ok(asked.filter((a) => a[0] === 'count').length <= 2, `${asked.filter((a) => a[0] === 'count').length} counts`);
  // and one export of the range for all four (each funded in session 98, read from 93 = 101 - 8)
  assert.deepEqual(asked.filter((a) => a[0] === 'export').map((a) => a[1]), [93]);
});

test('a filer read and a funding search of the same seat never run their tool at the same time', async () => {
  forgetLockSearches();
  let running = 0, most = 0;
  const slow = (port) => ({ ...port, sessionExport: async (a) => { running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 10)); try { return await port.sessionExport(a); } finally { running -= 1; } } });
  const round = fakeRound();
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: slow(fakePort([])), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  await Promise.all([
    s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null }),
    keepLockSessionFloor({ round: new Round(openStore(':memory:')), port: slow(fundingPort({ fundedIn: 40, count: 100, asked: [], finishLater: 1 })), roundId: RID, federationId: TEST_FEDERATION_ID,
      outpoint: E[1].feeLockOutpoint, sleep: noSleep, countKeepMs: 0 }),
  ]);
  assert.equal(most, 1);
});

test('a level-1 proof (a) is judged: its correct body is rebuilt offline from the proof\'s own sessions, never through the guardians the claim spent', async () => {
  const { createProofJudge } = await import('../src/proof-judge.js');
  const { encodeFraudProof, encodeSlashProof } = await import('../../arena-protocol/src/slash.js');
  const { joinNamedClaimEvidence, namedClaimProofBody } = await import('../../arena-protocol/src/named-claim-proof.js');
  // A TABLE THAT BUILDS: both entries' fee locks claimed (F is in each Entry Contract), one payout; the claim at THEFT spent them under another body
  const table = { roundId: RID, rows: [], nonce: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    claims: E.map((e, i) => ({ entryId: EID[i], outpoint: e.feeLockOutpoint, amountMsat: e.feeMsat, kind: 'fee' })), payouts: [{ payoutPk: Uint8Array.from([2, ...b32(0x66)]), msat: 1000n }] };
  const accused = seats[1];
  const proof = namedClaimProofBody({ row: NAMED_ROW_OFF_TABLE, roundId: RID, accused: accused.pubkey, spendTxid: THEFT, tableId: settlementTableId(table), advert: adverts.get(xhex(accused)) });
  const record = joinNamedClaimEvidence(encodeSlashProof(proof), { row: NAMED_ROW_OFF_TABLE, config: Uint8Array.from([9]), firstSession: 3, sessions: [Uint8Array.from([1]), Uint8Array.from([2])],
    table: encodeSettlementTable(table), entries: E, preimages: [], finals: [] });
  const complete = encodeFraudProof({ evidence: record, contract: encodeRoundContract(contract) });
  const census = { ok: true, entries: seats.map((x, i) => ({ pubkey: x.pubkey, txid: b32(0x90 + i), vout: i, advert: {} })) };
  const spends = E.map((e) => ({ ...SPENDS[0], outpoint: op(e.feeLockOutpoint) }));
  let guardianRuns = 0;
  const judgeWith = (bodyOf) => createProofJudge({ committeeOf: () => ({ ok: true, committee }), censusOf: () => census, coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => null,
    manifestOf: () => ({}), clientOf: async () => ({ fees: async () => ({ ppm: 0n, baseMsat: 0n }), bodyId: async () => { guardianRuns += 1; throw new Error('the guardians hold no Arena lock'); } }),
    claimRead: async (input) => ({ mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends }), bodyOf });
  const bodies = [];
  const said = await judgeWith(async (input, build) => { bodies.push({ input, build }); return { ok: true, bodyId: ACKED_BODY }; })(complete);
  // THE REBUILD RAN, OFFLINE: the proof's own config and sessions, the table's claims with each F, its payouts and nonce; the guardians were never asked
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].input, { config: '09', firstSession: 3, sessions: ['01', '02'] });
  assert.deepEqual(bodies[0].build.claims.map((c) => [op(c.outpoint), toHex(c.preimage)]), E.map((e) => [op(e.feeLockOutpoint), toHex(e.feePreimage)]));
  assert.deepEqual([bodies[0].build.payouts.length, toHex(bodies[0].build.nonce)], [1, '0102030405060708']);
  assert.equal(guardianRuns, 0);
  // a seat that can say: this table shows no FINALs, so the bytes do not slash - a verdict, not "cannot say"
  assert.equal(said.verdict, false);
  assert.doesNotMatch(said.why, /rebuilt offline|cannot do yet/);
});

test('the same offence is filed once, though a later pass reads one session more', async () => {
  const round = fakeRound();
  let count = 7;
  const port = { ...fakePort([]), sessionCount: async () => count };
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port, curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  const first = round.filed.length;
  assert.ok(first > 0);
  count = 8;
  const again = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.equal(round.filed.length, first, 'nothing new is kept');
  assert.equal(again.filed.length, 0);
});

// ---- kanban #1044 (measured 2026-11-05 on s28a, round b94a4863): a forfeit the protocol allows is no offence (b) ----
// every result FINAL, entry 2's FAILED (finality.js reads a whole store; this round is a fake)
const FINALITY = { finalityOf: (r) => ({ state: r.notFinal ? 'PROVISIONALLY_FINAL' : 'FINAL' }), settledOf: (r, _rid, eid) => r.resultOf(eid) };

test('an honest nobody-won round files no row (b): the stake forfeited back to its player is the nobody-won return', async () => {
  const { lostForfeitAllowed } = await import('../src/forfeit.js');
  const round = fakeRound({ nobodyWon: true });
  const said = lostForfeitAllowed(round, RID, EID[1], FINALITY);
  assert.equal(said.allowed, true, said.why);
  assert.match(said.why, /nobody won/);
  const s = new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([]), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) });
  const report = await s.fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(round.filed.filter((f) => f.row === NAMED_ROW_FORFEIT), []);
  assert.match(report.refused.join('; '), /allowed - nobody won/);
  // a round with an entry not final yet files none either: it is read again on a later pass
  const early = fakeRound();
  early.notFinal = true;
  await new LockSettlement(early, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([]), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) }).fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  assert.deepEqual(early.filed.filter((f) => f.row === NAMED_ROW_FORFEIT), []);
  // an ENTRY_VOID entry's refund is allowed too; a winner paid is not, and its walk-away's forfeit never is
  assert.equal(lostForfeitAllowed({ ...fakeRound(), entryVoid: () => ({ learned: 'own' }) }, RID, EID[1], FINALITY).allowed, true);
  assert.equal(lostForfeitAllowed(fakeRound(), RID, EID[1], FINALITY).allowed, false);
  assert.equal(lostForfeitAllowed(fakeRound({ nobodyWon: true }), RID, EID[1], { finalityOf: () => ({ state: 'FINAL' }), settledOf: () => ({ outcome: 'FORFEIT', score: 0 }) }).allowed, false, 'a walk-away is never a refund');
  // and the reading needs no settlement: a forfeit that took a loser's lock leaves it unbuildable (s29a round b0bfe1be), the winner is in the results
  assert.equal(lostForfeitAllowed({ ...fakeRound(), settlementState: () => 'NONE', lockSettlementShares: () => null }, RID, EID[1], FINALITY).allowed, false);
});

test('a proof of a nobody-won return is judged false, and one the judge cannot read yet is "cannot say" - never a slash', async () => {
  const { createProofJudge } = await import('../src/proof-judge.js');
  const { encodeFraudProof } = await import('../../arena-protocol/src/slash.js');
  const { lostForfeitAllowed } = await import('../src/forfeit.js');
  const round = fakeRound();
  await new LockSettlement(round, { finalityOf: (...a) => FINALITY.finalityOf(...a), settledOf: (...a) => FINALITY.settledOf(...a), port: fakePort([]), curve, stakeSecrets: { open: async () => ({ ok: false }) }, fetcher: async () => ({ ok: true }) }).fileNamedClaimProofs(RID, { advertOf: (k) => adverts.get(k) || null });
  const filedB = round.filed.find((f) => f.row === NAMED_ROW_FORFEIT && f.who === xhex(seats[1]));
  const complete = encodeFraudProof({ evidence: filedB.bytes, contract: encodeRoundContract(contract) });
  const census = { ok: true, entries: seats.map((x, i) => ({ pubkey: x.pubkey, txid: b32(0x90 + i), vout: i, advert: {} })) };
  const judgeOn = (held) => createProofJudge({ committeeOf: () => ({ ok: true, committee }), censusOf: () => census, coreOf: () => null, beaconOf: () => ({ ok: false }), replayRunOf: () => null,
    claimRead: async (input) => ({ mode: 'arena-claim-read', federation_id: FID, first_session: input.firstSession, sessions: input.sessions.length, unverified: [], spends: SPENDS }),
    lostForfeitOf: (_c, rid, eid) => lostForfeitAllowed(held, rid, eid, FINALITY) });
  const nobody = await judgeOn(fakeRound({ nobodyWon: true }))(complete);
  assert.equal(nobody.verdict, false);
  assert.match(nobody.why, /the protocol allows: nobody won/);
  const unsettled = fakeRound();
  unsettled.notFinal = true;
  assert.equal((await judgeOn(unsettled)(complete)).verdict, undefined);
  // a winner by the results, the settlement never built (the forfeit took a loser's lock): held, as before the fix
  assert.equal((await judgeOn({ ...fakeRound(), settlementState: () => 'NONE', lockSettlementShares: () => null })(complete)).verdict, true);
  assert.equal((await judgeOn(fakeRound())(complete)).verdict, true);
});
