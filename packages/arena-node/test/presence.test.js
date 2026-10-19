// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO SITS AT A HEAD-TO-HEAD ROUND'S TABLE (2026-10-09 playtest: two tabs at one table both read "You are
// alone in this round" until one picked - the table counted moves, not players). Each tab says it is at the round's table
// with its identity key, signed over (round, key); a seat answers who said so within PRESENCE_MS, each with the name made
// from its key. A presence not signed by its key is refused; one not said again leaves the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { skipBy, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { presenceId, PRESENCE_MS } from '../../arena-protocol/src/match.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const say = (who, rid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(presenceId({ roundId: rid, identityKey: who.key }), who.secret)) });

test('two tabs at one table each see the other before any move; a forged presence is refused; one not said again leaves', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (d, body) => fetch(`http://127.0.0.1:${d.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  const keys = (r) => r.body.here.map((p) => p.key).sort();
  try {
    const ALICE = ident(), BOB = ident(), EVE = ident();
    const empty = await here(w.a);
    const a = await Promise.all(w.nodes.map((d) => here(d, say(ALICE, w.rid))));
    const b = await Promise.all(w.nodes.map((d) => here(d, say(BOB, w.rid))));
    const forged = await here(w.a, { key: toHex(EVE.key), sig: say(ALICE, w.rid).sig });
    skipBy(PRESENCE_MS - 2000);
    const bobStays = await Promise.all(w.nodes.map((d) => here(d, say(BOB, w.rid))));
    skipBy(3000);
    const later = await here(w.b);
    console.log('  PRESENCE:', JSON.stringify({ empty: empty.body.here.length, afterAlice: a.map((r) => r.body.here.length), afterBob: b.map((r) => r.body.here.length),
      names: b[0].body.here.map((p) => p.name), forged: `${forged.status} ${forged.body}`, afterAliceLeft: later.body.here.map((p) => p.name) }));
    assert.deepEqual(empty.body.here, []);
    for (const r of b) assert.deepEqual(keys(r), [toHex(ALICE.key), toHex(BOB.key)].sort(), 'each seat sees both at the table');
    assert.deepEqual(b[0].body.here.find((p) => p.key === toHex(ALICE.key)).name, displayNameFromKey(ALICE.key));
    assert.equal(forged.status, 403);
    assert.match(forged.body, /not signed by its key over this round/);
    assert.equal(bobStays[0].body.here.length, 2);
    assert.deepEqual(keys(later), [toHex(BOB.key)], 'Alice said nothing for longer than PRESENCE_MS: she left the table');
  } finally { await w.close(); }
});
