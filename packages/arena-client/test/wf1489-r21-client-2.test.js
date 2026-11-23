// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 21 (client): ONE SEAT'S GET /items AND GET /donations ANSWERS ARE READ WHOLE (doors #2365 / #2740 did not cover).
// ownedItems (every entry of an item-selling game, item-buy.js) and collectZaps (the page's once-a-minute zap/referral collect,
// identity.js) take a seat's answer with r.json(): one seat streaming a 64 MiB (or endless) body is held in the tab's memory and
// parsed on its one thread - the item shop and every join of that game, and the zap collect, read it again each time.
// Safe: a seat's answer is read up to a bound (as readJsonUpTo does for /served), the rest is not pulled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { ownedItems } from '../src/item-buy.js';
import { collectZaps } from '../src/identity.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const TOTAL = 64 * 1024 * 1024, CHUNK = 1024 * 1024, BOUND = 16 * 1024 * 1024;

// a body of `head` + spaces + `tail`, counting what the reader pulled
function padded(head, tail, pulled) {
  const sp = new Uint8Array(CHUNK).fill(0x20);
  let sent = 0, done = false;
  return new Response(new ReadableStream({
    pull(c) {
      if (done) return;
      if (sent === 0) { const b = new TextEncoder().encode(head); pulled.n += b.length; c.enqueue(b); }
      if (sent >= TOTAL) { const b = new TextEncoder().encode(tail); pulled.n += b.length; c.enqueue(b); c.close(); done = true; return; }
      sent += CHUNK; pulled.n += CHUNK; c.enqueue(sp);
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('ownedItems does not pull a 64 MiB GET /items answer from one seat', async () => {
  const pulled = { n: 0 };
  const fetch = async (u) => (u.startsWith('https://evil.example') ? padded('{"items":[', ']}', pulled)
    : new Response(JSON.stringify({ items: [] }), { status: 200 }));
  await ownedItems({ seats: ['https://evil.example', 'https://honest.example'], player: new Uint8Array(32).fill(1), gameName: 'g', fetch });
  assert.ok(pulled.n <= BOUND, `the page pulled ${(pulled.n / 1048576).toFixed(1)} MiB of one seat's /items answer`);
});

test('collectZaps does not pull a 64 MiB GET /donations answer from one seat', async () => {
  const pulled = { n: 0 };
  const storage = mem(); storage.setItem('arena.player.seed', 'ab'.repeat(32));
  const fetcher = async (u) => (u.startsWith('https://evil.example') ? padded('{"donations":[', ']}', pulled)
    : new Response(JSON.stringify({ donations: [] }), { status: 200 }));
  await collectZaps({ storage, keep: mem(), curve, clients: new Map(), seats: ['https://evil.example', 'https://honest.example'], fetcher });
  assert.ok(pulled.n <= BOUND, `the page pulled ${(pulled.n / 1048576).toFixed(1)} MiB of one seat's /donations answer`);
});
