// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1331 / #1383 (§13A.1 RULED 2026-11-09): from AUDIT_TICK_VERSION a seat counts an AUDIT only when its tick hash is the one its own replays give
// at the auditor's tick (t from the AUDIT's VRF output); a seat that cannot replay leaves it unread. And the auditor signs that hash into its AUDIT.
// (No round runs at 28 in this build: the desk and the auditor are driven with the context a seat would hand them.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAuditDesk } from '../src/audit-seat.js';
import { RoundAuditor } from '../src/round-auditor.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { auditAlpha, auditId, encodeAudit, decodeAudit, auditResultsHash, auditTick, auditTickHash, vrfSecretFor, vrfPublicKey, AUDIT_TICK_VERSION } from '../../arena-protocol/src/auditor.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const secret = taggedHash('test/audit-tick', new Uint8Array(1)), node = schnorr.getPublicKey(secret);
const roundId = taggedHash('test/round', Uint8Array.of(9));
const E1 = new Uint8Array(32).fill(1), E2 = new Uint8Array(32).fill(2), RUN = new Uint8Array(32).fill(3);
const resultsHash = auditResultsHash([{ entryId: E1, resultDigest: RUN }, { entryId: E2, resultDigest: RUN }]);
const RUN_TICKS = 9000, CLOSE = 2_000_000;
const pi = vrf.prove(vrfSecretFor(secret, secp256k1.Point), auditAlpha(roundId));
const beta = vrf.verify(vrfPublicKey(node), auditAlpha(roundId), pi);
const T = auditTick({ beta, runTicks: RUN_TICKS });
const stateOf = (e, t) => taggedHash('test/state', new Uint8Array([...e, t & 255, (t >> 8) & 255]));
const RIGHT = auditTickHash({ t: T, entries: [{ entryId: E1, stateHash: stateOf(E1, T) }, { entryId: E2, stateHash: stateOf(E2, T) }] });
const auditWith = (tickHash) => {
  const a = { roundId, resultsHash, nodePubkey: node, atMs: 1_900_000n, vrfProof: pi, ...(tickHash ? { tickHash } : {}) };
  const sig = schnorr.sign(auditId(a), secret), bytes = encodeAudit(a);
  return new Uint8Array([...bytes, ...sig]);
};
const deskWith = (ctxMore) => createAuditDesk({ db: new DatabaseSync(':memory:'), now: () => 1_900_000, vrf, verify,
  contextFor: async () => ({ ok: true, eligible: new Map([[toHex(node), 1n]]), total: 1n, closeMs: CLOSE, resultsHash, ...ctxMore }) });

test('#1383 the seat: the AUDIT counts when its tick hash is its own replays\' at the auditor\'s tick; another, none, or no replay: not counted', async () => {
  const asked = [];
  const ctx = { protocolVersion: AUDIT_TICK_VERSION, runTicks: RUN_TICKS, tickHashAt: async (t) => { asked.push(t); return t === T ? RIGHT : new Uint8Array(32); } };
  const ok = await deskWith(ctx).take(auditWith(RIGHT));
  console.log(`  MEASURED #1383 seat: tick ${T} of ${RUN_TICKS}, asked ${JSON.stringify(asked)}, ${JSON.stringify({ ok: ok.ok, kept: ok.kept, why: ok.why })}`);
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual(asked, [T], 'the seat replayed another tick than the auditor\'s VRF names');
  const wrong = await deskWith(ctx).take(auditWith(new Uint8Array(32).fill(0x77)));
  assert.equal(wrong.ok, false); assert.match(wrong.why, new RegExp(`state at tick ${T} is not the replay's`));
  const none = await deskWith(ctx).take(auditWith(null));
  assert.equal(none.ok, false); assert.match(none.why, /carries H\(state at its VRF tick\)/);
  const blind = await deskWith({ ...ctx, tickHashAt: async () => { throw new Error('entry 0101 does not replay here'); } }).take(auditWith(RIGHT));
  assert.deepEqual([blind.ok, blind.status], [false, 503]); assert.match(blind.why, /cannot read the AUDIT's tick .*does not replay here/);
  // below the version: no tick asked, a plain AUDIT counts as before
  const old = await deskWith({ protocolVersion: AUDIT_TICK_VERSION - 1, runTicks: RUN_TICKS, tickHashAt: async () => { throw new Error('asked'); } }).take(auditWith(null));
  assert.equal(old.ok, true, old.why);
});

test('#1383 the auditor: it replays every entry at its tick and signs their hash into the AUDIT; an entry without its state, no AUDIT', async () => {
  const posted = [], asked = [];
  const make = (stateAt) => new RoundAuditor({ selfKey: node, prove: () => pi, outputOf: (p) => vrf.verify(vrfPublicKey(node), auditAlpha(roundId), p),
    sign: (d) => schnorr.sign(d, secret), due: () => [{ roundId, closeMs: CLOSE }], eligibleFor: () => ({ eligible: new Map([[toHex(node), 1n]]), total: 1n }),
    entriesFor: async () => [{ entryId: E1, runId: RUN }, { entryId: E2, runId: RUN }], replay: async (rid, eid, ticks) => { asked.push(ticks); return RUN; },
    object: async () => false, post: async (b) => { posted.push(b); return 1; }, tickOf: (rid, b) => auditTick({ beta: b, runTicks: RUN_TICKS }), stateAt, now: () => 1_900_000 });
  const did = await make((rid, eid) => stateOf(eid, T)).pass();
  assert.deepEqual(did.map((x) => x.audited), [2]);
  assert.deepEqual(asked, [[T], [T]], 'each entry replayed at the AUDIT\'s tick');
  const a = decodeAudit(posted[0]);
  assert.equal(toHex(a.tickHash), toHex(RIGHT), 'the AUDIT does not carry the hash of its replays');
  posted.length = 0;
  assert.deepEqual(await make((rid, eid) => (eid[0] === 1 ? stateOf(eid, T) : null)).pass(), [], 'an AUDIT without every entry\'s state');
  assert.equal(posted.length, 0);
});
