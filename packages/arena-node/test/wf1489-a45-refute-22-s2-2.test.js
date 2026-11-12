// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2355 (#1489 a45-refute-22-s2, refute of #1856 after #2273): a peer's GET /season-rounds is read only in the honest shape -
// each round once, after the cursor, with no signature or the answering seat's own one. One real contract repeated with varied
// entries (a verify each, the draw cached), a round on two pages, or a signature claimed for another seat: the seat is not read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { b32, opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const GAME = toHex(NEXTBLOCK_GAME_ID);
const key = (n) => toHex(schnorr.getPublicKey(b32(n)));
const base = (x) => `http://127.0.0.1:9/seat-${x}`;
const id = (n) => n.toString(16).padStart(64, '0');
const round = (n, score, sigs) => ({ roundId: id(n), gameId: GAME, startMs: String(Date.now() - 3600000 + n), void: false,
  entries: [{ player: key(0x0e), name: null, stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score, roundKey: null }], contract: null, sigs });

test('#2355: only a seat\'s own account of each round, once, is read; a repeated round or a foreign signature drops the seat', async () => {
  const own = (n) => [{ node: key(0xa1), sig: 'ab'.repeat(64) }];
  const answers = {
    a: [{ node: key(0xa1), next: id(2), rounds: [round(1, 1, own()), round(2, 1, [])] }, { node: key(0xa1), next: null, rounds: [round(3, 1, own())] }],   // honest
    b: [{ node: key(0xa2), next: null, rounds: [round(1, 1, []), round(1, 2, []), round(1, 3, [])] }],                                       // one round, varied entries
    c: [{ node: key(0xa3), next: id(2), rounds: [round(1, 1, []), round(2, 1, [])] }, { node: key(0xa3), next: null, rounds: [round(2, 1, [])] }],   // a round again
    e: [{ node: key(0xa5), next: null, rounds: [round(1, 1, [{ node: key(0xa1), sig: 'ab'.repeat(64) }])] }],                                // another seat's signature
    f: [{ node: key(0xa6), next: null, rounds: [round(1, 1, [{ node: key(0xa6), sig: 'ab'.repeat(64) }, { node: key(0xa6), sig: 'cd'.repeat(64) }])] }],
  };
  const seasonFetch = async (u) => {
    const x = Object.keys(answers).find((k) => u.startsWith(`${base(k)}/`));
    if (!x) throw new Error('no answer');
    const after = new URL(u.replace(base(x), 'http://x')).searchParams.get('after') || '';
    const page = answers[x][after ? 1 : 0];
    return new Response(JSON.stringify({ ...page, roundKeys: true }), { status: 200 });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers: Object.keys(answers).map(base), seasonFetch, ...opts });
  try {
    const j = await (await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network&days=7`)).json();
    console.log('seats', j.seats);
    assert.deepEqual(j.seats, { asked: 5, answered: 1 }, 'only the honest seat a is read');
  } finally {
    await d.close?.();
  }
});
