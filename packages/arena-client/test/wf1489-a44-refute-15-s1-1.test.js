// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute of #1618: the per-pass Refund cap (ZAPS_REFUNDS_PER_PASS) is spent in found-map order, which is the order
// the seats' answers arrive. One seat that answers first with 200 fresh made-up outpoints each pass (in the player's federation; the
// federation reads each as "spent") uses up all 50 calls every pass, so a real zap that every honest seat lists is never collected.
// Before #1618 the real zap was collected on the first pass. Safe: the cap does not let one seat starve outpoints other seats list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('one fast seat with 200 fresh made-up rows a pass does not starve a real zap three honest seats list', async () => {
  const F = 'fe'.repeat(32);
  const REAL = `${'aa'.repeat(32)}:0`;
  const storage = mem(); storage.setItem('arena.player.seed', 'ab'.repeat(32));
  const keep = mem();
  let pass = 0;
  const fetcher = async (u) => {
    if (u.startsWith('https://evil.example')) {
      const rows = Array.from({ length: 200 }, (_, i) => ({ outpoint: `${(pass * 1000 + i + 1).toString(16).padStart(64, '0')}:0`, federationId: F, amountMsat: '1000' }));
      return new Response(JSON.stringify({ donations: rows }), { status: 200 });
    }
    await new Promise((r) => setTimeout(r, 5)); // an honest seat answers a few ms later than the attacker
    return new Response(JSON.stringify({ donations: [{ outpoint: REAL, federationId: F, amountMsat: '50000', item: 'zap' }] }), { status: 200 });
  };
  const client = { refund: async (txid) => JSON.stringify(txid === 'aa'.repeat(32) ? { accepted: true } : { accepted: false, stored_before: null }) };
  let collected = false;
  for (pass = 0; pass < 10; pass++) {
    const got = await collectZaps({ storage, keep, curve, clients: new Map([[F, client]]),
      seats: ['https://evil.example', 'https://a.example', 'https://b.example', 'https://c.example'], fetcher });
    if (got.collected.some((c) => c.outpoint === REAL)) { collected = true; break; }
  }
  assert.ok(collected, 'the real zap all three honest seats list was never collected in 10 passes: one seat\'s fresh made-up rows took every Refund call');
});
