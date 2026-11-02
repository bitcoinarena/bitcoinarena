// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE ROUND SETTLED ON, READ OFF THE SIGNATURES (§5A.3's real loss, kanban #978): a seat cannot say a false run settled, or did not, by saying so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { settledEntries } from '../src/arbiter.js';
import { runId } from '../src/verdict.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeRerunResult, joinSignedRerun, rerunResultId } from '../../arena-protocol/src/rerun.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const ROUND = b32(1);
const secrets = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x40 + n));
const committee = secrets.map((s) => schnorr.getPublicKey(s));
const contract = { gameVerifySlots: 7, settlementSlots: 7, federationId: b32(9), stakeMsat: 1000n };
const FINAL_AFTER = 1000n;
const entry = { roundId: ROUND, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7), stakeMsat: 1_000_000n, feeMsat: 0n, donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) };
const body = (outcome, score, i) => ({ roundId: ROUND, playerPubkey: entry.playerPubkey, outcome, score, transcriptHash: b32(0x71), simCoreHash: b32(0x73), nodePubkey: committee[i] });
const signedResult = (outcome, score, i) => { const r = body(outcome, score, i); return joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), secrets[i])); };
const FALSE = runId(body('FAILED', 0, 0)), TRUE = runId(body('DELIVERED', 50, 0));
const eid = entryId(entry);
const final = (run, i, signedAtMs = 2000n) => signFinalSig({ roundId: ROUND, entryId: eid, runId: run, signerPubkey: committee[i], signedAtMs }, (m) => schnorr.sign(m, secrets[i]));
const rerun = (i) => { const x = { contradictedRunId: FALSE, signedAtMs: 1500n, result: body('DELIVERED', 50, i) }; return joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), secrets[i])); };
const row = (over = {}) => ({ id: toHex(eid), entry: toHex(encodeEntryContract(entry)), results: [0, 1, 2, 3, 4, 5, 6].map((i) => toHex(signedResult('FAILED', 0, i))), reruns: [], finals: [], ...over });
const read = (over) => settledEntries({ run: { entries: [row(over)] }, roundId: ROUND, contract, committee, finalAfterMs: FINAL_AFTER })[0];
const finals = (run, n, at) => Array.from({ length: n }, (_, i) => toHex(final(run, i, at)));

test('five FINAL signatures on the false run: it settled, and what it said is read off the signed results', () => {
  const e = read({ finals: finals(FALSE, 5) });
  assert.deepEqual([e.finalProven, e.runId, e.outcome, e.score], [true, toHex(FALSE), 'FAILED', 0]);
  assert.equal(e.federation, toHex(contract.federationId));
});

test('four are not a FINAL: the agreed run is read, and it is not proven to have settled', () => {
  const e = read({ finals: finals(FALSE, 4) });
  assert.deepEqual([e.finalProven, e.runId], [false, toHex(FALSE)]);
});

test('a FINAL signed before the window\'s final_after does not count', () => {
  assert.equal(read({ finals: finals(FALSE, 5, 999n) }).finalProven, false);
});

test('a key off the committee does not count, nor does a seat saying so twice', () => {
  const stranger = b32(0x7f);
  const forged = signFinalSig({ roundId: ROUND, entryId: eid, runId: FALSE, signerPubkey: schnorr.getPublicKey(stranger), signedAtMs: 2000n }, (m) => schnorr.sign(m, stranger));
  assert.equal(read({ finals: [...finals(FALSE, 4), toHex(forged), toHex(final(FALSE, 0, 2001n))] }).finalProven, false);
});

test('an objection in time: the re-run is what five seats signed FINAL, so the false run did not settle', () => {
  const e = read({ reruns: [0, 1, 2, 3, 4].map((i) => toHex(rerun(i))), finals: finals(TRUE, 5) });
  assert.deepEqual([e.finalProven, e.runId, e.outcome, e.score], [true, toHex(TRUE), 'DELIVERED', 50]);
});

test('a row that is not its entry is left out, and an entry with no agreed run has no outcome', () => {
  assert.equal(settledEntries({ run: { entries: [row({ id: 'ab'.repeat(32) })] }, roundId: ROUND, contract, committee, finalAfterMs: FINAL_AFTER }).length, 0);
  const e = read({ results: [] });
  assert.deepEqual([e.runId, e.outcome], [null, undefined]);
});
