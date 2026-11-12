// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (client): ONE SEAT'S GET /donations LIST IS BOUNDED. collectZaps reads every seat's list of what was paid to
// this tab's identity refund key and spends each row it does not yet hold with a federation Refund call. A row list from one seat is
// taken whole: one seat that lists 20,000 made-up outpoints in the player's federation makes the page send 20,000 Refund requests to
// the guardians on every pass (and the next pass again, since only the last 500 are remembered). Safe: a bounded number of rows per
// seat and per pass is acted on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const storage = () => { const s = mem(); s.setItem('arena.player.seed', 'ab'.repeat(32)); return s; };

test('one seat listing 20,000 made-up donation rows does not make the page send 20,000 federation Refund calls', async () => {
  const F = 'fe'.repeat(32);
  const N = 20000;
  const rows = Array.from({ length: N }, (_, i) => ({ outpoint: `${i.toString(16).padStart(64, '0')}:0`, federationId: F, amountMsat: '1000' }));
  const fetcher = async (u) => (u.startsWith('https://evil.example')
    ? new Response(JSON.stringify({ donations: rows }), { status: 200 })
    : new Response(JSON.stringify({ donations: [] }), { status: 200 }));
  let refunds = 0;
  // the federation holds no contract at any made-up outpoint: stored_before null, the page reads it "spent"
  const client = { refund: async () => { refunds++; return JSON.stringify({ accepted: false, stored_before: null }); } };
  const got = await collectZaps({ storage: storage(), keep: mem(), curve, clients: new Map([[F, client]]),
    seats: ['https://evil.example', 'https://honest.example'], fetcher });
  assert.ok(refunds <= 1000, `one seat's list drove ${refunds} Refund calls to the federation in one pass (${got.spent.length} rows read as spent)`);
});
