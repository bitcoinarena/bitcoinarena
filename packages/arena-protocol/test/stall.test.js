// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STALLED NODES LEAVE THE DRAW (§5A.3 "Stalled in its rounds", protocol 26, kanban #1044 option 2, ruling #1052). Notes and certificates here are signed for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { toHex, fromHex } from '../src/hash.js';
import { STALL_VERSION, STALL_NOTE_QUORUM, STALL_PROOF_ROUNDS, STALL_WINDOW_MS, SUPPORTED_PROTOCOL_VERSIONS, CENSUS_KEY_VERSION, speaksVersion, ABSENCE_PROOF_SPACING_MS, stallSettlementPoint } from '../src/constants.js';
import { signSeatingBound, signSeen, seatingId, encodeSeatingCertificate } from '../src/seating.js';
import { signStallNote, decodeStallNote, verifyStallNote, stallNoteId, namedBy, silentSeats, stallsOut, stallWindow, stalledFrom, checkStallProof, stallCapKept, stallCloseMs, settlementNotesCount, stallNoteCounts, STALL_SETTLEMENT_HEIGHT, STALL_STAGE, STALL_HEIGHT } from '../src/stall.js';
import { signSettlementCommit, checkSettlementCommit, SIGNED_SETTLEMENT_COMMIT_BYTES } from '../src/settlement-ack.js';
import { withoutAbsent } from '../src/presence.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const key = (k) => schnorr.getPublicKey(b32(k));
const hex = (k) => toHex(key(k));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const signBy = (k) => (m) => schnorr.sign(m, b32(k));
const ROUND = (n) => { const b = b32(0); b[0] = 0xa0; b[1] = n & 255; b[2] = n >> 8; return b; };
const T = 1793800000000n;
const w = stallWindow(T);
const HOUR = 3600000n;
const contractAt = (over = {}) => ({ protocolVersion: STALL_VERSION, networkId: NETWORK_ID_REGTEST, censusHeight: 100, entryCloseMs: 0n, blockTicks: 100, timeCeil: 150, ...over });
const AFTER_ENTRY = stallCloseMs(contractAt());

// one failed duty round: seats 1-7 unless told, each `signers` entry notes `silent`, seated in the round's own certificate
function failed(n, { seats = [1, 2, 3, 4, 5, 6, 7], silent = [5, 6, 7], signers = [1, 2, 3, 4], closeMs = T - BigInt(n + 1) * 2n * HOUR, stage = STALL_STAGE.RESULT } = {}) {
  const roundId = toHex(ROUND(n));
  const notes = signers.map((k) => {
    const bytes = signStallNote({ roundId: ROUND(n), stage, silent: silent.filter((x) => x !== k).map(key) }, key(k), signBy(k));
    return { ...verifyStallNote(bytes, { verify }).note, bytes: toHex(bytes) };
  });
  return { roundId, closeMs, seatRound: roundId, seated: seats.map(hex), notes };
}
const census = Array.from({ length: 30 }, (_, i) => hex(i + 1));
const weightOf = () => 100n;
const WEIGHT = 3000n;

function certFor(r) {
  const rid = fromHex(r.seatRound), seatedKeys = r.seated.map(fromHex);
  const byHex = new Map(Array.from({ length: 40 }, (_, i) => [hex(i + 1), i + 1]));
  const signatures = r.seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeatingBound({ roundId: rid, role: 'settlement', seated: seatedKeys }, signBy(byHex.get(h))) }));
  const id = seatingId({ roundId: rid, role: 'settlement', seated: seatedKeys });
  const seen = [{ present: r.seated, leftOut: [], signatures: r.seated.map((h) => ({ nodePubkey: fromHex(h), signature: signSeen({ roundId: rid, role: 'settlement', seating: id, present: r.seated, leftOut: [] }, signBy(byHex.get(h))) })) }];
  return encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated: seatedKeys, signatures, seen });
}
function checker(rounds, over = {}) {
  const by = new Map(rounds.map((r) => [r.roundId, r]));
    return {
    window: w, verify, weightOf, keptWeight: WEIGHT, census,
    roundOf: (rid) => { const r = by.get(rid); return r ? contractAt({ entryCloseMs: r.closeMs - AFTER_ENTRY }) : null; },
    drawOf: (rid) => { const r = by.get(rid); return r ? { drawn: r.seated, slots: 7, closeMs: r.closeMs } : null; },
    certOf: (rid) => { const r = by.get(rid); return r ? certFor(r) : null; },
    dutyOf: () => ({ ok: true, rank: 1 }),
    ...over,
  };
}

test('protocol 26 is the next version and the rule is off below it, and off where no height is named', () => {
  assert.equal(STALL_VERSION, CENSUS_KEY_VERSION + 1);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(STALL_VERSION));
  assert.equal(speaksVersion(STALL_VERSION), true);
  assert.equal(stallsOut(contractAt({ protocolVersion: 25 })), false);
  assert.equal(stallsOut(contractAt()), true);
  assert.equal(STALL_HEIGHT.mainnet, 0, 'mainnet from genesis');
  assert.equal(STALL_HEIGHT.testnet4, null, 'named after every seat runs it');
  assert.equal(STALL_NOTE_QUORUM, 4); assert.equal(STALL_PROOF_ROUNDS, 3); assert.equal(STALL_WINDOW_MS, 72n * HOUR);
});

test('a StallNote is its three fields, signed by the seat; it cannot list itself or list nobody, and the list reads sorted', () => {
  const signed = signStallNote({ roundId: ROUND(1), stage: STALL_STAGE.RESULT, silent: [key(7), key(5)] }, key(1), signBy(1));
  assert.equal(signed.length, 1 + 2 + 32 + 1 + 2 + 2 * 32 + 32 + 64);
  const v = verifyStallNote(signed, { verify });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.note.signer, hex(1));
  assert.deepEqual(v.note.silent, [hex(5), hex(7)].sort());
  assert.equal(v.note.stage, STALL_STAGE.RESULT);
  assert.equal(decodeStallNote(signStallNote({ roundId: ROUND(1), stage: STALL_STAGE.FINAL, silent: [key(5)] }, key(1), signBy(1))).stage, STALL_STAGE.FINAL);
  const other = signStallNote({ roundId: ROUND(1), stage: STALL_STAGE.RESULT, silent: [key(5), key(7)] }, key(1), signBy(1));
  assert.equal(toHex(other.slice(0, -64)), toHex(signed.slice(0, -64)), 'one list, one body, whatever the order it was given in');
  assert.notEqual(toHex(stallNoteId({ roundId: ROUND(1), stage: 1, silent: [key(5)] })), toHex(stallNoteId({ roundId: ROUND(1), stage: 2, silent: [key(5)] })), 'the stage is signed');
  assert.match(verifyStallNote(signStallNote({ roundId: ROUND(1), stage: 1, silent: [key(1), key(5)] }, key(1), signBy(1)), { verify }).why, /lists itself/);
  assert.match(verifyStallNote(signStallNote({ roundId: ROUND(1), stage: 1, silent: [key(5)] }, key(1), signBy(2)), { verify }).why, /not signed by/);
  assert.throws(() => signStallNote({ roundId: ROUND(1), stage: 1, silent: [] }, key(1), signBy(1)), /lists the seats/);
  assert.throws(() => signStallNote({ roundId: ROUND(1), stage: 4, silent: [key(5)] }, key(1), signBy(1)), /a round and a stage/);
  assert.throws(() => decodeStallNote(Uint8Array.from([...signed, 0])), /trailing/);
  assert.deepEqual(silentSeats({ seats: [key(1), key(2), key(3)], answered: [hex(2)], me: key(1) }), [hex(3)]);
});

test('a node is named by 4 seats, none of them itself, and a seat signing both stages counts once', () => {
  const seated = [1, 2, 3, 4, 5, 6, 7].map(hex);
  const r = failed(1);
  assert.equal(namedBy(hex(5), r.notes, seated).length, 4);
  assert.equal(namedBy(hex(9), r.notes, seated).length, 0, 'a node not seated is named by nobody');
  // lists need not be equal: seat 1 says 5, 6; seat 2 says 5, 7; 3 and 4 say 5, 6, 7
  const lists = [[1, [5, 6]], [2, [5, 7]], [3, [5, 6, 7]], [4, [5, 6, 7]]].map(([k, l]) => verifyStallNote(signStallNote({ roundId: ROUND(2), stage: 1, silent: l.map(key) }, key(k), signBy(k)), { verify }).note);
  assert.equal(namedBy(hex(5), lists, seated).length, 4);
  assert.equal(namedBy(hex(6), lists, seated).length, 3, 'a node on 3 lists is not named');
  // both stages from one seat
  const twice = [1, 1, 2, 3].map((k, i) => verifyStallNote(signStallNote({ roundId: ROUND(3), stage: i === 1 ? 2 : 1, silent: [key(5)] }, key(k), signBy(k)), { verify }).note);
  assert.equal(namedBy(hex(5), twice, seated).length, 3);
});

test('3 rounds named, at least 1 h apart and each a fresh draw, make a claim every checker accepts; the node leaves the census and nothing else moves', () => {
  const rounds = [failed(1), failed(2), failed(3)];
  const claims = stalledFrom({ rounds, census, window: w, weightOf, baseWeight: WEIGHT, dutyOf: () => ({ ok: true }) });
  // 5, 6, 7 are each named by 3 rounds; the cap is 10 % of 3000 = 300, three nodes of 100
  assert.deepEqual(claims.map((c) => c.node), [5, 6, 7].map(hex).sort());
  assert.equal(claims[0].proofs.length, 3);
  assert.equal(claims[0].proofs[0].notes.length, 4);
  const kept = WEIGHT - 300n;
  const r = checkStallProof(claims, checker(rounds, { keptWeight: kept }));
  assert.equal(r.ok, true, r.why);
  // the set the root commits: the census less the stalled, as for the absent
  const entries = census.map((h) => ({ pubkey: fromHex(h) }));
  assert.equal(withoutAbsent(entries, claims).length, 27);
  // one claim's size, the ruling's 3 rounds x 4 notes
  const size = claims[0].proofs.flatMap((p) => p.notes).reduce((s, h) => s + h.length / 2, 0);
  assert.ok(size <= 12 * 230, `${size} bytes of notes`);
});

test('fewer than 3, closer than 1 h, one draw, 3 of 4 seats, a round that is no duty posting\'s, or out of the 72 h: no claim', () => {
  const base = { census, window: w, weightOf, baseWeight: WEIGHT };
  assert.deepEqual(stalledFrom({ ...base, rounds: [failed(1), failed(2)] }), [], 'two rounds');
  assert.deepEqual(stalledFrom({ ...base, rounds: [failed(1, { closeMs: T - 2n * HOUR }), failed(2, { closeMs: T - 2n * HOUR - 1800000n }), failed(3, { closeMs: T - 2n * HOUR - 2700000n })] }), [], 'one restart, three failures within the hour');
  assert.deepEqual(stalledFrom({ ...base, rounds: [failed(1), failed(2), failed(3, { signers: [1, 2, 3] })] }), [], '3 notes do not name');
  const a = failed(1), b = failed(2), c = failed(3);
  assert.deepEqual(stalledFrom({ ...base, rounds: [a, { ...b, seatRound: a.seatRound }, { ...c, seatRound: a.seatRound }] }), [], 'one table, one draw');
  assert.deepEqual(stalledFrom({ ...base, rounds: [a, b, c], dutyOf: (rid) => ({ ok: rid !== b.roundId, why: 'no' }) }), [], 'a self-posted round proves nothing');
  assert.deepEqual(stalledFrom({ ...base, rounds: [a, b, failed(3, { closeMs: T - 73n * HOUR })] }), [], 'older than the window');
  assert.equal(stalledFrom({ ...base, rounds: [a, b, c, failed(4)] }).length, 3, 'a fourth changes nothing');
  // and back by itself: the census 73 h after the oldest of exactly three reads two proofs
  assert.deepEqual(stalledFrom({ ...base, window: stallWindow(T + 60n * HOUR), rounds: [failed(1, { closeMs: T - 2n * HOUR }), failed(2, { closeMs: T - 4n * HOUR }), failed(3, { closeMs: T - 6n * HOUR })] }).length, 3, 'still out');
  assert.deepEqual(stalledFrom({ ...base, window: stallWindow(T + 67n * HOUR), rounds: [failed(1, { closeMs: T - 2n * HOUR }), failed(2, { closeMs: T - 4n * HOUR }), failed(3, { closeMs: T - 6n * HOUR })] }), [], 'no timer: back once fewer than 3 lie in the window');
});

test('the cap: 10 % of the weight past absence, those named longest ago out, the rest in; on a small census 1 node', () => {
  const list = [{ node: 'c', sinceMs: 3n, weight: 100n }, { node: 'a', sinceMs: 2n, weight: 100n }, { node: 'b', sinceMs: 1n, weight: 100n }];
  assert.deepEqual(stallCapKept(list, 2000n).map((c) => c.node), ['b', 'a'], '200 of 2000 fits, a third would not');
  assert.deepEqual(stallCapKept(list, 1400n).map((c) => c.node), ['b'], '14 nodes of 100: 1');
  assert.deepEqual(stallCapKept(list, 700n).map((c) => c.node), ['b'], '7 nodes of 100: still 1, as the ruling says of a small census');
  assert.deepEqual(stallCapKept([{ node: 'x', sinceMs: 1n, weight: 10n }, { node: 'y', sinceMs: 1n, weight: 10n }], 100n).map((c) => c.node), ['x'], 'a tie goes by key');
  // a claim over the cap is refused by name, the three at 1400 past absence
  const rounds = [failed(1), failed(2), failed(3)];
  const claims = stalledFrom({ rounds, census, window: w, weightOf, baseWeight: 3000n });
  const r = checkStallProof(claims, checker(rounds, { keptWeight: 1100n }));
  assert.equal(r.ok, false); assert.equal(r.proof, 'cap');
  assert.equal(stalledFrom({ rounds, census, window: w, weightOf, baseWeight: 1400n }).length, 1);
});

test('a claim that does not stand makes the census invalid, by name, and what cannot be read yet is only not yet', () => {
  const rounds = [failed(1), failed(2), failed(3)];
  const [c] = stalledFrom({ rounds, census, window: w, weightOf, baseWeight: 1000n });
  const check = (claim, over) => checkStallProof([claim], checker(rounds, over));
  assert.equal(check(c).ok, true);
  const wrongNote = { ...c, proofs: [{ ...c.proofs[0], notes: c.proofs[0].notes.slice(0, 3) }, ...c.proofs.slice(1)] };
  assert.equal(check(wrongNote).proof, 'note', '3 notes');
  assert.equal(check({ ...c, proofs: c.proofs.slice(0, 2) }).proof, 'too-few');
  assert.equal(check({ ...c, proofs: [c.proofs[0], c.proofs[0], c.proofs[1]] }).proof, 'too-few', 'one round twice');
  const forged = c.proofs[0].notes[0].replace(/..$/, (x) => (x === '00' ? '01' : '00'));
  assert.equal(check({ ...c, proofs: [{ ...c.proofs[0], notes: [forged, ...c.proofs[0].notes.slice(1)] }, ...c.proofs.slice(1)] }).proof, 'note');
  assert.equal(check({ ...c, proofs: [{ ...c.proofs[0], roundId: c.proofs[1].roundId, seatRound: c.proofs[1].roundId }, ...c.proofs.slice(1)] }).proof, 'note', 'another round\'s notes');
  assert.equal(check(c, { dutyOf: () => ({ ok: false, why: 'no marker' }) }).proof, 'not-duty');
  assert.equal(check(c, { certOf: () => null }).proof, 'certificate');
  assert.equal(check(c, { census: [] }).proof, 'census');
  assert.equal(check(c, { roundOf: () => null }).notYet, true);
  assert.equal(check(c, { drawOf: () => null }).notYet, true);
  assert.equal(check(c, { dutyOf: () => null }).notYet, true);
  // a round below the version proves nothing
  assert.equal(check(c, { roundOf: () => contractAt({ protocolVersion: 25 }) }).proof, 'version');
  // and one outside the window
  assert.equal(checkStallProof([c], { ...checker(rounds), window: stallWindow(T + 73n * HOUR) }).proof, 'outside');
  // a seat that was not seated cannot sign one, nor be named
  const out = rounds.map((r) => ({ ...r, seated: [1, 2, 3, 4, 9, 10, 11].map(hex) }));
  assert.equal(checkStallProof([c], checker(out)).proof, 'not-seated');
});

test('a seat\'s settlement commit is signed by its node key, names the transaction and the nonce points, and stands only for a seat of the round', () => {
  const commit = { roundId: ROUND(1), settlementTxid: b32(9), hiding: Uint8Array.from([2, ...b32(1)]), binding: Uint8Array.from([3, ...b32(2)]) };
  const signed = signSettlementCommit(commit, key(1), signBy(1));
  assert.equal(signed.length, SIGNED_SETTLEMENT_COMMIT_BYTES);
  const seats = [key(1), key(2)];
  assert.deepEqual(checkSettlementCommit(signed, { seats, commit, verify }), { ok: true, who: hex(1) });
  assert.match(checkSettlementCommit(signed, { seats: [key(2)], commit, verify }).why, /not one of the round's seats/);
  assert.match(checkSettlementCommit(signed, { seats, commit: { ...commit, settlementTxid: b32(8) }, verify }).why, /other bytes/);
  assert.match(checkSettlementCommit(signSettlementCommit(commit, key(1), signBy(2)), { seats, commit, verify }).why, /does not verify/);
});

test('a SETTLEMENT note counts only from its own height: on with the stall rule since the owner named it (#1339, "ab sofort"), mainnet from genesis, testnet4 at STALL_HEIGHT once named; RESULT and FINAL do not wait for it', () => {
  assert.deepEqual({ ...STALL_SETTLEMENT_HEIGHT }, { mainnet: 0, testnet4: null, regtest: 0, devnet: 0 });
  assert.equal(stallSettlementPoint('mainnet'), STALL_HEIGHT.mainnet, 'the settlement stage goes on with the stall rule itself');
  assert.equal(stallSettlementPoint('testnet'), STALL_HEIGHT.testnet4, 'testnet4: the same point as the stall rule');
  assert.equal(stallSettlementPoint('elsewhere'), null);
  assert.equal(settlementNotesCount(contractAt({ networkId: NETWORK_ID_TESTNET4 })), false);
  assert.equal(settlementNotesCount(contractAt()), true, 'a regtest runs the code');
  const off = () => null, named = () => 100;
  assert.equal(settlementNotesCount(contractAt(), off), false);
  assert.equal(settlementNotesCount(contractAt(), named), true, 'at the height, once one is named');
  assert.equal(settlementNotesCount(contractAt({ censusHeight: 99 }), named), false, 'the round\'s census height decides');
  for (const stage of [STALL_STAGE.RESULT, STALL_STAGE.FINAL]) assert.equal(stallNoteCounts({ stage }, contractAt(), off), true);
  assert.equal(stallNoteCounts({ stage: STALL_STAGE.SETTLEMENT }, contractAt(), off), false);
  assert.equal(stallNoteCounts({ stage: STALL_STAGE.SETTLEMENT }, contractAt()), true);
  assert.equal(stallNoteCounts({ stage: STALL_STAGE.SETTLEMENT }, null), false);
});

test('a claim that rests on SETTLEMENT notes makes the census invalid below that height, and one of RESULT and FINAL notes stands', () => {
  const each = (stage) => [failed(1, { stage }), failed(2, { stage }), failed(3, { stage })];
  const claimsOf = (rounds) => stalledFrom({ rounds, census, window: w, weightOf, baseWeight: WEIGHT, dutyOf: () => ({ ok: true }) });
  const off = { settlementPointOf: () => null };
  const settlement = each(STALL_STAGE.SETTLEMENT);
  assert.equal(checkStallProof(claimsOf(settlement), checker(settlement, { keptWeight: WEIGHT - 300n })).ok, true, 'it stands where the height is passed');
  const refused = checkStallProof(claimsOf(settlement), checker(settlement, { keptWeight: WEIGHT - 300n, ...off }));
  assert.equal(refused.ok, false);
  assert.equal(refused.proof, 'note');
  assert.match(refused.why, /0 seats of round/);
  for (const stage of [STALL_STAGE.RESULT, STALL_STAGE.FINAL]) {
    const rounds = each(stage);
    assert.equal(checkStallProof(claimsOf(rounds), checker(rounds, { keptWeight: WEIGHT - 300n, ...off })).ok, true, `stage ${stage}`);
  }
  // A NOTE OF EACH STAGE IN ONE ROUND: the SETTLEMENT notes are not counted, and the 2 of RESULT left are short of 4
  const mixed = [1, 2, 3].map((n) => { const a = failed(n, { signers: [1, 2] }), b = failed(n, { signers: [3, 4], stage: STALL_STAGE.SETTLEMENT }); return { ...a, notes: [...a.notes, ...b.notes] }; });
  const short = checkStallProof(claimsOf(mixed), checker(mixed, { keptWeight: WEIGHT - 300n, ...off }));
  assert.equal(short.ok, false);
  assert.match(short.why, /2 seats of round/);
});

test('the spacing is absence\'s hour', () => { assert.equal(ABSENCE_PROOF_SPACING_MS, HOUR); });
