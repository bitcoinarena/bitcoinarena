// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (gossip): POST /halt-observations KEEPS ONE CENSUS SEAT'S OBSERVATIONS OF FEDERATIONS NO RECORD NAMES, WITHOUT BOUND.
// halts.take() checks only that the observer is a census seat and that it signed; keep() opens a new map entry for every federation id the
// observation names, and each fresh one rewrites the whole halts file (persist -> save of every observation held). One seat of the census
// signs observations of thousands of invented federation ids - each one with an `answering` list as long as the body limit allows - and
// every seat it posts to keeps them all, in memory and on disk, and rewrites the growing file once per post (quadratic writes).
// Safe behaviour: an observation of a federation this seat holds no record of is not kept, and what one is kept with is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts } from '../src/halts.js';
import { signHaltObservation, encodeHaltObservation } from '../../arena-protocol/src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i & 255, i >> 8))]);
const fid = toHex(taggedHash('TEST/fed', Uint8Array.of(1)));
const record = { federationId: taggedHash('TEST/fed', Uint8Array.of(1)), guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), endpoint: `wss://g${i}` })) };
const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1 } : null) };
const clocks = { abandonBlocks: 10, claimBlocks: 10, drainBlocks: 100 };
const asJson = (o) => ({ observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) });

test('one census seat\'s observations of made-up federations are not kept, and do not grow the halts file', () => {
  const evil = key('evil'), me = key('me');
  let writes = 0, bytesWritten = 0;
  const h = createHalts({ records, censusSeats: () => [me.pub, evil.pub], clocks, verify, sign: (x) => schnorr.sign(x, me.secret), ownKey: me.pub,
    height: async () => 100, ask: async () => 1, save: (v) => { writes++; bytesWritten += JSON.stringify(v).length; } });
  const answering = Array.from({ length: 200 }, (_, i) => peer(i + 10));
  const N = 600;
  let kept = 0;
  const made = [];
  for (let i = 0; i < N; i++) {
    const federationId = taggedHash('TEST/made-up', Uint8Array.of(i & 255, i >> 8));
    made.push(toHex(federationId));
    const o = signHaltObservation({ federationId, session: 1, firstHeight: 1, height: 99, answering, observer: evil.pub }, (x) => schnorr.sign(x, evil.secret));
    const r = h.take(asJson(o));
    if (r.ok && r.kept) kept++;
  }
  const held = made.reduce((n, f) => n + h.list(f).length, 0);
  console.log(`observations of ${N} made-up federations: kept ${kept}, held ${held}; halts file rewritten ${writes} times, ${(bytesWritten / 1e6).toFixed(1)} MB written in all`);
  assert.equal(held, 0, `the seat holds ${held} observations of federations it has no record of`);
});
