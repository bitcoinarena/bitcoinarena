// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A round's signer nodes outside the tool's NODES, at their own addresses (kanban #804, tools/signer-addresses.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressBook } from '../tools/signer-addresses.mjs';

const K = (c) => c.repeat(64);
const book = { announcements: [
  { node: K('a'), endpoint: 'https://installed-a.trycloudflare.com' },
  { node: K('b'), endpoint: 'https://installed-b.trycloudflare.com/' },
  { node: K('c'), endpoint: 'wss://test-host.example/fed2-3' },
  { node: K('d'), endpoint: 'http://127.0.0.1:31221' },
] };

test('the signers outside NODES at their http(s) addresses; a guardian ws(s) address, one of NODES and an unknown key are left out', async () => {
  let asks = 0;
  const b = addressBook(['http://127.0.0.1:31221/', 'http://127.0.0.1:31231'], { fetcher: async () => { asks++; return new Response(JSON.stringify(book)); } });
  assert.deepEqual(await b.outside([K('a'), K('b'), K('c'), K('d'), K('e')]), ['https://installed-a.trycloudflare.com', 'https://installed-b.trycloudflare.com']);
  assert.deepEqual(await b.outside([Uint8Array.from(Buffer.from(K('a'), 'hex'))]), ['https://installed-a.trycloudflare.com'], 'a key as bytes');
  assert.equal(asks, 1, 'the book read once within its time');
});

test('a seat that does not answer: the next one is asked; none answering gives no address, not an error', async () => {
  const b = addressBook(['http://s1', 'http://s2'], { fetcher: async (u) => { if (u.startsWith('http://s1')) throw new Error('down'); return new Response(JSON.stringify(book)); } });
  assert.deepEqual(await b.outside([K('a')]), ['https://installed-a.trycloudflare.com']);
  const none = addressBook(['http://s1'], { fetcher: async () => new Response('no', { status: 503 }) });
  assert.deepEqual(await none.outside([K('a')]), []);
});
