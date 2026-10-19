// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATING AGENT ASKS ONLY WHAT IT LACKS, AND DOES NOT CHECK A HELD CERTIFICATE AGAIN (2026-10-12: "figure out why
// CPU usage so high and optimise it"; "Write unit tests"). Measured on seat 3 before: GET /seating-batch 88 times in 30 s,
// 14.3 MB of JSON - every round of the window asked of every drawn node each tick; and every repeated certificate verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;            // inside the PRESENT window, before seating_close (start - 120 s)

function world({ withhold = null, leftNode = () => false } = {}) {
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
  const asked = [];
  // each peer answers with the PRESENTs it signed, for both roles - except a withheld one
  const fetcher = async (url, init = {}) => {
    asked.push(`${init.method || 'GET'} ${url.replace(/\?.*$/, '')}`);
    const u = new URL(url);
    if (u.pathname === '/seating-batch') {
      const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
      const presents = withhold === i ? [] : ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey),
        present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, signer(nodes[i]))) }));
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert: {} } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const agent = seatingAgent({ round, roster, sign: signer(me), verify, fetcher, nowMs: () => NOW, leftNode });
  return { agent, rid, asked, verifies: () => verifies, drawn };
}

test('a round whose PRESENTs from every drawn node are held is not asked again before its close', async () => {
  const w = world();
  await w.agent.tick();
  const first = w.asked.filter((a) => a.startsWith('GET') && a.endsWith('/seating-batch')).length;
  assert.equal(first, 8, 'the first tick asks each of the 8 other drawn nodes');
  for (const role of ['game', 'settlement']) assert.equal(w.agent.presentsOf(w.rid).filter((p) => p.role === role).length, 9, `all 9 ${role} PRESENTs held`);
  w.asked.length = 0;
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 0, 'nothing is asked once every PRESENT is held');
});

test('a round still missing a drawn node\'s PRESENT keeps being asked', async () => {
  const w = world({ withhold: 5 });
  await w.agent.tick();
  w.asked.length = 0;
  await w.agent.tick();
  assert.equal(w.asked.filter((a) => a.endsWith('/seating-batch')).length, 8, 'node 5 has not said it is present: the round is asked again');
});

test('a certificate held byte for byte is not verified again', () => {
  const w = world();
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const cert = encodeSeatingCertificate({ roundId: w.rid, role: 'game', seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: w.rid, role: 'game', seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  const before = w.verifies();
  assert.deepEqual(w.agent.keepCert(w.rid, 'game', cert), { ok: true, kept: true });
  const once = w.verifies() - before;
  assert.ok(once >= 7, `the first copy is checked: ${once} signature checks`);
  assert.deepEqual(w.agent.keepCert(w.rid, 'game', cert), { ok: true, kept: false });
  assert.equal(w.verifies() - before, once, 'the same bytes again cost no signature check');
});

test('a node its owner took out with the emergency key (§23A.5a, protocol 17) is in no seating: its PRESENT is not counted, and it signs none itself', async () => {
  const gone = toHex(nodes[5].pubkey);
  const w = world({ leftNode: (hex) => hex === gone });
  await w.agent.tick();
  for (const role of ['game', 'settlement']) {
    const held = w.agent.presentsOf(w.rid).filter((p) => p.role === role);
    assert.deepEqual([held.length, held.some((p) => p.node === gone)], [8, false], `${role}: 8 PRESENTs, none from the node that left`);
  }
  const me = toHex(nodes[0].pubkey);
  const back = world({ leftNode: (hex) => hex === me });
  await back.agent.tick();
  assert.equal(back.agent.presentsOf(back.rid).some((p) => p.node === me), false, 'the owner\'s node, back online, says PRESENT for nothing');
});
