// kanban #3292 (audit gossip a5-1-1): the card's test
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

// AUDIT gossip a5-1 #1 (gap in #3046's fix): the fix refuses only an observation past this seat's tip + HALT_TIP_SLACK (144). One census seat
// still signs the halted session with first_height = tip + 144 - abandon_blocks, and re-signs it each block (keep() takes the higher height):
// haltProof takes the LATEST first_height, so the proven halt height rides ahead of the tip and the claim window never opens.
test('one census seat re-signing the halted session just under the tip slack does not move the halt height ahead of the chain', async () => {
  const world = { tip: 330, session: 40, down: new Set(), posted: [] };
  const honest = seats.slice(0, 5).map((s) => seatOf(s, world));
  for (const h of honest) await h.observe();
  world.session = 41; world.tip = 341; world.down = new Set([2, 3]);
  for (const h of honest) await h.observe();
  world.tip = 351;
  for (const h of honest) await h.observe();
  const me = honest[0];
  for (const o of world.posted.slice(1)) assert.equal(me.take(o).ok, true);
  assert.equal(me.proofOf(fid).haltHeight, 341);
  const bad = seats[5];
  const post = async (tip) => {
    world.tip = tip;
    await me.refreshTip();
    const height = tip + 144, firstHeight = height - clocks.abandonBlocks;
    const o = signHaltObservation({ federationId: record.federationId, session: 41, firstHeight, height, answering: [peer(0), peer(1)], observer: bad.pub },
      (h) => schnorr.sign(h, bad.secret));
    return me.take({ observation: toHex(encodeHaltObservation(o)), signature: toHex(o.signature) });
  };
  const seen = [];
  for (const tip of [351, 400, 600]) {
    const r = await post(tip);
    const p = me.proofOf(fid);
    const l = createLiquidations({ records, clocks, verify, halts: me }).list();
    seen.push({ tip, took: r.ok, haltHeight: p && p.haltHeight, liquidatesAt: l[0] && l[0].liquidatesAt });
  }
  for (const s of seen) {
    assert.equal(s.haltHeight, 341, `halt height is the honest 341, not one seat's word: ${JSON.stringify(seen)}`);
    assert.equal(s.liquidatesAt, 351, `liquidatesAt ${JSON.stringify(seen)}`);
  }
});
