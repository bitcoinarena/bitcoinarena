// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2273 (#1489 a45-refute-22, #1856): GET /season-rounds in pages. The paging a busy honest seat's answer now takes must
// not give a peer back the unbounded read #1856 closed: a seat handing on `next` forever is read up to a total and no further,
// a cursor that does not rise ends the read, and every page an honest seat serves fits the 4 MB read bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { b32, opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const node = toHex(schnorr.getPublicKey(b32(0xa1)));
const base = (x) => `http://127.0.0.1:9/seat-${x}`;
const hex64 = (n) => n.toString(16).padStart(64, '0');

test('#2273: a peer handing on `next` forever is read up to a total, a cursor that does not rise ends the read', async () => {
  const peers = ['a', 'b'].map(base);
  const PAGE = 3.5 * 1024 * 1024;
  const pad = 'x'.repeat(PAGE);
  let askedA = 0, askedB = 0;
  const seasonFetch = async (u) => {
    const after = new URL(u.replace('http://127.0.0.1:9/seat-a', 'http://x').replace('http://127.0.0.1:9/seat-b', 'http://x')).searchParams.get('after') || '';
    if (u.startsWith(`${base('a')}/`)) {       // a rising cursor forever, every page just under the bound
      askedA++;
      const next = hex64((after ? BigInt('0x' + after) : 0n) + 1n);
      return new Response(JSON.stringify({ node, roundKeys: true, next, rounds: [], pad }), { status: 200 });
    }
    if (u.startsWith(`${base('b')}/`)) {       // the same cursor again and again: a loop
      askedB++;
      return new Response(JSON.stringify({ node: toHex(schnorr.getPublicKey(b32(0xa2))), roundKeys: true, next: hex64(5n), rounds: [] }), { status: 200 });
    }
    throw new Error('no answer');
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network`);
    assert.equal(r.status, 200);
    const j = await r.json();
    console.log('pages asked of a:', askedA, 'of b:', askedB, 'seats', j.seats);
    assert.ok(askedA <= Math.ceil((48 * 1024 * 1024) / PAGE) + 1, `a seat's pages are read up to a total, not forever (asked ${askedA})`);
    assert.ok(askedA >= 2, 'the pages were followed');
    assert.equal(askedB, 2, 'a cursor that does not rise ends the read');
  } finally {
    await d.close?.();
  }
});
