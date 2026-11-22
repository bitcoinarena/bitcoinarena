// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 24 (client): ONE SEAT'S COPY OF A REAL ZAP ROW UNDER ANOTHER FEDERATION FILES THE ZAP AS SPENT FOR GOOD.
// collectZaps keeps every version of an outpoint's row (#1557, #2696) and tries them most-seats first. A version whose federation has no
// wallet open in this tab answers 'waiting' and the loop goes on to the next version. One seat lists the player's real zap outpoint with
// federationId = a federation the tab DOES hold a wallet in; the Refund there finds no contract (stored_before null), the page reads the
// outpoint as spent, adds it to arena.zaps.collected and never asks again - also after the player opens the zap's own federation.
// Safe: a version whose federation holds nothing at that outpoint does not settle the outpoint while another version is still waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('wf1489-r24-client-1: one seat\'s row naming another federation does not file a waiting real zap as spent', async () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);   // A: the tab's wallet; B: the zap's federation, no wallet open yet
  const OUT = `${'cd'.repeat(32)}:1`;
  const real = { outpoint: OUT, federationId: B, amountMsat: '21000' };
  const forged = { outpoint: OUT, federationId: A, amountMsat: '21000' };
  const SEATS = ['https://s1.example', 'https://s2.example', 'https://s3.example', 'https://liar.example'];
  const fetcher = async (u) => new Response(JSON.stringify({ donations: [u.startsWith('https://liar') ? forged : real] }), { status: 200 });
  const store = mem(); store.setItem('arena.player.seed', 'ab'.repeat(32));
  const keep = mem();
  const askedA = [];
  const clientA = { refund: async (txid, vout) => { askedA.push(`${txid}:${vout}`); return JSON.stringify({ accepted: false, stored_before: null }); } };
  // pass 1: only federation A's wallet is open
  const p1 = await collectZaps({ storage: store, keep, curve, clients: new Map([[A, clientA]]), seats: SEATS, fetcher });
  console.log('  pass 1', JSON.stringify({ spent: p1.spent.map((d) => d.federationId.slice(0, 4)), waiting: p1.waiting.length, askedA }));
  // pass 2: the player opened federation B; the real contract is there
  const askedB = [];
  const clientB = { refund: async (txid, vout) => { askedB.push(`${txid}:${vout}`); return JSON.stringify({ accepted: true, stored_before: 'x' }); } };
  const p2 = await collectZaps({ storage: store, keep, curve, clients: new Map([[A, clientA], [B, clientB]]), seats: SEATS, fetcher });
  console.log('  pass 2', JSON.stringify({ collected: p2.collected.length, askedB, collectedKey: keep.getItem('arena.zaps.collected') }));
  assert.equal(p2.collected.length, 1, `the real 21 sat zap in federation B was never collected: one seat's copy under federation A was refunded there, read as spent (${JSON.stringify(p1.spent)}) and the outpoint is never asked again`);
});
