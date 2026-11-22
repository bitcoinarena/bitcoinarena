// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit gossip r1-2: THE NETWORK SEASON LABELS EACH SEAT'S ANSWER BY THE NODE KEY THE ANSWER ITSELF NAMES (server.js seasonAccounts,
// `label = signed ? a.seat : a.node || a.seat`, first label wins in seat-URL order). The `node` field of GET /season-rounds is unsigned, so one
// seat whose address sorts before an honest seat's answers under THAT seat's key: its own answer takes the honest seat's place and the honest
// seat's real answer is dropped as "a second address". A round three honest seats agree on (SEASON_NETWORK_AGREE = 3) loses one of its
// three voices and leaves the network board (and the `entered` list the faucet reads with it).
// Safe: one seat's answer cannot remove another seat's answer from the merge by naming that seat's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { b32, opts } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const HOUR = 3600000;

test('audit gossip r1-2: a seat naming an honest seat\'s node key in its /season-rounds answer does not drop that seat\'s answer', async () => {
  const key = (n) => toHex(schnorr.getPublicKey(b32(n)));
  const base = (x) => `http://127.0.0.1:9/seat-${x}`;
  const peers = ['0', 'a', 'b', 'c'].map(base);   // seat-0 is the attacker; its address sorts before seat-a
  const answers = new Map();
  const seasonFetch = async (u) => {
    const at = peers.find((p) => u.startsWith(`${p}/`));
    const a = answers.get(at);
    if (!a) throw new Error('no answer');
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const now = Date.now();
    const game = toHex(NEXTBLOCK_GAME_ID);
    const X = toHex(b32(0x5a));
    const real = { roundId: 'ee'.repeat(32), gameId: game, startMs: String(now - HOUR), void: false,
      entries: [{ player: X, name: 'bob', stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score: 42 }] };
    const of = (n, rounds) => ({ node: key(n), rounds });
    answers.set(base('a'), of(0xa1, [real]));
    answers.set(base('b'), of(0xa2, [real]));
    answers.set(base('c'), of(0xa3, [real]));
    // control first: without the attacker the round stands on three seats
    const ctl = await (await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network&days=7`)).json();
    assert.ok(ctl.rows.some((x) => x.player === X), `control: three seats agree, the round counts (${JSON.stringify(ctl.seats)})`);
    // the attacker answers under seat a's key with nothing (a fresh query: days=6, so no kept answer)
    answers.set(base('0'), of(0xa1, []));
    const j = await (await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network&days=6`)).json();
    console.log(`  FACTS: seats ${JSON.stringify(j.seats)}, rounds ${j.rounds}, rows ${j.rows.length}, leftOut ${j.leftOut}`);
    assert.ok(j.rows.some((x) => x.player === X), 'the honest round three seats agree on left the network board: seat-0, naming seat a\'s node key, took seat a\'s place in the merge');
  } finally { await d.close(); }
});

