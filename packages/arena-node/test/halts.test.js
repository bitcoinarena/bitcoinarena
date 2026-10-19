// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HALT OBSERVED AND PROVEN BY THE SEATS (spec §23A.5 "How a halt is proven", RULED 2026-10-14), the seat's part:
// rehearsal 17's federation of four - g2 and g3 gone at session 41 - observed by five of nine census seats, and the liquidation
// listed from the proof alone (no HALTED record exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createHalts, wsSessionCount } from '../src/halts.js';
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

function seatOf(s, world) {
  return createHalts({ records, censusSeats: () => seats.map((x) => x.pub), clocks, verify, sign: (h) => schnorr.sign(h, s.secret), ownKey: s.pub,
    height: async () => world.tip, ask: async (ep) => { const i = Number(ep.slice(-1)); if (world.down.has(i)) throw new Error('down'); return world.session; },
    post: async (o) => { world.posted.push(o); } });
}

test('each seat signs once the last session has not moved for abandon_blocks; five of nine prove the halt; the liquidation lists it', async () => {
  const world = { tip: 330, session: 40, down: new Set(), posted: [] };
  const all = seats.map((s) => seatOf(s, world));
  for (const h of all) await h.observe();                  // session 40 seen at 330
  world.session = 41; world.tip = 341; world.down = new Set([2, 3]);
  for (const h of all) await h.observe();                  // 41 first seen at 341, g2 and g3 gone
  world.tip = 350;
  for (const h of all) assert.equal((await h.observe())[0].signed, undefined, '9 blocks of no progress: nothing signed');
  world.tip = 351;
  const rows = [];
  for (const h of all.slice(0, 5)) rows.push((await h.observe())[0]);
  assert.deepEqual(rows.map((r) => [r.session, r.firstHeight, r.answering, r.signed]), Array(5).fill([41, 341, 2, true]));
  // seat 0 takes the four others' observations as its peers post them
  const me = all[0];
  for (const o of world.posted.slice(1, 5)) assert.equal(me.take(o).ok, true);
  const p = me.proofOf(fid);
  assert.ok(p, 'five of nine at session 41 for abandon_blocks: the halt stands');
  assert.deepEqual([p.session, p.haltHeight, p.observers, p.abandoned.length, p.answered.length], [41, 341, 5, 2, 2]);
  const liq = createLiquidations({ records, clocks, verify, halts: me });
  const l = liq.list();
  assert.equal(l.length, 1);
  assert.deepEqual([l[0].haltHeight, l[0].haltRecord, l[0].haltProof.session, l[0].haltProof.abandoned.length, l[0].liquidatesAt], [341, null, 41, 2, 351]);
});

test('a stranger, a forged observation and a later session do not make or keep a halt', async () => {
  const world = { tip: 341, session: 41, down: new Set(), posted: [] };
  const me = seatOf(seats[0], world);
  await me.observe(); world.tip = 352; await me.observe();
  const stranger = key('stranger');
  const odd = createHalts({ records, censusSeats: () => [stranger.pub], clocks, verify, sign: (h) => schnorr.sign(h, stranger.secret), ownKey: stranger.pub,
    height: async () => world.tip, ask: async () => 41, post: async (o) => world.posted.push(o) });
  await odd.observe(); world.tip = 363; await odd.observe();
  assert.equal(world.posted.length, 2, "the seat and the stranger each signed once");
  const r = me.take(world.posted[world.posted.length - 1]);
  assert.equal(r.ok, false); assert.match(r.why, /not an active seat/);
  const forged = { ...world.posted[0], signature: '00'.repeat(64) };
  assert.match(me.take(forged).why, /not signed by its seat/);
  assert.equal(me.proofOf(fid), null, 'one seat alone proves nothing');
});

test('a guardian session count is asked over its endpoint, a local override taken first', async () => {
  const opened = [];
  class FakeWS { constructor(u) { opened.push(u); this.h = {}; setTimeout(() => this.h.open(), 1); }
    on(e, f) { this.h[e] = f; } send(m) { const j = JSON.parse(m); setTimeout(() => this.h.message(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: 5078 })), 1); } close() {} }
  const n = await wsSessionCount('wss://test-host.example/guardian-1', { overrides: 'wss://test-host.example/guardian-1=ws://127.0.0.1:32221/', WebSocketImpl: FakeWS });
  assert.equal(n, 5078); assert.deepEqual(opened, ['ws://127.0.0.1:32221/']);
  await assert.rejects(wsSessionCount('', { WebSocketImpl: FakeWS }), /no guardian endpoint/);
});
