// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 census-3 (P5): POST /seating keeps a certificate whose seated all signed - and every extra (nodePubkey, signature)
// pair it carries. A stranger who reads the seated members' signatures off the public GET /seating-batch builds the certificate
// before the last signer does, pads it with 65,000 junk signature entries (the u16 vec limit, 6.2 MB, under the 8 MB body limit), and posts it to the drawn
// seats: each keeps those bytes as THE certificate (later the honest one is "one seating twice" and refused), serves them at
// GET /seating and /seating-batch (as hex, twice the size) to every peer and to every client join - for a table's first round,
// all day - and the page verifies (decodes, maps) every pair and keys its check cache by the whole hex.
// Safe behaviour: a certificate is kept only in its canonical form (one signature per seated node), or the padded one is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent, signSeating, encodeSeatingCertificate, seatedFrom, seatingId, verifySeating, seatingEquivocation,
  decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const signer = (n) => (m) => schnorr.sign(m, n.secret);
const START = 60500n;
const NOW = Number(START) - 150000;            // inside the PRESENT window, before seating_close (start - 120 s)
// a certificate of the seating every node makes from all nine PRESENTs, signed by its seated - made once per round and role, as on the
// network (each node signs its seating once and keeps that signature, so every peer hands out the same bytes)
const certsMade = new Map();
const certFor = (rid, role) => { const k = `${toHex(rid)}:${role}`; if (!certsMade.has(k)) certsMade.set(k, certOnce(rid, role)); return certsMade.get(k); };
const certOnce = (rid, role) => {
  const seated = seatedFrom({ drawn: nodes.map((n) => n.pubkey), present: nodes.map((n) => n.pubkey), slots: 7 });
  return encodeSeatingCertificate({ roundId: rid, role, seated,
    signatures: seated.map((k) => ({ nodePubkey: k, signature: signSeating({ roundId: rid, role, seated }, signer(nodes.find((n) => toHex(n.pubkey) === toHex(k)))) })) });
};

function world({ withhold = null, leftNode = () => false, now = NOW, servesCert = false } = {}) {
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
      const cert = servesCert ? Object.fromEntries(['game', 'settlement'].map((role) => [role, toHex(certFor(rid, role))])) : {};
      return new Response(JSON.stringify({ rounds: { [toHex(rid)]: { presents, sig: {}, cert } } }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  const agent = seatingAgent({ round, roster, sign: signer(me), verify, fetcher, nowMs: () => now, leftNode });
  return { agent, rid, asked, verifies: () => verifies, drawn };
}

test('wf1489 r5 census-3: a certificate padded with junk signatures is not kept (and served) in its padded form', () => {
  const w = world();
  const canonical = certFor(w.rid, 'game');
  const c = decodeSeatingCertificate(canonical);
  const junk = Array.from({ length: 65000 }, (_, i) => { const k = new Uint8Array(32); k[0] = 0xff; k[1] = i >> 16; k[2] = (i >> 8) & 255; k[3] = i & 255; return { nodePubkey: k, signature: new Uint8Array(64) }; });
  // what POST /seating does: decode the body, encode it again, keepCert
  const padded = encodeSeatingCertificate({ ...c, signatures: [...c.signatures, ...junk] });
  const t0 = Date.now();
  const k = w.agent.keepCert(w.rid, 'game', encodeSeatingCertificate(decodeSeatingCertificate(padded)));
  const ms = Date.now() - t0;
  const served = w.agent.certOf(w.rid, 'game');
  console.log('  MEASURED r5 census-3:', JSON.stringify({ canonicalBytes: canonical.length, postedBytes: padded.length, kept: k, ms, servedHexChars: served ? served.length : 0 }));
  assert.ok(!served || served.length <= canonical.length * 2,
    `the seat keeps and serves a ${padded.length}-byte certificate (${served ? served.length : 0} hex chars at GET /seating) where the seating is ${canonical.length} bytes`);
});
