// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 R4 H2H-2: POST /here (who sits at a head-to-head table) takes a presence from any key that signs it - keys cost nothing - and a table holds
// at most 32 of them; the 33rd is refused 503 "that table is full" for PRESENCE_MS after the last one. A stranger who knows only the public round id
// signs presences with 32 throwaway keys every 2 s and the round's real players are refused at every seat: each tab reads its opponent as absent
// ("You are alone in this round", the 2026-10-09 playtest bug the door was made for) and the table shows 32 made-up names. The same with 256 tables:
// one presence each on 256 old head-to-head rounds the seat holds and "this node keeps no more tables just now" for every round.
// SAFE: a real player's signed presence at a round's table is kept and shown, whatever presences strangers posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { presenceId } from '../../arena-protocol/src/match.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const say = (who, rid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(presenceId({ roundId: rid, identityKey: who.key }), who.secret)) });

test('wf1489-r4-h2h-2: throwaway keys do not keep a round\'s real players off its table', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (d, body) => fetch(`http://127.0.0.1:${d.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  try {
    // the stranger: 32 fresh keys, each signing a presence over the public round id
    const junk = [];
    for (let i = 0; i < 32; i++) junk.push((await here(w.a, say(ident(), w.rid))).status);
    // then the round's real player says she is at the table
    const ALICE = ident();
    const alice = await here(w.a, say(ALICE, w.rid));
    const shown = await here(w.a);
    const keys = shown.status === 200 ? shown.body.here.map((p) => p.key) : [];
    console.log(`  FACTS stranger's 32 presences: ${JSON.stringify([...new Set(junk)])}; Alice's: ${alice.status} ${typeof alice.body === 'string' ? alice.body : 'ok'}; table shows ${keys.length} keys, Alice among them: ${keys.includes(toHex(ALICE.key))}`);
    assert.equal(alice.status, 200, `the real player's presence was refused: ${alice.status} ${alice.body}`);
    assert.ok(keys.includes(toHex(ALICE.key)), 'the table does not show the real player');
  } finally { await w.close(); }
});
