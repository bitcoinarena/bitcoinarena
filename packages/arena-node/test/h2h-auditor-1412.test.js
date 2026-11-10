// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1412 (§13A.1, RULED #1400): the head-to-head auditor service. A drawn node checks the round's moves itself and posts an H2H_AUDIT; the seat's
// desk (h2h-audit-desk.js, the door POST /h2h-audit keeps) takes it in time - one audit: the long window; two drawn auditors: the 60 s window. An
// undrawn node posts nothing; committee results the moves do not give get no audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createH2hAuditDesk } from '../src/h2h-audit-desk.js';
import { H2hAuditor } from '../src/h2h-auditor.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { auditAlpha, vrfSecretFor, auditEligible } from '../../arena-protocol/src/auditor.js';
import { isH2hAuditor, h2hCheck } from '../../arena-protocol/src/h2h-audit.js';
import { headToHeadCommit, VERDICT } from '../../arena-protocol/src/head-to-head.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const node = (i) => { const secret = taggedHash('test/h2h-auditor-node', Uint8Array.of(i >> 8, i & 255)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const N = 40, BOND_MIN = 50_000n;
const set = auditEligible({ entries: Array.from({ length: N }, (_, i) => ({ pubkey: node(i).pubkey, roles: ['audit'], bondSats: BOND_MIN, operatorId: `op${i}` })), bondMinSats: BOND_MIN });
const drawn = (rid, nd) => { const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(rid)); return isH2hAuditor({ beta: vrf.proofToHash(pi), weight: set.eligible.get(toHex(nd.pubkey)), total: set.total }); };
let RID = null, AUD = [];
for (let i = 0; i < 80 && AUD.length < 2; i++) { RID = taggedHash('test/h2h-auditor-round', Uint8Array.of(i)); AUD = Array.from({ length: N }, (_, k) => node(k)).filter((nd) => drawn(RID, nd)); }
const UNDRAWN = Array.from({ length: N }, (_, k) => node(k)).find((nd) => !drawn(RID, nd));
// Rock Paper Scissors over two entries: paper (1) against rock (0)
const decide = (moves) => { const [a, b] = moves; const w = (a.move - b.move + 3) % 3;
  return w === 0 ? { [a.key]: VERDICT.DRAW, [b.key]: VERDICT.DRAW } : w === 1 ? { [a.key]: VERDICT.WIN, [b.key]: VERDICT.LOSS } : { [a.key]: VERDICT.LOSS, [b.key]: VERDICT.WIN }; };
const CLOSE = 1_000_000n, WIN = 10_000n, P = 1_015_000;
const entry = (n, move) => { const entryKey = taggedHash('test/key', Uint8Array.of(n)), salt = taggedHash('test/salt', Uint8Array.of(n));
  return { entryId: taggedHash('test/entry', Uint8Array.of(n)), entryKey, commit: headToHeadCommit({ roundId: RID, entryKey, move, salt }), reveal: { move, salt, atMs: CLOSE + 400n } }; };
const CHECK = { roundId: RID, decide, config: null, moveCount: 3, players: 2, entryCloseMs: CLOSE, revealWindowMs: WIN, entries: [entry(1, 1), entry(2, 0)] };
const AGREED = h2hCheck(CHECK).resultsHash;

const auditorFor = (nd, { clock, desk, agreedHash = AGREED }) => new H2hAuditor({
  selfKey: nd.pubkey, prove: (alpha) => vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), alpha), outputOf: (pi) => vrf.proofToHash(pi),
  sign: (d) => schnorr.sign(d, nd.secret), due: () => [{ roundId: RID, closeMs: P + 60_000 }], eligibleFor: () => set,
  dataFor: async () => ({ check: CHECK, agreedHash }),
  // the seat door: POST /h2h-audit hands the body to the desk (server.js), 201 when kept
  post: async (bytes, signature) => { const body = new Uint8Array(bytes.length + 64); body.set(bytes); body.set(signature, bytes.length); const r = await desk.take(body); return r.ok ? 1 : 0; },
  now: () => clock.now });

test('#1412 the auditor service: a drawn node checks the moves and its H2H_AUDIT is taken in time - one keeps 600 s, two make the 60 s window', async () => {
  const clock = { now: P + 8_000 };
  const desk = createH2hAuditDesk({ db: openStore(':memory:'), now: () => clock.now, vrf, verify,
    contextFor: async () => ({ ok: true, eligible: set.eligible, total: set.total, resultsHash: AGREED, provisionalAtMs: P }) });
  const facts = {};
  facts.undrawn = await auditorFor(UNDRAWN, { clock, desk }).pass();
  facts.differs = (await auditorFor(AUD[0], { clock, desk, agreedHash: taggedHash('test/other', Uint8Array.of(9)) }).pass())[0];
  const first = await auditorFor(AUD[0], { clock, desk }).pass();
  facts.first = first[0];
  facts.afterOne = (await desk.windowOf(RID)).window;
  clock.now = P + 20_000;
  facts.second = (await auditorFor(AUD[1], { clock, desk }).pass())[0];
  clock.now = P + 60_000;
  const w = await desk.windowOf(RID);
  facts.window = [w.window, w.final];
  console.log(`  MEASURED #1412 auditor: undrawn ${JSON.stringify(facts.undrawn)}; committee results the moves do not give -> ${JSON.stringify(facts.differs)}; drawn A -> ${JSON.stringify(facts.first)}, window ${facts.afterOne}; drawn B -> ${JSON.stringify(facts.second)}; at +60 s: ${facts.window.join(' ')}`);
  assert.deepEqual(facts.undrawn, []);
  assert.equal(facts.differs.differs, true);
  assert.equal(facts.first.seats, 1);
  assert.equal(facts.afterOne, 'long');
  assert.equal(facts.second.seats, 1);
  assert.deepEqual(facts.window, ['short', true]);
});
