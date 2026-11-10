// KANBAN #1412 (§13A.1, RULED #1400): the head-to-head audit before FINAL - five drawn auditors expected, a check of commitments against reveals,
// a signed H2H_AUDIT a seat checks, and FINAL inside the 60 s window only with 2 audits from distinct drawn auditors, else 600 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeVrf, SUITE_SECP256K1_TAI } from '../src/vrf.js';
import { auditAlpha, vrfSecretFor, auditEligible } from '../src/auditor.js';
import { isH2hAuditor, h2hCheck, encodeH2hAudit, decodeH2hAudit, h2hAuditId, h2hAuditStands, h2hFinality, AUDITORS_H2H } from '../src/h2h-audit.js';
import { headToHeadCommit, VERDICT } from '../src/head-to-head.js';
import { taggedHash, toHex } from '../src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const node = (i) => { const secret = taggedHash('test/h2h-auditor', Uint8Array.of(i >> 8, i & 255)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const BOND_MIN = 50_000n;
const census = (n) => Array.from({ length: n }, (_, i) => ({ pubkey: node(i).pubkey, roles: ['game', 'verify', 'settlement', 'audit'], bondSats: BOND_MIN, operatorId: `op${i}` }));
const rid = (i) => taggedHash('test/h2h-round', Uint8Array.of(i >> 8, i & 255));
const drawn = (roundId, n) => { const { eligible, total } = auditEligible({ entries: census(n), bondMinSats: BOND_MIN });
  return Array.from({ length: n }, (_, i) => node(i)).filter((nd) => { const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(roundId));
    return isH2hAuditor({ beta: vrf.proofToHash(pi), weight: eligible.get(toHex(nd.pubkey)), total }); }); };
// Rock Paper Scissors' decide: 0 rock, 1 paper, 2 scissors
const decide = (moves) => { const [a, b] = moves; const w = (a.move - b.move + 3) % 3;
  return w === 0 ? { [a.key]: VERDICT.DRAW, [b.key]: VERDICT.DRAW } : w === 1 ? { [a.key]: VERDICT.WIN, [b.key]: VERDICT.LOSS } : { [a.key]: VERDICT.LOSS, [b.key]: VERDICT.WIN }; };

test('#1412 about five auditors a round, drawn in secret by the VRF', () => {
  const counts = Array.from({ length: 200 }, (_, i) => drawn(rid(i), 40).length);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`  MEASURED #1412 draw: 200 rounds over 40 eligible nodes: ${mean.toFixed(2)} auditors a round (expected ${AUDITORS_H2H}), fewer than 2 in ${counts.filter((c) => c < 2).length}`);
  assert.ok(mean > 4.3 && mean < 5.7, `mean ${mean}`);
});

test('#1412 the check: commitments against reveals, FORFEIT for a reveal that does not open its commitment, VOID with one entry', () => {
  const roundId = rid(7), close = 1_000_000n, win = 10_000n;
  const e = (n, move, opts = {}) => { const entryKey = taggedHash('test/key', Uint8Array.of(n)), salt = taggedHash('test/salt', Uint8Array.of(n));
    return { entryId: taggedHash('test/entry', Uint8Array.of(n)), entryKey, commit: headToHeadCommit({ roundId, entryKey, move, salt }),
      reveal: opts.noReveal ? null : { move: opts.claim ?? move, salt, atMs: close + (opts.late ? win + 1n : 500n) } }; };
  const args = { roundId, decide, config: null, moveCount: 3, entryCloseMs: close, revealWindowMs: win };
  const fair = h2hCheck({ ...args, entries: [e(1, 1), e(2, 0)] });
  const lied = h2hCheck({ ...args, entries: [e(1, 1), e(2, 0, { claim: 2 })] });
  const lone = h2hCheck({ ...args, entries: [e(1, 1)] });
  const late = h2hCheck({ ...args, entries: [e(1, 1), e(2, 0, { late: true })] });
  const show = (r) => r.results.map((x) => `${x.outcome}/${x.score}`).join(' ');
  console.log(`  MEASURED #1412 check: paper vs rock -> ${show(fair)}; a reveal not opening its commitment -> ${show(lied)} (${lied.refused[0].why}); one entry -> ${show(lone)}; a late reveal -> ${show(late)}`);
  assert.equal(show(fair), 'DELIVERED/2 FAILED/0');
  assert.equal(show(lied), 'DELIVERED/2 FORFEIT/0');
  assert.equal(show(lone), 'VOID/0');
  assert.equal(show(late), 'DELIVERED/2 FORFEIT/0');
  assert.notEqual(toHex(fair.resultsHash), toHex(lied.resultsHash));
});

test('#1412 an H2H_AUDIT a seat counts: signed, drawn, its beta its proof\'s, over these results, before the window closed - and refused otherwise', () => {
  const N = 40;
  let roundId = null, auditors = [];
  for (let i = 0; i < 50 && auditors.length < 2; i++) { roundId = rid(1000 + i); auditors = drawn(roundId, N); }
  const { eligible, total } = auditEligible({ entries: census(N), bondMinSats: BOND_MIN });
  const resultsHash = taggedHash('test/results', Uint8Array.of(1));
  const make = (nd, over = {}) => { const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(roundId));
    const a = { roundId, resultsHash, nodePubkey: nd.pubkey, atMs: 5000n, beta: vrf.proofToHash(pi), vrfProof: pi, ...over };
    return { a: decodeH2hAudit(encodeH2hAudit(a)), signature: schnorr.sign(h2hAuditId(a), nd.secret) }; };
  const ctx = { vrf, verify, eligible, total, resultsHash, windowCloseMs: 60000n };
  const good = make(auditors[0]);
  const notDrawn = (() => { const nd = Array.from({ length: N }, (_, i) => node(i)).find((x) => !auditors.some((y) => toHex(y.pubkey) === toHex(x.pubkey))); return make(nd); })();
  const otherResults = make(auditors[0], { resultsHash: taggedHash('test/results', Uint8Array.of(2)) });
  const lateOne = make(auditors[0], { atMs: 61000n });
  const forged = { a: good.a, signature: schnorr.sign(h2hAuditId(good.a), node(999).secret) };
  const why = (x) => { const r = h2hAuditStands(x.a, { ...ctx, signature: x.signature }); return r.ok ? 'counted' : r.why; };
  const facts = { good: why(good), notDrawn: why(notDrawn), otherResults: why(otherResults), late: why(lateOne), forged: why(forged) };
  console.log('  MEASURED #1412 stands:', JSON.stringify(facts));
  assert.equal(facts.good, 'counted');
  assert.match(facts.notDrawn, /not drawn/);
  assert.match(facts.otherResults, /other results/);
  assert.match(facts.late, /after the 60 s window/);
  assert.match(facts.forged, /not signed by the node/);
});

test('#1412 FINAL in 60 s with 5 of 7 and 2 audits; one audit or a late second -> 600 s, never VOID; no committee FINAL -> not final', () => {
  const rh = taggedHash('test/results', Uint8Array.of(3)), other = taggedHash('test/results', Uint8Array.of(4));
  const A = (n, held, h = rh) => ({ nodePubkey: Uint8Array.of(...new Uint8Array(31), n), resultsHash: h, heldAtMs: held });
  const P = 100_000n;
  const two = h2hFinality({ provisionalAtMs: P, committeeFinal: true, audits: [A(1, P + 20_000n), A(2, P + 45_000n)], resultsHash: rh, nowMs: P + 60_000n });
  const one = h2hFinality({ provisionalAtMs: P, committeeFinal: true, audits: [A(1, P + 20_000n), A(1, P + 30_000n)], resultsHash: rh, nowMs: P + 60_000n });
  const lateSecond = h2hFinality({ provisionalAtMs: P, committeeFinal: true, audits: [A(1, P + 20_000n), A(2, P + 61_000n)], resultsHash: rh, nowMs: P + 600_000n });
  const otherHash = h2hFinality({ provisionalAtMs: P, committeeFinal: true, audits: [A(1, P + 1n), A(2, P + 2n, other)], resultsHash: rh, nowMs: P + 600_000n });
  const noCommittee = h2hFinality({ provisionalAtMs: P, committeeFinal: false, audits: [A(1, P), A(2, P)], resultsHash: rh, nowMs: P + 700_000n });
  const f = (x) => `${x.final ? 'FINAL' : 'not final'} ${x.window}${x.atMs !== undefined ? ` at +${(x.atMs - P) / 1000n} s` : ''}`;
  console.log(`  MEASURED #1412 finality: two audits -> ${f(two)}; one auditor twice -> ${f(one)}; second after 60 s -> ${f(lateSecond)}; one on other results -> ${f(otherHash)}; no committee FINAL -> ${f(noCommittee)}`);
  assert.deepEqual([two.final, two.window, two.atMs], [true, 'short', P + 60_000n]);
  assert.deepEqual([one.final, one.window, one.atMs], [false, 'long', P + 600_000n]);
  assert.deepEqual([lateSecond.final, lateSecond.window], [true, 'long']);
  assert.equal(otherHash.window, 'long');
  assert.equal(noCommittee.final, false);
});
