// The node as an auditor (spec §13A.1, kanban #725): drawn by its own VRF, it replays every entry and posts a signed AUDIT that a seat's
// check (auditStands) takes; one run that replays differently is an objection and no AUDIT; not drawn, too late or not replayable: nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundAuditor } from '../src/round-auditor.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { vrfSecretFor, auditEligible, decodeAudit, auditStands, auditResultsHash, AUDIT_LEAD_MS } from '../../arena-protocol/src/auditor.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const secret = taggedHash('test/round-auditor', new Uint8Array(1));
const selfKey = schnorr.getPublicKey(secret);
const roundId = taggedHash('test/round', new Uint8Array(1));
const entries = [1, 2, 3].map((i) => ({ entryId: new Uint8Array(32).fill(i), runId: new Uint8Array(32).fill(10 + i) }));
// a census where this node is the only auditor-eligible one: weight 1 of 1, drawn (3 x 1 / 1 > any beta)
const census = { eligible: new Map([[toHex(selfKey), 1n]]), total: 1n };

const auditorOf = (o = {}) => {
  const sent = { audits: [], objections: [] };
  let t = o.nowMs ?? 1_000_000;
  const a = new RoundAuditor({
    selfKey, prove: (alpha) => vrf.prove(vrfSecretFor(secret, secp256k1.Point), alpha), outputOf: (pi) => vrf.proofToHash(pi),
    sign: (d) => schnorr.sign(d, secret), due: () => [{ roundId, closeMs: o.closeMs ?? 1_600_000 }],
    eligibleFor: () => o.census ?? census, entriesFor: async () => o.entries ?? entries,
    replay: o.replay ?? (async (_r, eid) => entries.find((e) => toHex(e.entryId) === toHex(eid)).runId),
    object: async (_r, eid) => { sent.objections.push(toHex(eid)); return true; },
    post: async (bytes, signature) => { sent.audits.push({ bytes, signature }); return 7; },
    now: () => t,
  });
  return { a, sent, at: (ms) => { t = ms; } };
};

test('drawn, every entry replays as signed: one AUDIT, signed, that a seat takes; once', async () => {
  const { a, sent } = auditorOf();
  assert.deepEqual(await a.pass(), [{ round: toHex(roundId), audited: 3, seats: 7 }]);
  assert.equal(sent.audits.length, 1);
  const audit = decodeAudit(sent.audits[0].bytes);
  assert.deepEqual([toHex(audit.nodePubkey), audit.atMs], [toHex(selfKey), 1_000_000n]);
  const st = auditStands(audit, { signature: sent.audits[0].signature, vrf, verify, ...census, windowCloseMs: 1_600_000,
    resultsHash: auditResultsHash(entries.map((e) => ({ entryId: e.entryId, resultDigest: e.runId }))) });
  assert.equal(st.ok, true, st.why);
  await a.pass();
  assert.equal(sent.audits.length, 1, 'once a round');
});

test('one entry replays to another run: the objection for it, and no AUDIT', async () => {
  const { a, sent } = auditorOf({ replay: async (_r, eid) => (eid[0] === 2 ? new Uint8Array(32).fill(99) : entries.find((e) => e.entryId[0] === eid[0]).runId) });
  const did = await a.pass();
  assert.deepEqual([sent.objections, sent.audits.length, did[0].objected], [[toHex(entries[1].entryId)], 0, toHex(entries[1].entryId)]);
});

test('nothing is sent when not drawn, too late, or a run cannot be replayed', async () => {
  const notEligible = auditorOf({ census: { eligible: new Map(), total: 5n } });
  await notEligible.a.pass();
  assert.equal(notEligible.sent.audits.length, 0);
  assert.equal(notEligible.a.done.get(toHex(roundId)), 'not drawn');
  const late = auditorOf({ nowMs: 1_600_000 - AUDIT_LEAD_MS + 1 });
  await late.a.pass();
  assert.deepEqual([late.sent.audits.length, late.a.done.get(toHex(roundId))], [0, 'late']);
  const blind = auditorOf({ replay: async () => null });
  await blind.a.pass();
  assert.equal(blind.sent.audits.length, 0, 'never an AUDIT it has not replayed');
  assert.equal(blind.a.done.has(toHex(roundId)), false, 'tried again next pass while there is time');
  blind.at(1_600_000 - 2 * AUDIT_LEAD_MS + 1);
  await blind.a.pass();
  assert.equal(blind.a.done.get(toHex(roundId)), 'could not replay');
});

test('a census where it is one of many: drawn only as its VRF says, the same answer every time', async () => {
  const others = Array.from({ length: 40 }, (_, i) => ({ pubkey: schnorr.getPublicKey(taggedHash('test/other', Uint8Array.of(i))), roles: ['audit'], bondSats: 50_000n }));
  const set = auditEligible({ entries: [{ pubkey: selfKey, roles: ['audit'], bondSats: 50_000n }, ...others], bondMinSats: 50_000n });
  const { a } = auditorOf({ census: set });
  const first = a.drawOf(roundId);
  a.draws.clear();
  assert.equal(a.drawOf(roundId).drawn, first.drawn, 'deterministic');
});
