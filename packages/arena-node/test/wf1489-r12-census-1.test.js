// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r12 census-1: ONE DRAWN SEAT'S MALFORMED GET /seating-batch ANSWER STOPS EVERY HONEST SEAT FROM CERTIFYING. The tick reads
// every drawn node's batch answer and, per round and role, runs fromHex(cert) (and x.role / fromHex(x.present)) on it OUTSIDE any
// try: one drawn node answering `cert: { game: 'abc' }` (odd-length hex) throws out of the loop BEFORE certify(w) is reached, the
// tick's catch logs it, and the next tick does the same. Every honest seat reads that node (it is drawn), so no seat ever builds
// the certificate - the round is never seated and takes no entry (§5A.7), and every (round, role) after it in the tick is skipped too.
// SAFE: a malformed answer is that one peer's answer only - the 8 honest seats certify the seating of the 7 present as they do without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;

function net(badAnswer) {
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const w = { now: NOW, rid, agents: new Map(), logs: new Map() };
  const fetcherOf = () => async (url, init = {}) => {
    const u = new URL(url);
    const to = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
    if (to === 8) {   // THE ONE BAD DRAWN SEAT (role b): takes what it is sent, answers its batch door malformed
      if (u.pathname === '/seating-batch') return new Response(JSON.stringify({ rounds: Object.fromEntries(u.searchParams.get('rounds').split(',').map((r) => [r, badAnswer])) }), { status: 200 });
      return new Response('{}', { status: 201 });
    }
    const a = w.agents.get(to);
    if (u.pathname === '/presents') { const r = a.takePresents(new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 400 }); }
    if (u.pathname === '/seating-batch') return new Response(JSON.stringify(a.batchOf(u.searchParams.get('rounds').split(','))), { status: 200 });
    if (u.pathname === '/seating') { const b = new Uint8Array(await new Response(init.body).arrayBuffer()); const r = a.keepCert(rid, decodeSeatingCertificate(b).role, b); return new Response(JSON.stringify(r), { status: r.ok ? 201 : 409 }); }
    return new Response('no', { status: 404 });
  };
  for (let i = 0; i < 8; i++) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const round = { db, pubkey: nodes[i].pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    const logs = []; w.logs.set(i, logs);
    w.agents.set(i, seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(nodes[i]), fetcher: fetcherOf(i), nowMs: () => w.now,
      verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } }, log: (l) => logs.push(l) }));
  }
  w.tickAll = async (times) => { for (let k = 0; k < times; k++) for (const a of w.agents.values()) await a.tick(); };
  return w;
}

test('one drawn seat answering its /seating-batch with an odd-length certificate hex does not stop the 8 honest seats certifying', async () => {
  const w = net({ presents: [], sig: {}, cert: { game: 'abc', settlement: 'abc' } });
  await w.tickAll(2);
  w.now = Number(START - 120000n) + 1000;      // the seating has closed
  await w.tickAll(5);
  const missing = [];
  for (const role of ['game', 'settlement']) for (const i of w.agents.keys()) if (!w.agents.get(i).certOf(w.rid, role)) missing.push(`${role}@${i}`);
  assert.deepEqual(missing, [], `every honest seat holds both certificates; seat 0's tick log: ${w.logs.get(0).filter((l) => !/PRESENT signed/.test(l)).slice(-3).join(' | ')}`);
});

test('control: with the bad seat answering nothing, the 8 honest seats certify', async () => {
  const w = net(null);
  await w.tickAll(2);
  w.now = Number(START - 120000n) + 1000;
  await w.tickAll(5);
  for (const role of ['game', 'settlement']) for (const i of w.agents.keys()) assert.ok(w.agents.get(i).certOf(w.rid, role), `${role}@${i}`);
});
