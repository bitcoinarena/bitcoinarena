// kanban #3254: the card's test (audit r20 census-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 census-1 (P5, gap in #1711): POST /seating is public. A stranger reads a round's standing certificate off GET /seating
// (or /seating-batch) and posts it back with one extra junk (nodePubkey, signature) pair, a different one each time. The bytes differ
// from the held ones, so keepCert's "held byte for byte" shortcut misses; it draws the round (roster.committeeFor) and runs verifySeating -
// every seated member's BIP-340 check, 7 of them - and only then canonicalises and finds it holds exactly that seating already.
// One ~1.3 KB request = 7 signature checks on the event loop, without end, per round held.
// SAFE: a copy of the certificate held, padded with signatures of nodes it does not seat, is answered from the held bytes: no signature check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signSeating, encodeSeatingCertificate, decodeSeatingCertificate, seatedFrom } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const START = 60500n;

const setup = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c); const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  let draws = 0;
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: 'http://x' } }));
  const roster = { committeeFor: () => { draws++; return { ok: true, drawn }; } };
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster, sign: (m) => schnorr.sign(m, nodes[0].secret), verify, fetcher: async () => new Response('', { status: 404 }), nowMs: () => Number(START) - 150000 });
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  const signatures = seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role: 'game', seated }, (m) => schnorr.sign(m, nodes.find((n) => toHex(n.pubkey) === toHex(k)).secret)) }));
  const cert = encodeSeatingCertificate({ roundId: rid, role: 'game', seated, signatures });
  assert.deepEqual(agent.keepCert(rid, 'game', cert), { ok: true, kept: true });
  return { agent, rid, cert, seated, signatures, verifies: () => verifies, draws: () => draws };
};

test('wf1489 r20 census-1: padded copies of the held certificate cost no signature check', () => {
  const { agent, rid, seated, signatures, ...w } = setup();
  let v0 = w.verifies(), d0 = w.draws();
  const counts = () => ({ verifies: w.verifies() - v0, draws: w.draws() - d0 });
  const N = 50;
  for (let i = 0; i < N; i++) {
    const junkKey = new Uint8Array(32).fill(0xee); junkKey[0] = i; junkKey[1] = i >> 8;
    const padded = encodeSeatingCertificate({ roundId: rid, role: 'game', seated, signatures: [...signatures, { nodePubkey: junkKey, signature: new Uint8Array(64).fill(i) }] });
    // what server.js POST /seating does with the body
    const d = decodeSeatingCertificate(padded);
    const r = agent.keepCert(d.roundId, d.role, encodeSeatingCertificate(d));
    assert.equal(r.ok, true);
  }
  const { verifies, draws } = counts();
  console.log(`  ${N} stranger POST /seating of padded copies of the held certificate: ${verifies} BIP-340 checks, ${draws} draws`);
  assert.equal(verifies, 0, `${verifies} signature checks (${verifies / N} per request) for copies of the certificate already held`);
});

test('wf1489 r20 census-1: the same superseded certificate posted again and again is not checked again each time', () => {
  const { agent, rid, ...w } = setup();
  // T: nodes 0-5 and 7 - the #1509 move: node 6 withheld, the next reserve in. It replaces the held 0-6 (no entries yet); the 0-6
  // certificate every seat handed out before is now refused as superseded - after its signatures are checked, every time
  const s = [0, 1, 2, 3, 4, 5, 7].map((i) => nodes[i].pubkey);
  const old = encodeSeatingCertificate({ roundId: rid, role: 'game', seated: s,
    signatures: s.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role: 'game', seated: s }, (m) => schnorr.sign(m, nodes.find((n) => toHex(n.pubkey) === toHex(k)).secret)) })) });
  const first = agent.keepCert(rid, 'game', old);
  assert.equal(first.replaced, true, 'the seating that left out the withholder replaces the one held');
  assert.equal(agent.keepCert(rid, 'game', w.cert).ok, false, 'the old one is refused');
  const v0 = w.verifies();
  const N = 50;
  for (let i = 0; i < N; i++) assert.equal(agent.keepCert(rid, 'game', w.cert).ok, false);
  const v = w.verifies() - v0;
  console.log(`  ${N} more POST /seating of that one refused certificate (${w.cert.length} bytes): ${v} BIP-340 checks`);
  assert.equal(v, 0, `${v} signature checks (${v / N} per request) for one refused certificate posted ${N} times`);
});
