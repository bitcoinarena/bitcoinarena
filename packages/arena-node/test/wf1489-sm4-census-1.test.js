// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4 census-1: a seating certificate and its effect are two writes. keepCert INSERTs the certificate into seat_certs,
// and only then calls onSeated (server.js: round.seatDrawFree writes the seated 7 into the stored contract and signer_nodes, and
// makeClaimKey runs for them). A seat killed between the two (or whose onSeated threw) holds the certificate but never wrote its
// seated in. After the restart every copy of that certificate is answered `kept: false` (byte for byte held) and onSeated is never
// called again, and nothing at start-up replays it: the round keeps the draw's first 7 as its signer nodes at this seat, while
// every other seat names the certified 7 (a reserve in place of the absent node).
// Safe behaviour: a certificate held whose effect was not applied is applied again (onSeated) after the restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 100000;          // after seating_close (start - 120 s), before the start

test('wf1489 sm4 census-1: a certificate kept before a crash that cut its write-in is applied after the restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wf1489-sm4-c1-')), 'node.db');
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c);
  const rid = roundIdOf(c);
  // node 1 sent no PRESENT: the seated 7 take the first reserve in its place
  const present = nodes.filter((_, i) => i !== 1).map((n) => n.pubkey);
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present, slots: 7 });
  const cert = encodeSeatingCertificate({ roundId: rid, role: 'settlement', seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role: 'settlement', seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const me = nodes[0];
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  // every peer keeps handing out the certificate, as the network does after a restart
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/seating-batch') {
      const i = nodes.findIndex((n) => n.endpoint === `${u.protocol}//${u.host}`);
      const presents = i === 1 ? [] : ['game', 'settlement'].map((role) => ({ role, node: toHex(nodes[i].pubkey),
        present: toHex(signPresent({ roundId: rid, role, nodePubkey: nodes[i].pubkey }, signer(nodes[i]))) }));
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert: { settlement: toHex(cert) } } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const open = (onSeated) => {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE IF NOT EXISTS rounds (round_id BLOB, contract BLOB)');
    if (!db.prepare('SELECT 1 FROM rounds').get()) db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    const round = { db, pubkey: me.pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
    return { db, agent: seatingAgent({ round, roster: { committeeFor: () => ({ ok: true, drawn }) }, sign: signer(me), verify, fetcher, nowMs: () => NOW, onSeated }) };
  };

  // FIRST LIFE: the certificate is kept, and the process dies before the seated are written in (onSeated never completes)
  const a = open(() => { throw new Error('process killed before the write-in'); });
  assert.deepEqual(a.agent.keepCert(rid, 'settlement', cert), { ok: true, kept: true });
  a.db.close();

  // SECOND LIFE: the same store; the peers hand the certificate again on every tick
  const applied = [];
  const b = open((r, role, s) => { applied.push({ rid: toHex(r), role, seated: s.map(toHex) }); });
  await b.agent.tick();
  await b.agent.tick();
  const again = b.agent.keepCert(rid, 'settlement', cert);
  console.log('  after restart: keepCert ->', JSON.stringify(again), '; onSeated calls:', applied.length,
    '; seatedFor:', (b.agent.seatedFor(rid, 'settlement') || []).length, 'nodes');
  b.db.close();
  assert.ok(b.agent.seatedFor(rid, 'settlement'), 'the seat holds the certificate after the restart');
  assert.ok(applied.some((x) => x.rid === toHex(rid) && x.role === 'settlement'),
    'the certificate is held but its seated were never written into the round (onSeated not called again after the restart): '
    + 'this seat keeps the draw\'s first 7 as the round\'s signer nodes while the other seats name the certified 7');
});
