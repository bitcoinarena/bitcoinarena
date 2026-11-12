// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 audit44 refute of #1645 (H2H-2): the fix lets a full head-to-head table drop the presence said longest ago. The page says its
// presence BEFORE any move ("so the other player sees someone is there before any move is in", identity.js presenceProofFor), so a real
// player at the table is not yet named by any name record. A stranger who posts 32 throwaway presences AFTER her now evicts her: the
// stranger only needs to be later, not first. Before the fix a seated player kept her place; now she is pushed out every round of junk.
// SAFE (the fix's own claim): a real player's signed presence at a round's table is kept and shown, whatever presences strangers posted.
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

test('wf1489-a44-refute-28-s1-1: 32 throwaway presences said after a seated real player push her off the table', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (d, body) => fetch(`http://127.0.0.1:${d.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  try {
    const ALICE = ident(), BOB = ident();
    const alice = await here(w.a, say(ALICE, w.rid));          // Alice sits at the table, before her move (the page's order)
    const junk = [];
    for (let i = 0; i < 32; i++) junk.push((await here(w.a, say(ident(), w.rid))).status);  // then the stranger's 32 fresh keys
    const bob = await here(w.a, say(BOB, w.rid));              // Bob arrives and reads who is there
    const keys = bob.status === 200 ? bob.body.here.map((p) => p.key) : [];
    console.log(`  FACTS Alice: ${alice.status}; stranger's 32: ${JSON.stringify([...new Set(junk)])}; Bob: ${bob.status}; table shows ${keys.length} keys, Alice among them: ${keys.includes(toHex(ALICE.key))}`);
    assert.equal(bob.status, 200);
    assert.ok(keys.includes(toHex(ALICE.key)), 'Bob does not see Alice at the table: the stranger\'s later presences evicted her');
  } finally { await w.close(); }
});
