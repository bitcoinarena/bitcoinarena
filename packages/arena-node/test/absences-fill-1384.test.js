// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1384 (audit 2 #1204 FED-B4): 4096 self-signed attestations from random keys filled every seat, and a real guardian's first one was refused
// ("this seat holds as many attestations as it keeps") - a dead guardian was never proven ABANDONED. Now an attestation (or a departure notice) about a
// federation whose record the seat holds is taken only from that record's guardians about its peers, bounded per federation; one about a federation it
// holds no record of goes into a small bucket of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createAbsences } from '../src/absences.js';
import { signAbsence, signDeparture } from '../../arena-protocol/src/absence.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const sk = new Uint8Array(32); sk[0] = (n >> 8) & 255; sk[1] = n & 255; sk[31] = 7; return { sk, pk: schnorr.getPublicKey(sk) }; };
const peer = (n) => Uint8Array.from([2, ...new Uint8Array(32).fill(n)]);
const FED = new Uint8Array(32).fill(0xf1), OTHER = new Uint8Array(32).fill(0xf2);
const G = [1, 2, 3, 4].map((n) => ({ ...key(1000 + n), peer: peer(n) }));
const RECORD = { [toHex(FED)]: G };
const book = (o = {}) => createAbsences({ verify, max: 4096, ...o,
  nodeOf: (fid, p) => { const g = (RECORD[fid] || []).find((x) => toHex(x.peer) === p); return g ? toHex(g.pk) : null; },
  guardiansOf: (fid) => (RECORD[fid] ? RECORD[fid].map((x) => toHex(x.pk)) : null) });
const attest = (signer, federationId, peerKey, h = 900) => signAbsence({ federationId, peerKey, lastSeenHeight: h - 300, height: h, attester: signer.pk }, (m) => schnorr.sign(m, signer.sk));

test('#1384 4096 attestations from random keys do not crowd out a real guardian of a held record; a stranger is refused by name', () => {
  const b = book();
  let refused = 0;
  for (let i = 0; i < 4096; i++) { const r = b.offer(attest(key(i + 1), i % 2 ? FED : OTHER, peer(200))); if (!r.ok) refused++; }
  const real = b.offer(attest(G[1], FED, G[0].peer));
  console.log(`  MEASURED #1384: 4096 junk offers, ${refused} refused, then a guardian's: ${JSON.stringify(real)}`);
  assert.deepEqual(real, { ok: true, kept: true }, 'the real guardian\'s attestation was refused');
  const stranger = b.offer(attest(key(9999), FED, G[0].peer));
  assert.match(stranger.why, /no guardian of the federation record this seat holds/);
  const notPeer = b.offer(attest(G[2], FED, peer(77)));
  assert.match(notPeer.why, /about a peer the federation record this seat holds does not name/);
  assert.ok(refused >= 4096 - 512, 'the unknown-federation bucket took more than its 512');
});

test('#1384 departure notices: about a held record only from the guardian it names; junk about unknown federations stays in its own bucket', () => {
  const b = book();
  const notice = (signer, federationId, peerKey, postedAt = 900) => signDeparture({ federationId, peerKey, leaveAfterHeight: postedAt + 432, postedAt, nodePubkey: signer.pk }, (m) => schnorr.sign(m, signer.sk));
  for (let i = 0; i < 600; i++) b.offerDeparture(notice(key(i + 1), OTHER, peer(i % 250)));
  assert.deepEqual(b.offerDeparture(notice(G[3], FED, G[3].peer)), { ok: true, kept: true }, 'the leaving guardian\'s notice was refused');
  assert.match(b.offerDeparture(notice(key(4242), FED, peer(99))).why, /does not name/);
});

test('#1384 without a record lookup (the old wiring) the book behaves as before', () => {
  const b = createAbsences({ verify, max: 3 });
  for (let i = 0; i < 3; i++) assert.equal(b.offer(attest(key(i + 1), FED, peer(1))).ok, true);
  assert.match(b.offer(attest(key(50), FED, peer(1))).why, /as many attestations as it keeps/);
});
