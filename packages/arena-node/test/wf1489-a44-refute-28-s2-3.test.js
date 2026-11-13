// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2385, #2437 (audit44 refute s2 of #1645/#2147): the players and the stranger from different addresses, as the seats see them
// behind cloudflared / tailscale serve (the proxy's x-forwarded-for). The stranger fills the table before the players come, keeps all his
// keys said, and posts a fresh key before and after every say of theirs - the timing that beat both earlier order rules. A full table
// makes room from the source that holds the most keys, so his keys only push out his own.
// SAFE: both real players' signed presences are kept and shown at every read, whatever presences strangers posted, and in whatever order.
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
import { presenceToDrop } from '../src/server.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ident = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, key: schnorr.getPublicKey(secret) }; };
const say = (who, rid) => ({ key: toHex(who.key), sig: toHex(schnorr.sign(presenceId({ roundId: rid, identityKey: who.key }), who.secret)) });

test('wf1489-a44-refute-28-s2-3: a stranger at another address, saying 32+ keys at any moment, never takes a player\'s seat', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const here = (ip, body) => fetch(`http://127.0.0.1:${w.a.port}/here?round=${toHex(w.rid)}`, body ? { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  const STRANGER = '203.0.113.9', ALICE_IP = '198.51.100.7', BOB_IP = '2001:db8:aa:1::5';
  try {
    const junk = [];
    for (let i = 0; i < 32; i++) { const j = ident(); junk.push(j); assert.equal((await here(STRANGER, say(j, w.rid))).status, 200); }
    const ALICE = ident();
    let BOB = ident();
    const seen = [];
    for (let turn = 0; turn < 4; turn++) {
      if (turn === 2) BOB = ident();                       // Bob reloads in a new tab: a fresh stay, as late as can be
      await here(STRANGER, say(ident(), w.rid));
      await here(ALICE_IP, say(ALICE, w.rid));
      await here(STRANGER, say(ident(), w.rid));
      await here(BOB_IP, say(BOB, w.rid));
      for (const j of junk) await here(STRANGER, say(j, w.rid));   // he keeps all his keys said
      await here(STRANGER, say(ident(), w.rid));
      const r = await here(null);
      const keys = r.body.here.map((p) => p.key);
      seen.push({ n: keys.length, alice: keys.includes(toHex(ALICE.key)), bob: keys.includes(toHex(BOB.key)) });
    }
    console.log(`  FACTS per turn: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((s) => s.alice && s.bob && s.n === 32), 'a stranger at another address took a real player\'s seat');
  } finally { await w.close(); }
});

test('wf1489-a44-refute-28-s2-3: whom a full table drops - the largest source\'s key said longest ago, never its first sitter, never a named one', () => {
  const t = new Map();
  let seq = 0;
  const put = (k, src) => { seq++; t.set(k, { said: seq, stay: seq, src }); };
  put('alice', 'A');
  for (let i = 0; i < 30; i++) put('j' + i, 'S');
  put('bob', 'B');
  assert.equal(presenceToDrop(t, new Set(), 'S'), 'j1', 'the stranger\'s source pays, its first key kept');
  assert.equal(presenceToDrop(t, new Set(), 'C'), 'j1', 'a newcomer from a third address takes the stranger\'s slot');
  assert.equal(presenceToDrop(t, new Set(['j1']), 'C'), 'j2', 'a named identity is not dropped');
  const one = new Map([['x', { said: 2, stay: 1, src: 'X' }], ['y', { said: 1, stay: 2, src: 'Y' }], ['z', { said: 3, stay: 3, src: 'Z' }]]);
  assert.equal(presenceToDrop(one, new Set(), 'W'), 'y', 'every source one key: the one said longest ago, the longest stay kept');
  assert.equal(presenceToDrop(new Map([['n', { said: 1, stay: 1, src: 'N' }]]), new Set(['n']), 'W'), null);
});
