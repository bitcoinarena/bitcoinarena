// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3 (seating): ONE drawn seat answers GET /seating-batch with thousands of PRESENTs that name a drawn node's key
// and carry junk signatures. The honest seat takes every one of them (takePresent), and since a junk PRESENT names a drawn node of
// the round, the pre-checks pass and each costs a BIP-340 verify - on every tick, because a refused PRESENT is not remembered.
// Safe behaviour: a peer's answer can hand at most one PRESENT per drawn node and role, so one tick's checks are bounded by
// peers x roles x drawn, whatever one seat sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;

test('#1489 r3 census-2: one seat\'s /seating-batch answer of junk PRESENTs costs a signature check each, every tick', async () => {
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
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  // node 8 is offline (no PRESENT anywhere), so the round keeps being asked; seat 1 is the attacker
  const JUNK = 600;
  const junkFor = (role) => Array.from({ length: JUNK }, (_, i) => {
    const good = signPresent({ roundId: rid, role, nodePubkey: nodes[8].pubkey }, signer(nodes[8]));
    const b = Uint8Array.from(good); b[b.length - 1] ^= (i % 255) + 1; b[b.length - 2] ^= (i >> 8) + 1;   // node 8's key, a signature that is not its
    return { role, node: toHex(nodes[8].pubkey), present: toHex(b) };
  });
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/seating-batch') {
      const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
      if (i === 8) return new Response('down', { status: 503 });
      const own = ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey), present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, signer(nodes[i]))) }));
      const presents = i === 1 ? [...own, ...junkFor('game'), ...junkFor('settlement')] : own;
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert: {} } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const agent = seatingAgent({ round, roster, sign: signer(me), verify, fetcher, nowMs: () => NOW });
  await agent.tick();
  const first = verifies;
  await agent.tick();
  const second = verifies - first;
  const bound = 8 * 2 * 9;          // other drawn seats x roles x drawn nodes: at most one PRESENT each
  console.log(`  signature checks: first tick ${first}, second tick ${second} (bound per tick ${bound}); junk sent ${2 * JUNK} per tick by one seat`);
  assert.equal(agent.presentsOf(rid).some((p) => p.node === toHex(nodes[8].pubkey)), false, 'no junk PRESENT is kept');
  assert.ok(first <= bound && second <= bound, `one seat's answer cost ${first} then ${second} signature checks - above the ${bound} a tick can need`);
});
