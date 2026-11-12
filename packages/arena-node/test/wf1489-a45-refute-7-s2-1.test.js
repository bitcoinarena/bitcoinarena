// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1819 (skeptic 2): the RELOAD path. take() now refuses observations of federations this seat holds no record of,
// but load() at start keeps every stored observation unchecked. A halts file written by a pre-#1819 build (the attack ran there: 600
// made-up federations) is held again after the upgrade and rewritten on every later persist - the junk never leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts } from '../src/halts.js';
import { signHaltObservation, encodeHaltObservation } from '../../arena-protocol/src/halt-proof.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i & 255, i >> 8))]);
const fidB = taggedHash('TEST/fed', Uint8Array.of(1)); const fid = toHex(fidB);
const record = { federationId: fidB, guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), endpoint: `wss://g${i}` })) };
const clocks = { abandonBlocks: 10, claimBlocks: 10, drainBlocks: 100 };
const asJson = (o) => ({ observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) });
const evil = key('evil'), me = key('me'), honest = key('honest'), stranger = key('stranger');

test('a halts file from before #1819 holding observations of made-up federations is not held again after a restart', () => {
  const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1 } : null) };
  const answering = Array.from({ length: 200 }, (_, i) => peer(i + 10));
  const made = []; const observations = [];
  for (let i = 0; i < 300; i++) {
    const federationId = taggedHash('TEST/made-up', Uint8Array.of(i & 255, i >> 8)); made.push(toHex(federationId));
    observations.push(asJson(signHaltObservation({ federationId, session: 1, firstHeight: 1, height: 99, answering, observer: evil.pub }, (x) => schnorr.sign(x, evil.secret))));
  }
  let lastSaved = null;
  const h = createHalts({ records, censusSeats: () => [me.pub, evil.pub, honest.pub], clocks, verify, sign: (x) => schnorr.sign(x, me.secret), ownKey: me.pub,
    height: async () => 100, ask: async () => 1, load: () => ({ observations, seen: {} }), save: (v) => { lastSaved = v; } });
  const held = made.reduce((n, f) => n + h.list(f).length, 0);
  // one honest change after the restart rewrites the file: what does it carry?
  const o = signHaltObservation({ federationId: fidB, session: 1, firstHeight: 1, height: 99, answering: record.guardians.map((g) => g.peerKey), observer: honest.pub }, (x) => schnorr.sign(x, honest.secret));
  assert.equal(h.take(asJson(o)).status, 201);
  const carried = lastSaved.observations.length - 1;
  console.log(`after restart: held ${held} stored observations of made-up federations; the next save carries ${carried} of them (${(JSON.stringify(lastSaved).length / 1e6).toFixed(2)} MB)`);
  assert.equal(held, 0, `the seat holds ${held} observations of federations it has no record of, read back from its halts file`);
});

test('honest path and peer/stranger/retry variants (expected to pass)', () => {
  let rec = null;
  const records = { list: () => (rec ? [{ federation: fid }] : []), recordOf: (f) => (rec && f === fid ? { record: rec, status: 'CRITICAL', height: 1 } : null) };
  let writes = 0;
  const h = createHalts({ records, censusSeats: () => [me.pub, honest.pub], clocks, verify, sign: (x) => schnorr.sign(x, me.secret), ownKey: me.pub,
    height: async () => 100, ask: async () => 1, save: () => { writes++; } });
  const ans = record.guardians.map((g) => g.peerKey);
  const mk = (who, extra = {}) => asJson(signHaltObservation({ federationId: fidB, session: 1, firstHeight: 1, height: 99, answering: ans, observer: who.pub, ...extra }, (x) => schnorr.sign(x, who.secret)));
  // before the record: refused; retried after the record arrives: taken
  assert.equal(h.take(mk(honest)).status, 409);
  rec = record;
  assert.equal(h.take(mk(honest)).status, 201);
  // retry of the same: 200, no rewrite
  const w = writes; assert.equal(h.take(mk(honest)).status, 200); assert.equal(writes, w);
  // a stranger (not in the census), even of a held federation: refused
  assert.equal(h.take(mk(stranger)).status, 409);
  // a stranger naming a census seat as observer with its own signature: refused
  const forged = signHaltObservation({ federationId: fidB, session: 1, firstHeight: 1, height: 99, answering: ans, observer: honest.pub }, (x) => schnorr.sign(x, stranger.secret));
  assert.equal(h.take(asJson(forged)).status, 409);
  // upper-case hex federation in the body decodes to the same bytes: still checked against the record
  const up = mk(honest, { height: 100 }); assert.equal(h.take({ observation: up.observation.toUpperCase(), signature: up.signature.toUpperCase() }).status, 201);
  // an over-long answering list of a held federation: refused
  assert.equal(h.take(mk(honest, { height: 101, answering: Array.from({ length: 5 }, (_, i) => peer(i)) })).status, 409);
  assert.equal(h.list(fid).length, 1);
});
