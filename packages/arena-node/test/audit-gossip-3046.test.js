// kanban #3046: the card's test
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip r4-1 #1: ONE CENSUS SEAT'S HALT OBSERVATION MOVES THE PROVEN HALT HEIGHT ANYWHERE.
// A halt observation's first_height and height are the observer's own word (halt-proof.js: only u32 and height - first >= abandon_blocks),
// POST /halt-observations (halts.js take) checks neither against this seat's chain, and haltProof takes the LATEST first_height of the set.
// So one census seat that signs the halted session with first_height near 2^32 sets the federation's halt height, and with it
// GET /liquidations' liquidatesAt / claim window, for every seat that takes it - five honest observations at 341 notwithstanding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts } from '../src/halts.js';
import { signHaltObservation, encodeHaltObservation } from '../../arena-protocol/src/halt-proof.js';
import { createLiquidations } from '../src/liquidations.js';

const key = (s) => { const secret = taggedHash('TEST/halt', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, msg, pub) => { try { return schnorr.verify(sig, msg, pub); } catch { return false; } };
const seats = Array.from({ length: 9 }, (_, i) => key(`seat${i}`));
const peer = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const fid = toHex(taggedHash('TEST/fed', Uint8Array.of(1)));
const record = { federationId: taggedHash('TEST/fed', Uint8Array.of(1)), guardians: [0, 1, 2, 3].map((i) => ({ peerKey: peer(i), endpoint: `wss://g${i}` })) };
const records = { list: () => [{ federation: fid }], recordOf: (f) => (f === fid ? { record, status: 'CRITICAL', height: 1 } : null),
  haltOf: () => null, haltedFederations: () => [] };
const clocks = { abandonBlocks: 10, claimBlocks: 10, drainBlocks: 100 };
const seatOf = (s, world) => createHalts({ records, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, s.secret), ownKey: s.pub,
  height: async () => world.tip, ask: async (ep) => { const i = Number(ep.slice(-1)); if (world.down.has(i)) throw new Error('down'); return world.session; },
  post: async (o) => { world.posted.push(o); } });

test('one census seat signing the halted session with a made-up first_height does not move the halt height', async () => {
  const world = { tip: 330, session: 40, down: new Set(), posted: [] };
  const honest = seats.slice(0, 5).map((s) => seatOf(s, world));
  for (const h of honest) await h.observe();
  world.session = 41; world.tip = 341; world.down = new Set([2, 3]);
  for (const h of honest) await h.observe();           // session 41 first seen at 341
  world.tip = 351;
  for (const h of honest) await h.observe();           // each of the five signs (41, 341, 351)
  const me = honest[0];
  for (const o of world.posted.slice(1)) assert.equal(me.take(o).ok, true);
  const before = me.proofOf(fid);
  assert.ok(before, 'five honest seats of nine prove the halt');
  assert.equal(before.haltHeight, 341);

  // seat 5, a bonded census seat, signs the same session with first_height far past any chain tip
  const bad = seats[5];
  const o = signHaltObservation({ federationId: record.federationId, session: 41, firstHeight: 0xffffffff - 10, height: 0xffffffff,
    answering: [peer(0), peer(1)], observer: bad.pub }, (h) => schnorr.sign(h, bad.secret));
  const said = { observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) };
  const r = me.take(said);                              // POST /halt-observations, as any peer posts it

  const p = me.proofOf(fid);
  assert.ok(p, 'the halt still stands');
  assert.equal(p.haltHeight, 341, `the halt height is what the honest observers saw (341), not one seat's word - took=${JSON.stringify(r)}, haltHeight=${p.haltHeight}`);
  const l = createLiquidations({ records, clocks, verify, halts: me }).list();
  assert.equal(l[0].liquidatesAt, 351, `liquidatesAt ${l[0].liquidatesAt}`);
});
