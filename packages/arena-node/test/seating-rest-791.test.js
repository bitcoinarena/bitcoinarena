// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT RUNS NO SEATING IS NOT ASKED EVERY TICK (kanban #791, measured 2026-10-30 01:1xZ on second-host seat 3: 1,150 GET /seating and
// /seating-sig a minute to each of two installed nodes drawn into its rounds, every answer 404 "no such door"). seating-agent.js: a node
// whose seating door says it has none rests NO_SEATING_REST_MS; a node that only lacks the batch door is asked the old way, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent, NO_SEATING_REST_MS } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;

/** Node 8 runs no seating (every seating door: 404 "no such door"); node 7 has the single doors but no batch door. */
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const me = nodes[0];
  const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const roster = { committeeFor: () => ({ ok: true, drawn }) };
  const clock = { now: Number(START) - 150000 };     // inside the PRESENT window, before seating_close
  const asked = [];
  const presentsOf = (i) => ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey),
    present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, signer(nodes[i]))) }));
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    asked.push({ i, method: init.method || 'GET', path: u.pathname });
    if (i === 8) return new Response('no such door', { status: 404 });
    if (u.pathname === '/seating-batch' || u.pathname === '/presents') {
      if (i === 7) return new Response('no such door', { status: 404 });
      if (u.pathname === '/presents') return new Response('ok');
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents: presentsOf(i), sig: {}, cert: {} } } }));
    }
    if (u.pathname === '/present' && init.method === 'POST') return new Response('ok');
    if (u.pathname === '/present') return new Response(JSON.stringify({ presents: presentsOf(i) }));
    return new Response('none here', { status: 404 });
  };
  const agent = seatingAgent({ round, roster, sign: signer(me), verify: (s, m, k) => schnorr.verify(s, m, k), fetcher, nowMs: () => clock.now });
  return { agent, asked, clock, rid };
}

test('a node with no seating doors is asked in one tick, then rests until NO_SEATING_REST_MS has passed', async () => {
  const w = world();
  await w.agent.tick();
  assert.ok(w.asked.some((a) => a.i === 8), 'asked in the first tick');
  for (let k = 0; k < 5; k++) { w.asked.length = 0; w.clock.now += 2000; await w.agent.tick(); assert.equal(w.asked.filter((a) => a.i === 8).length, 0, `tick ${k + 2}: not asked`); }
  w.asked.length = 0; w.clock.now += NO_SEATING_REST_MS; await w.agent.tick();
  assert.ok(w.asked.some((a) => a.i === 8), 'asked again after its rest');
});

test('a node without the batch door but with its single doors is asked the old way, its PRESENTs taken, and it is not rested', async () => {
  const w = world();
  await w.agent.tick();
  const seven = w.asked.filter((a) => a.i === 7).map((a) => `${a.method} ${a.path}`);
  assert.ok(seven.includes('GET /present'), `asked the old way: ${seven.join(', ')}`);
  const node7 = toHex(nodes[7].pubkey);
  for (const role of ['game', 'settlement'])
    assert.ok(w.agent.presentsOf(w.rid).some((p) => p.role === role && p.node === node7), `node 7's ${role} PRESENT held`);
  w.asked.length = 0; w.clock.now += 2000; await w.agent.tick();
  assert.ok(w.asked.some((a) => a.i === 7), 'asked again: node 8\'s PRESENTs are still missing, and node 7 is not rested');
});
