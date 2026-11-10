// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1412 (§13A.1, RULED #1400): a seat's desk for head-to-head audits - an H2H_AUDIT taken only when it stands and arrived inside the 60 s
// window, kept across a restart, and the window the seat applies: 60 s with two distinct auditors over its results, else 600 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createH2hAuditDesk } from '../src/h2h-audit-desk.js';
import { makeVrf, SUITE_SECP256K1_TAI } from '../../arena-protocol/src/vrf.js';
import { auditAlpha, vrfSecretFor, auditEligible } from '../../arena-protocol/src/auditor.js';
import { isH2hAuditor, encodeH2hAudit, h2hAuditId } from '../../arena-protocol/src/h2h-audit.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { secp256k1, schnorr } = await import('@noble/curves/secp256k1.js');
const vrf = makeVrf({ Point: secp256k1.Point, suite: SUITE_SECP256K1_TAI });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };
const node = (i) => { const secret = taggedHash('test/h2h-desk-node', Uint8Array.of(i >> 8, i & 255)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const N = 40, BOND_MIN = 50_000n;
const census = Array.from({ length: N }, (_, i) => ({ pubkey: node(i).pubkey, roles: ['audit'], bondSats: BOND_MIN, operatorId: `op${i}` }));
const { eligible, total } = auditEligible({ entries: census, bondMinSats: BOND_MIN });
const drawnFor = (rid) => Array.from({ length: N }, (_, i) => node(i)).filter((nd) => {
  const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(rid)); return isH2hAuditor({ beta: vrf.proofToHash(pi), weight: eligible.get(toHex(nd.pubkey)), total }); });
let RID = null, DRAWN = [];
for (let i = 0; i < 80 && DRAWN.length < 3; i++) { RID = taggedHash('test/h2h-desk-round', Uint8Array.of(i)); DRAWN = drawnFor(RID); }
const RESULTS = taggedHash('test/h2h-desk-results', Uint8Array.of(1));
const P = 1_000_000;
const posted = (nd, { resultsHash = RESULTS, atMs = BigInt(P + 5000) } = {}) => {
  const pi = vrf.prove(vrfSecretFor(nd.secret, secp256k1.Point), auditAlpha(RID));
  const a = { roundId: RID, resultsHash, nodePubkey: nd.pubkey, atMs, beta: vrf.proofToHash(pi), vrfProof: pi };
  const bytes = encodeH2hAudit(a), sig = schnorr.sign(h2hAuditId(a), nd.secret);
  const body = new Uint8Array(bytes.length + 64); body.set(bytes); body.set(sig, bytes.length); return body; };

test('#1412 the seat desk: two drawn auditors in time -> the 60 s window; refused after it, from an undrawn node, over other results; kept over a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'h2hdesk-')), 'seat.db');
  const clock = { now: P + 10_000 };
  const ctx = { ok: true, eligible, total, resultsHash: RESULTS, provisionalAtMs: P };
  const desk = createH2hAuditDesk({ db: openStore(file).db || openStore(file), now: () => clock.now, contextFor: async () => ctx, vrf, verify });
  const undrawn = Array.from({ length: N }, (_, i) => node(i)).find((x) => !DRAWN.some((d) => toHex(d.pubkey) === toHex(x.pubkey)));
  const facts = {};
  facts.first = (await desk.take(posted(DRAWN[0]))).kept;
  facts.windowAfterOne = (await desk.windowOf(RID)).window;
  facts.undrawn = (await desk.take(posted(undrawn))).why;
  facts.otherResults = (await desk.take(posted(DRAWN[1], { resultsHash: taggedHash('test/other', Uint8Array.of(2)) }))).why;
  facts.second = (await desk.take(posted(DRAWN[1]))).kept;
  clock.now = P + 60_000;
  const w = await desk.windowOf(RID);
  facts.window = [w.window, w.final];
  clock.now = P + 61_000;
  facts.late = (await desk.take(posted(DRAWN[2]))).why;
  const again = createH2hAuditDesk({ db: openStore(file).db || openStore(file), now: () => clock.now, contextFor: async () => ctx, vrf, verify });
  facts.afterRestart = again.held(RID).length;
  console.log('  MEASURED #1412 desk:', JSON.stringify(facts));
  assert.equal(facts.first, true);
  assert.equal(facts.windowAfterOne, 'long');
  assert.match(facts.undrawn, /not drawn/);
  assert.match(facts.otherResults, /other results/);
  assert.equal(facts.second, true);
  assert.deepEqual(facts.window, ['short', true]);
  assert.match(facts.late, /60 s window has closed/);
  assert.equal(facts.afterRestart, 2);
});
