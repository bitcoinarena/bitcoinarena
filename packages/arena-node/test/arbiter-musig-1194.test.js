// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARBITRATION SET'S MUSIG2 SESSION ASKS ITS POLICY AT BOTH STEPS (kanban #1194, the state machine audit of 2026-11-06). A coordinator opens a session for a node's
// key-path spend (POST /musig/nonce) while no proof is open against that node; a proof arrives; the coordinator asks for the partial signatures (POST /musig/partial).
// Before: `allow` was asked at the nonce only, and the set signed. Now the session is one state (MUSIG_SESSION open -> signing -> closed, musigSessionStep) and the
// partial asks `allow` again for the very spend the nonce was drawn for; refused, the session closes with no signature and its nonces are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { arbitrationMembers, musigParty, serveArbiter } from '../src/arbiter.js';
import { bondNonceAgg, nonceGen } from '../src/musig2.js';
import { bondInternalKey, bondTapTree } from '../../arena-protocol/src/bond-script.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { combine } from '../src/curve.js';

const set = arbitrationMembers('regtest');
const nodeSecret = taggedHash('ARENA/test/Musig1194', Uint8Array.of(1));
const nodeKey = schnorr.getPublicKey(nodeSecret);
const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
const tweak = bondTapTree({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: 1300, internalKey }, { combine }).tweak;
const msg = new Uint8Array(32).fill(0x5c);
const aggnonceOf = (opened) => toHex(bondNonceAgg({ node: nonceGen({ pk: Uint8Array.from([2, ...nodeKey]), sk: nodeSecret, msg }).pubnonce, members: opened.pubnonces.map((p) => fromHex(p.pubnonce)) }));

test('kanban #1194: a proof that arrives between the nonce and the partial stops the signature', () => {
  const accused = new Set();
  const asked = [];
  const party = musigParty({ set, allow: (s) => { asked.push(toHex(s.nodeKey)); return accused.has(toHex(s.nodeKey)) ? { ok: false, why: 'a slash proof against this node is open or was posted' } : { ok: true }; } });
  const opened = party.nonce({ sessionId: 's1', nodeKey, tweak, msg, spend: { kind: 'release' } });
  assert.equal(opened.ok, true, opened.why);
  // THE PROOF ARRIVES
  accused.add(toHex(nodeKey));
  const signed = party.partial({ sessionId: 's1', aggnonce: aggnonceOf(opened) });
  const facts = { partialOk: signed.ok, psigs: (signed.psigs || []).length, policyAsked: asked.length, why: signed.why };
  console.log('  FACTS (#1194, proof between nonce and partial):', JSON.stringify(facts));
  assert.equal(signed.ok, false, `the set signed although a proof against the node is open now (${signed.psigs && signed.psigs.length} partial signatures)`);
  assert.match(signed.why, /proof against this node/);
  assert.equal(asked.length, 2, 'the policy is asked at the nonce and again at the partial');
  // THE SESSION IS CLOSED: its nonces are gone, a second ask finds nothing, and the same id cannot sign later either
  assert.deepEqual(party.partial({ sessionId: 's1', aggnonce: aggnonceOf(opened) }), { ok: false, why: 'no such session' });
  accused.clear();
  assert.deepEqual(party.partial({ sessionId: 's1', aggnonce: aggnonceOf(opened) }), { ok: false, why: 'no such session' });
});

test('kanban #1194: an allowed session still signs once, and the policy gets the same spend at both steps', () => {
  const seen = [];
  const party = musigParty({ set, allow: (s) => { seen.push(JSON.stringify({ node: toHex(s.nodeKey), msg: toHex(s.msg), spend: s.spend })); return { ok: true }; } });
  const opened = party.nonce({ sessionId: 's2', nodeKey, tweak, msg, spend: { kind: 'release', txid: 'ab' } });
  const signed = party.partial({ sessionId: 's2', aggnonce: aggnonceOf(opened) });
  assert.equal(signed.ok, true, signed.why);
  assert.equal(signed.psigs.length, 7);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'the partial is judged on what the nonce was drawn for');
  assert.deepEqual(party.partial({ sessionId: 's2', aggnonce: aggnonceOf(opened) }), { ok: false, why: 'no such session' });
  // A policy that throws at the partial refuses too, and closes the session
  let calls = 0;
  const shaky = musigParty({ set, allow: () => { calls += 1; if (calls > 1) throw new Error('the state file did not read'); return { ok: true }; } });
  const o = shaky.nonce({ sessionId: 's3', nodeKey, tweak, msg });
  const r = shaky.partial({ sessionId: 's3', aggnonce: aggnonceOf(o) });
  assert.equal(r.ok, false);
  assert.match(r.why, /policy/);
  assert.deepEqual(shaky.partial({ sessionId: 's3', aggnonce: aggnonceOf(o) }), { ok: false, why: 'no such session' });
});

test('kanban #1194: over the doors, POST /musig/partial answers 409 once the node is accused', async () => {
  let accused = false;
  const arb = await serveArbiter({ set, allow: () => (accused ? { ok: false, why: 'a slash proof against this node is open or was posted' } : { ok: true }) });
  try {
    const A = `http://127.0.0.1:${arb.port}`;
    const post = (p, body) => fetch(`${A}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const opened = await (await post('/musig/nonce', { sessionId: 'd1', nodeKey: toHex(nodeKey), tweak: toHex(tweak), msg: toHex(msg) })).json();
    assert.equal(opened.ok, true, opened.why);
    accused = true;
    const r = await post('/musig/partial', { sessionId: 'd1', aggnonce: aggnonceOf(opened) });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.psigs, undefined);
  } finally { await arb.close(); }
});
