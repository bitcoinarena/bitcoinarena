// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit census a5-1-2 (P5, gap in the #3254 fix): keepCert keeps every refused certificate's refusal in `refusedCerts` (up to 20,000) under a key that
// holds the WHOLE canonical certificate as base64 (seating-agent.js:330). The canonical form is the body plus one 96-byte (key, signature) entry per
// seated key - zeros where none was sent - so a POST /seating body of SEATING_CERT_MOST (16,424 bytes) that seats 512 junk keys and carries no
// signature becomes a ~65.6 KB canonical certificate, an ~87 KB key string. verifySeating refuses it ("seats 512, more than the round's 7") and the
// refusal is kept. A stranger posting distinct such bodies for any public round id makes the seat hold 20,000 x ~87 KB = ~1.75 GB.
// SAFE: what a refused certificate leaves in the seat's memory does not grow with the size of the junk it carried (a digest, not the bytes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { encodeSeatingCertificate, decodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const SEATING_CERT_MOST = 36 + 2 + 128 * 32 + 2 + 128 * 96;   // server.js:396, the POST /seating body cap
const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
const START = 60500n;

test('audit census a5-1-2: refused junk certificates do not each leave their whole canonical bytes in the seat\'s memory', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START };
  const bytes = encodeRoundContract(c); const rid = roundIdOf(c);
  db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null) };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: 'http://x' } }));
  const roster = { committeeFor: () => ({ ok: true, drawn }) };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster, sign: (m) => schnorr.sign(m, nodes[0].secret), verify, fetcher: async () => new Response('', { status: 404 }), nowMs: () => Number(START) - 150000 });

  const N = 1000, SEATED = 512;
  const junk = (i) => {
    const seated = Array.from({ length: SEATED }, (_, j) => { const k = new Uint8Array(32).fill(0x11); k[0] = j & 0xff; k[1] = j >> 8; k[2] = i & 0xff; k[3] = i >> 8; return k; });
    return encodeSeatingCertificate({ roundId: rid, role: 'game', seated, signatures: [] });
  };
  assert.ok(junk(0).length <= SEATING_CERT_MOST, `the body is ${junk(0).length} bytes, within the door's ${SEATING_CERT_MOST}`);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  let refused = 0;
  for (let i = 0; i < N; i++) {
    const body = junk(i);
    // what server.js POST /seating does with the body
    const d = decodeSeatingCertificate(body);
    const r = agent.keepCert(d.roundId, d.role, encodeSeatingCertificate(d));
    if (r.ok === false) refused++;
  }
  gc(); gc();
  const grew = process.memoryUsage().heapUsed - before;
  console.log(`  ${N} stranger POST /seating bodies of ${junk(0).length} bytes, ${refused} refused: the heap kept ${(grew / 1e6).toFixed(1)} MB (${Math.round(grew / N)} bytes a refusal); at 20,000 kept: ~${(grew / N * 20000 / 1e9).toFixed(2)} GB`);
  assert.equal(refused, N, 'every junk certificate is refused');
  assert.ok(grew < 16e6, `${N} refused junk certificates left ${(grew / 1e6).toFixed(1)} MB in the seat's heap (${Math.round(grew / N)} bytes each) - the refusal cache keeps each one's whole canonical bytes`);
});
