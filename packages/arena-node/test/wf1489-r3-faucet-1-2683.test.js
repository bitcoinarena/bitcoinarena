// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3-faucet-1 (base b5f391bbb): THE ARMADA NAME ON THE SOCIAL SCREEN IS FETCHED UNGUARDED AND READ WHOLE. POST /feedback/social
// { armada: "name@domain" } (any fresh NIP-98 key, one per 15 s per key) runs S2_ARMADA -> nostrPubkeyOf(input), which GETs
// https://<domain>/.well-known/nostr.json with plain fetch() and r.json(): no public-name / resolved-address guard (#1511, #1884, #2064 hold every
// other caller-named fetch of the faucet to publicFetch + walletRefusal) and no byte bound (#1563, #2517 read every LNURL answer bounded).
// A stranger makes the faucet - the process that pays the welcomes and the mainnet bounties - GET any host its DNS name leads to (127.0.0.1.nip.io,
// a LAN or tail-net name), and a stranger's server answers hundreds of MB that the faucet buffers and parses.
// kanban #3922: the Armada check is gone (the owner 2026-11-28); the same NIP-05 read is the Nostr follow check's (bounty-nostr.js), tested here.
// Safe: the NIP-05 read goes only to a public address, and reads no more than a small bound of the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nostrPubkeyOf } from '../src/bounty-nostr.js';

const MB = 1 << 20;
function hugeBody(totalBytes, counter) {
  const head = Buffer.from('{"names":{"bob":"' + 'a'.repeat(64) + '"},"pad":"');
  const tail = Buffer.from('"}');
  const chunk = Buffer.alloc(MB, 0x61);
  let sent = 0, headSent = false, done = false;
  return new ReadableStream({
    pull(c) {
      if (done) return;
      let part;
      if (!headSent) { part = head; headSent = true; }
      else if (sent < totalBytes) { part = chunk; sent += chunk.length; }
      else { part = tail; done = true; }
      counter.bytes += part.length;
      c.enqueue(new Uint8Array(part));
      if (done) c.close();
    },
  });
}

test('r3-faucet-1a: a NIP-05 answer of 64 MB is not read whole', async () => {
  const counter = { bytes: 0 };
  const fetchFn = async () => new Response(hugeBody(64 * MB, counter), { status: 200, headers: { 'content-type': 'application/json' } });
  await nostrPubkeyOf('bob@wallet.example', { fetchFn });
  // kanban #2683: the reader stops at 16 KiB; the generator hands 1 MB chunks and the stream pulls one ahead, so up to ~2 MB are produced
  assert.ok(counter.bytes <= 3 * MB, `the faucet read ${counter.bytes} bytes of a stranger's nostr.json (safe: at most a small bound)`);
});

test('r3-faucet-1b: a name on a domain that leads to loopback is never fetched (the default path the faucet uses)', async () => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return new Response('{"names":{}}', { status: 200 }); };
  try {
    await nostrPubkeyOf('bob@127.0.0.1.nip.io').catch(() => null);
    await nostrPubkeyOf('bob@tn4.bitcoin-arena.io').catch(() => null);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(seen, [], `the faucet fetched internal / team hosts a stranger named: ${seen.join(', ')}`);
});
