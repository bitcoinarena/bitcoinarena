// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 audit44 refute s2 of #1645/#2147: the resume path. Alice sits; a stranger holds 31 keys; Bob arrives (or comes back after a
// reload / a dropped connection longer than PRESENCE_MS - his stay starts again) and takes the last slot. ONE fresh throwaway key after
// him evicts him, because his stay began last: the stranger needs one key per 2 s say, and Alice reads 32 keys without Bob.
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

test('wf1489-a44-refute-28-s2-2: one fresh key said after a (re)arriving real player evicts him', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (d, body) => fetch(`http://127.0.0.1:${d.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  try {
    const ALICE = ident(), BOB = ident();
    await here(w.a, say(ALICE, w.rid));
    for (let i = 0; i < 31; i++) await here(w.a, say(ident(), w.rid));
    const bob = await here(w.a, say(BOB, w.rid));
    const one = await here(w.a, say(ident(), w.rid));      // the stranger's one key after him
    const alice = await here(w.a, say(ALICE, w.rid));       // Alice's next say reads the table
    const keys = alice.status === 200 ? alice.body.here.map((p) => p.key) : [];
    console.log(`  FACTS Bob: ${bob.status}; one junk after: ${one.status}; Alice reads ${keys.length} keys, Bob among them: ${keys.includes(toHex(BOB.key))}, Alice: ${keys.includes(toHex(ALICE.key))}`);
    assert.ok(keys.includes(toHex(BOB.key)), 'Alice does not see Bob: one throwaway key said after him took his slot');
  } finally { await w.close(); }
});
