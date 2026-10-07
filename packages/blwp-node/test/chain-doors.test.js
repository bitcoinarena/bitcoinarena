// A NODE SERVES A CHAIN ONLY WHEN IT WAS GIVEN ONE.
//
// The join URL names four things and the daemons used to publish one of them.
// These are the other two: the headers a client reads as Bitcoin's own bytes,
// and the bond proof the advertisement commits to.
//
// THE DEFAULT IS STILL "NOT A CHAIN PROVIDER". Section 25.1 wants headers
// "from several independent sources", and a node serving the chain that proves
// its own bond is one source wearing two hats - so a daemon that was handed no
// view answers 404 and says why, rather than an empty body a client would have
// to interpret as a short chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HEADER_BYTES } from '../../protocol/src/chain.js';
import { HOSTED } from './plugins/hosted.js';

const fixture = new Uint8Array(2 * HEADER_BYTES).fill(7);
const proof = { hex: 'ab'.repeat(20), merkle: ['cd'.repeat(32)], pos: 0 };

test('a node given no chain says so at both doors', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0 });
  try {
    const h = await fetch(`http://127.0.0.1:${node.port}/headers`);
    assert.equal(h.status, 404);
    assert.match(await h.text(), /no chain to serve/);

    const b = await fetch(`http://127.0.0.1:${node.port}/bond`);
    assert.equal(b.status, 404);
    assert.match(await b.text(), /no bond proof to serve/);
  } finally { await node.close(); }
});

test('a node given a chain serves it as 80-byte records and the proof beside it', async () => {
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, headerBytes: fixture, bondProof: proof });
  try {
    const h = await fetch(`http://127.0.0.1:${node.port}/headers`);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('content-type'), 'application/octet-stream');
    const bytes = new Uint8Array(await h.arrayBuffer());
    assert.equal(bytes.length, 2 * HEADER_BYTES, 'the door reshaped the chain');
    assert.equal(bytes.length % HEADER_BYTES, 0);
    assert.deepEqual(bytes, fixture, 'the bytes served are not the bytes given');

    const b = await fetch(`http://127.0.0.1:${node.port}/bond`);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), proof);

    // AND A BROWSER MAY READ THEM. The page is on another origin than the
    // daemon and always will be - the daily is on Cloudflare and the node is
    // on a tailnet - so a door without this header is a door no player can
    // use, and no test would have noticed.
    assert.equal(h.headers.get('access-control-allow-origin'), '*');
    assert.equal(b.headers.get('access-control-allow-origin'), '*');
  } finally { await node.close(); }
});
