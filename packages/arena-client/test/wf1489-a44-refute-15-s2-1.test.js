// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute of #1618 (skeptic 2): ZAPS_ROWS_PER_SEAT reads a seat's /donations list only to its first 200 rows, but
// the seats list a key's rows OLDEST FIRST (round.js donationsFor ORDER BY verified_ms) and never delete them for a player's key (the
// page sends no /donations/read receipt; only the developer's donor does). So once a key has 200 rows at the seats - 200 zaps or
// 'website' referral payouts collected long ago, or 200 one-msat dust zaps a stranger sent - every later zap sits past row 200 at
// every honest seat and is never collected. Before #1618 every row was read and the new zap was collected on the next pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const F = 'fe'.repeat(32);
const op = (i) => `${(i + 1).toString(16).padStart(64, '0')}:0`;

async function run(rows, passes) {
  const storage = mem(); storage.setItem('arena.player.seed', 'ab'.repeat(32));
  const keep = mem();
  const spentAlready = new Set();
  // the federation: a contract is collected once, then reads as spent (stored_before null)
  const client = { refund: async (txid, vout) => { const o = `${txid}:${vout}`; if (spentAlready.has(o)) return JSON.stringify({ accepted: false, stored_before: null }); spentAlready.add(o); return JSON.stringify({ accepted: true }); } };
  const fetcher = async () => new Response(JSON.stringify({ donations: rows }), { status: 200 }); // every honest seat: the same rows, oldest first, never deleted
  const got = new Set();
  for (let p = 0; p < passes; p++) {
    const r = await collectZaps({ storage, keep, curve, clients: new Map([[F, client]]), seats: ['https://a.example', 'https://b.example', 'https://c.example'], fetcher });
    for (const c of r.collected) got.add(c.outpoint);
  }
  return got;
}

test('honest path: a player sent 250 zaps collects all of them (the seats keep a player key\'s rows, oldest first)', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ outpoint: op(i), federationId: F, amountMsat: '1000', item: 'zap', verifiedMs: 1000 + i }));
  const got = await run(rows, 20);
  assert.equal(got.size, 250, `only ${got.size} of 250 real zaps were collected in 20 passes: rows past the 200th of every seat are never read`);
});

test('a stranger\'s 200 one-msat dust zaps do not freeze the victim\'s later real zap for ever', async () => {
  const dust = Array.from({ length: 200 }, (_, i) => ({ outpoint: op(i), federationId: F, amountMsat: '1', item: 'zap', verifiedMs: 1000 + i }));
  const REAL = op(500);
  const rows = [...dust, { outpoint: REAL, federationId: F, amountMsat: '500000000', item: 'zap', verifiedMs: 9000 }];
  const got = await run(rows, 20);
  assert.ok(got.has(REAL), 'the 500,000 sat zap sent after 200 dust zaps was never collected in 20 passes');
});

test('kanban #2428: 300 rows a stranger left in a federation this page holds no wallet of (never settled) do not hide a later real zap - the per-seat window moves forward', async () => {
  const OTHER = 'ee'.repeat(32);
  const junk = Array.from({ length: 300 }, (_, i) => ({ outpoint: op(i), federationId: OTHER, amountMsat: '1', item: 'zap', verifiedMs: 1000 + i }));
  const REAL = op(900);
  const got = await run([...junk, { outpoint: REAL, federationId: F, amountMsat: '500000000', item: 'zap', verifiedMs: 9000 }], 5);
  assert.ok(got.has(REAL), 'the real zap past 300 unsettled rows was never collected in 5 passes');
});
