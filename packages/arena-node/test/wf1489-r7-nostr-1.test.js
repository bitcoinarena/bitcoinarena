// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r7-nostr-1: A PEER SEAT'S GET /season-rounds ANSWER IS READ WHOLE, WITH NO BYTE LIMIT.
// seasonAccounts() (server.js) reads every other seat's /season-rounds with a bare `await r.json()` - not the server's own
// `jsonUpTo(r, PEER_LISTING_BYTES)` (4 MB) that bounds every other peer listing (GET /games #1540, etc.). The process's fetch
// is cappedFetch, which bounds CONCURRENCY and timeouts but NOT response bytes. So one seat out of 7 (or 14) answers
// /season-rounds with a body of any size - tens or hundreds of MB - and the honest seat buffers it all and JSON.parses it in
// its own thread. The same read feeds the NIP-58 weekly-board badge book (accountsOf, signed:true): there each padded round is
// then schnorr-verified synchronously (mergeSignedSeasonAccounts), so the padded answer both exhausts memory and stalls the
// event loop (NIP-46 signing, NWC payments, logins) for everyone.
// Safe: a peer /season-rounds answer past a byte cap is dropped (that seat counts as not answered), as every other peer read is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { b32, opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

test('#1489 r7-nostr-1: a peer seat\'s oversized GET /season-rounds answer is not read whole', async () => {
  const base = (x) => `http://127.0.0.1:9/seat-${x}`;
  const peers = ['a'].map(base);                 // one peer seat, which I control
  const game = toHex(NEXTBLOCK_GAME_ID);
  const node = toHex(schnorr.getPublicKey(b32(0xa1)));

  // Peer 'a' answers /season-rounds with a WELL-FORMED but huge body: an empty rounds list padded to ~12 MB, far past the
  // 4 MB (PEER_LISTING_BYTES) cap the server applies to every other peer listing. An honest, bounded read drops it.
  const PAD = 12 * 1024 * 1024;
  const body = JSON.stringify({ node, rounds: [], roundKeys: true, pad: 'x'.repeat(PAD) });
  assert.ok(body.length > 4 * 1024 * 1024, 'the peer answer is over the 4 MB peer-listing cap');

  let served = 0;
  const seasonFetch = async (u) => {
    if (u.startsWith(`${base('a')}/`)) { served++; return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }); }
    throw new Error('no answer');
  };

  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network`);
    assert.equal(r.status, 200, 'the network season is built');
    const j = await r.json();
    assert.equal(j.scope, 'network');
    assert.equal(j.seats.asked, 1, 'the one peer seat was asked');
    assert.ok(served >= 1, 'the peer was actually queried');
    // SAFE: an answer this far over the byte cap is not ingested, so the seat is not counted as answered. On HEAD the
    // full 12 MB body is read and parsed (`await r.json()`), so the seat is counted -> this assertion fails on HEAD.
    assert.equal(j.seats.answered, 0, 'an oversized peer /season-rounds answer is dropped, not read whole');
  } finally {
    await d.close?.();
  }
});
