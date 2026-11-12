// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 (attack): ONE listed seat answers GET /served with rounds it made up - a committee naming any node key and a FINAL "signed" by it
// with 64 zero bytes as the signature. The node bounty checklist (10,000 mainnet sat per node) must not pass on that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { encodeFinalSig, joinSignedFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const FAKE_NODE = '7a'.repeat(32);   // a node key nobody runs: never drawn, never signed anything
const forgedFinal = toHex(joinSignedFinalSig(encodeFinalSig({ roundId: new Uint8Array(32).fill(1), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3),
  signerPubkey: Uint8Array.from(Buffer.from(FAKE_NODE, 'hex')), signedAtMs: NOW - 1000 }), new Uint8Array(64)));
const fetchJson = async (url) => {
  if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
  if (url.startsWith('https://evil.example/served')) return { held: [{ roundId: 'f'.repeat(64), committee: [FAKE_NODE], finals: [forgedFinal] }] };
  return { held: [] };   // the honest seats: this node was never in a committee
};

test('#1489 one seat\'s made-up /served round does not pass the node bounty checklist', async () => {
  const r = await nodeBountyCheck({ node: FAKE_NODE, seats: ['https://seat1.example', 'https://seat2.example', 'https://evil.example'], fetchJson, nowMs: NOW });
  console.log('  MEASURED #1489 forged /served:', JSON.stringify({ passes: r.passes, checks: r.checks.map((c) => [c.key, c.ok, c.says]) }));
  assert.equal(r.passes, false, 'a never-drawn node whose only "rounds" come from one seat with an unverified FINAL must not pass');
});

// the fix's two halves on their own: three seats agreeing on a round whose FINAL is junk do not make it signed; one seat alone with a validly
// signed FINAL (the attacker holds the fresh key) does not make it a committee; three seats with a valid FINAL do
test('#1489 a FINAL counts only with a valid signature, a round only held by three seats', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { signFinalSig } = await import('../../arena-protocol/src/final-sig.js');
  const { fromHex } = await import('../../arena-protocol/src/hash.js');
  const SECRET = new Uint8Array(32).fill(0x2b), NODE = toHex(schnorr.getPublicKey(SECRET)), RID = 'e'.repeat(64);
  const goodFinal = toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));
  const zeroFinal = toHex(joinSignedFinalSig(encodeFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: NOW - 1000 }), new Uint8Array(64)));
  const holding = (holders, finals) => async (url) => (url.endsWith('/owner') ? { node: 'dd'.repeat(32), claimed: false }
    : holders.some((h) => url.startsWith(h)) ? { held: [{ roundId: RID, committee: [NODE, 'cc'.repeat(32), 'c3'.repeat(32)], finals }] } : { held: [] });
  const S = ['https://s1.example', 'https://s2.example', 'https://s3.example'];
  // kanban #1682: the three seats are the committee's three census nodes, each at its own advertised endpoint
  const census = [NODE, 'cc'.repeat(32), 'c3'.repeat(32)].map((node, i) => ({ node, endpoint: S[i], bondSats: '1000000' }));
  const check = (holders, finals) => nodeBountyCheck({ node: NODE, seats: S, fetchJson: holding(holders, finals), nowMs: NOW, census });
  const junk = await check(S, [zeroFinal, NODE]), alone = await check([S[0]], [goodFinal]), good = await check(S, [goodFinal]);
  const says = (r) => r.checks.find((c) => c.key === 'committees').says;
  console.log('  MEASURED #1489 halves:', JSON.stringify({ junk: [junk.passes, says(junk)], alone: [alone.passes, says(alone)], good: [good.passes, says(good)] }));
  assert.equal(junk.passes, false); assert.match(says(junk), /, 0 signed rounds/);
  assert.equal(alone.passes, false); assert.match(says(alone), /^0 committees/);
  assert.equal(good.passes, true); assert.equal(says(good), '7 committees, 7 signed rounds');
});
