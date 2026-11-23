// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2816 (audit r22 client-1): a paid join read GET /donation-set (and /game-donation-set) with r.arrayBuffer() - one signer seat answering
// 200 with an endless body had the page pull all of it into memory on every paid join. Safe: the read stops past DONATION_FORM_MAX_BYTES (4 MiB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDonationSet } from '../src/donation-pay.js';

const TOTAL = 64 * 1024 * 1024, CHUNK = 1024 * 1024, BOUND = 16 * 1024 * 1024;
test('#2816 one seat\'s endless /donation-set body is not pulled whole', async () => {
  const pulled = { n: 0 };
  const endless = () => { let sent = 0; return new ReadableStream({ pull(c) { if (sent >= TOTAL) return c.close(); const b = new Uint8Array(CHUNK).fill(0x41); sent += CHUNK; pulled.n += CHUNK; c.enqueue(b); } }); };
  const fetcher = async (u) => (/\/donation-set\?/.test(u) ? new Response(endless(), { status: 200 }) : new Response('no', { status: 404 }));
  try { await fetchDonationSet({ round: { id: new Uint8Array(32).fill(3), donationSetId: new Uint8Array(32).fill(4), networkId: new Uint8Array(32).fill(5) }, nodes: ['https://liar.example'], fetcher, verifyEd25519: () => false, keys: [new Uint8Array(32)] }); } catch { /* refused: fine */ }
  console.log('  MEASURED:', JSON.stringify({ pulledMiB: pulled.n / 1048576 }));
  assert.ok(pulled.n <= BOUND, `the page pulled ${(pulled.n / 1048576).toFixed(1)} MiB of one seat's /donation-set answer`);
});
