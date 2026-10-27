// A seat's desk for audits (spec §13A.1, kanban #725): an AUDIT that stands and arrives in time is kept once; one signed too far from
// the seat's clock, after the lead, after the close, or for other results is refused by name; a forwarded one counts until the close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAuditDesk } from '../src/audit-seat.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { vrfSecretFor, auditAlpha, auditResultsHash, encodeAudit, auditId, AUDIT_LEAD_MS } from '../../arena-protocol/src/auditor.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const secret = taggedHash('test/audit-seat', new Uint8Array(1)), node = schnorr.getPublicKey(secret);
const roundId = taggedHash('test/round', Uint8Array.of(7));
const resultsHash = auditResultsHash([{ entryId: new Uint8Array(32).fill(1), resultDigest: new Uint8Array(32).fill(2) }]);
const CLOSE = 2_000_000;
const ctx = { ok: true, eligible: new Map([[toHex(node), 1n]]), total: 1n, closeMs: CLOSE, resultsHash };
const auditAt = (atMs, hash = resultsHash) => {
  const a = { roundId, resultsHash: hash, nodePubkey: node, atMs: BigInt(atMs), vrfProof: vrf.prove(vrfSecretFor(secret, secp256k1.Point), auditAlpha(roundId)) };
  const sig = schnorr.sign(auditId(a), secret), bytes = encodeAudit(a);
  const out = new Uint8Array(bytes.length + 64); out.set(bytes); out.set(sig, bytes.length); return out;
};
const deskAt = (nowMs) => { let t = nowMs; const db = new DatabaseSync(':memory:');
  return { desk: createAuditDesk({ db, now: () => t, contextFor: async () => ctx, vrf, verify }), at: (ms) => { t = ms; }, db }; };

test('in time and standing: kept once, held, listed', async () => {
  const { desk } = deskAt(1_900_000);
  const r = await desk.take(auditAt(1_900_000));
  assert.deepEqual([r.ok, r.kept, r.node], [true, true, toHex(node)], r.why);
  assert.equal((await desk.take(auditAt(1_900_000))).kept, false, 'once per node and round');
  assert.deepEqual(desk.held(roundId), [toHex(node)]);
  assert.equal(desk.list(roundId)[0].atMs, 1_900_000);
});

test('refused: off the seat\'s clock, inside the last 30 s, after the close, other results, not an AUDIT', async () => {
  const { desk, at } = deskAt(1_900_000);
  assert.match((await desk.take(auditAt(1_880_000))).why, /within 5 s of the seat's clock/);
  at(CLOSE - AUDIT_LEAD_MS + 2000);
  assert.match((await desk.take(auditAt(CLOSE - AUDIT_LEAD_MS + 1000))).why, /30 s before the window closes/);
  at(CLOSE + 1);
  assert.match((await desk.take(auditAt(CLOSE + 1))).why, /window has closed/);
  at(1_900_000);
  assert.match((await desk.take(auditAt(1_900_000, new Uint8Array(32).fill(9)))).why, /other results/);
  assert.match((await desk.take(new Uint8Array(70))).why, /not an AUDIT/);
  assert.deepEqual(desk.held(roundId), []);
});

test('forwarded by another seat: counts until the close, its time no longer near this clock', async () => {
  const { desk, at } = deskAt(CLOSE - 10_000);
  const r = await desk.take(auditAt(CLOSE - AUDIT_LEAD_MS - 1000), { forwarded: true });
  assert.equal(r.kept, true, r.why);
  at(CLOSE + 5);
  assert.match((await desk.take(auditAt(CLOSE - AUDIT_LEAD_MS - 1000), { forwarded: true })).why, /window has closed/);
});

test('a valid objection contradicts the round\'s AUDITs: kept as evidence with their bytes, paid nothing, marked once', async () => {
  const { desk } = deskAt(1_900_000);
  const body = auditAt(1_900_000);
  assert.equal((await desk.take(body)).kept, true);
  assert.deepEqual(desk.contradict(roundId, 'entry 01..: VOID after a valid objection'), [toHex(node)]);
  assert.deepEqual(desk.held(roundId), [], 'a contradicted AUDIT is no auditor\'s line');
  const [row] = desk.list(roundId);
  assert.match(row.contradicted, /VOID after a valid objection/);
  assert.equal(row.audit, toHex(body), 'its bytes and signature: the fraud proof\'s evidence');
  assert.deepEqual(desk.contradict(roundId, 'again'), [], 'once');
  assert.equal((await desk.take(body)).kept, false, 'and not taken again');
});

test('the forward digest is the AUDIT\'s own, under its own tag: no other object signs it', async () => {
  const { forwardDigest } = await import('../src/audit-seat.js');
  const { decodeAudit } = await import('../../arena-protocol/src/auditor.js');
  const { TAG } = await import('../../arena-protocol/src/constants.js');
  const body = auditAt(1_900_000);
  const id = auditId(decodeAudit(body.subarray(0, body.length - 64)));
  assert.equal(toHex(forwardDigest(body)), toHex(taggedHash(TAG.auditForward, id)));
  assert.notEqual(toHex(forwardDigest(body)), toHex(id));
  assert.equal(Object.values(TAG).filter((t) => t === TAG.auditForward).length, 1);
});

test('the agreed runs an AUDIT is over: every entry\'s 5 of 7, in entry order - none while one entry has no agreed run', async () => {
  const { agreedRunsOf } = await import('../src/audit-seat.js');
  const { encodePlayerResult, joinSignedResult, resultId } = await import('../../arena-protocol/src/result.js');
  const { runId } = await import('../src/verdict.js');
  const keys = Array.from({ length: 7 }, (_, i) => taggedHash('test/audit-seat/seat', Uint8Array.of(i)));
  const committee = keys.map((k) => schnorr.getPublicKey(k));
  const contract = { gameVerifySlots: 7 };
  const signed = (entry, score, k) => {
    const r = { roundId, playerPubkey: new Uint8Array(32).fill(entry), outcome: 'DELIVERED', score, transcriptHash: new Uint8Array(32).fill(entry),
      simCoreHash: new Uint8Array(32).fill(3), nodePubkey: schnorr.getPublicKey(k) };
    return { r, bytes: joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), k)) };
  };
  const entries = [2, 1].map((n) => ({ entryId: new Uint8Array(32).fill(n), results: keys.map((k, i) => signed(n, i < 5 ? 10 : 11, k).bytes) }));
  const got = agreedRunsOf({ contract, committee, entries });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.runs.map((r) => toHex(r.runId)), [2, 1].map((n) => toHex(runId(signed(n, 10, keys[0]).r))), 'the five, not the two');
  assert.equal(toHex(got.resultsHash), toHex(auditResultsHash(got.runs.map((r) => ({ entryId: r.entryId, resultDigest: r.runId })))));
  const short = [{ entryId: entries[0].entryId, results: entries[0].results.slice(0, 4) }, entries[1]];
  assert.match(agreedRunsOf({ contract, committee, entries: short }).why, /has no agreed run yet/);
});
