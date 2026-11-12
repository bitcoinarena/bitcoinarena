// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 audit44 refute s2 of #1645/#2147: the fix (44a338c24) has a full table drop the unnamed key whose stay began LAST. A stranger who
// fills the table with 32 throwaway keys BEFORE the players arrive (the round id is public from the listing) and keeps them said: Alice
// takes the newest slot, then Bob takes it from her (her stay began last), then Alice's next say takes it back from Bob - the two real
// players knock each other off the one free slot forever and never sit at the table together ("You are alone in this round").
// SAFE: both real players' signed presences are kept and shown, whatever presences strangers posted.
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

test('wf1489-a44-refute-28-s2-1: a table pre-filled by a stranger lets the two real players only evict each other', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (d, body) => fetch(`http://127.0.0.1:${d.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  try {
    const junk = [];
    for (let i = 0; i < 32; i++) junk.push((await here(w.a, say(ident(), w.rid))).status);  // the stranger fills the table first
    const ALICE = ident(), BOB = ident();
    const seen = [];
    for (let turn = 0; turn < 3; turn++) {                 // each tab says its presence every 2 s, in turn
      const a = await here(w.a, say(ALICE, w.rid));
      const b = await here(w.a, say(BOB, w.rid));
      const keys = b.status === 200 ? b.body.here.map((p) => p.key) : [];
      seen.push({ alice: keys.includes(toHex(ALICE.key)), bob: keys.includes(toHex(BOB.key)), a: a.status, b: b.status });
    }
    console.log(`  FACTS stranger's 32: ${JSON.stringify([...new Set(junk)])}; per turn after Bob's say: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((s) => s.alice && s.bob), 'Alice and Bob are never at the table together: the stranger\'s 32 earlier keys keep one slot for both');
  } finally { await w.close(); }
});
