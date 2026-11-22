// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2982, #3253: GET /identity?nonce= - a seat signs a fresh nonce with its node key, so an address naming that key can be
// shown to be the seat (the network season merges two addresses into one seat only then). Without a nonce, the key's bytes as ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, provesNodeKey } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('GET /identity?nonce= proves the node key; another key, a bad nonce or a replayed answer does not', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const me = toHex(d.round.pubkey);
    assert.equal(toHex(new Uint8Array(await (await fetch(`${base}/identity`)).arrayBuffer())), me, 'without a nonce: the key\'s bytes');
    assert.equal(await provesNodeKey(base, me), true, 'the seat proves its own key');
    assert.equal(await provesNodeKey(base, 'ab'.repeat(32)), false, 'and no other');
    assert.equal((await fetch(`${base}/identity?nonce=zz`)).status, 400);
    // an answer to another nonce, handed back: not a proof of this ask
    const old = await (await fetch(`${base}/identity?nonce=${'11'.repeat(32)}`)).json();
    const replay = async () => new Response(JSON.stringify(old), { status: 200 });
    assert.equal(await provesNodeKey('http://127.0.0.1:9/liar', me, { fetch: replay }), false, 'a replayed answer proves nothing');
  } finally { await d.close(); }
});
