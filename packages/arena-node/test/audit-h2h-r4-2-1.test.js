// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT h2h r4-2-1 (gap in #2385/#2437's source rule; closest #2109): POST /here makes room at a full head-to-head table from the
// source that holds the most keys (presenceSource -> reach-check.js askerAddress). Behind the local proxy (tailscale serve / funnel, which
// the installer sets up, or nginx with $proxy_add_x_forwarded_for) the socket peer is 127.0.0.1, and askerAddress takes a client-sent
// cf-connecting-ip, else the FIRST X-Forwarded-For hop - the hop the stranger wrote himself (the proxy appends the real address after it).
// A stranger who writes a fresh first hop for every throwaway key is 32 "sources" of one key each, and the whole-table rule drops the key
// said longest ago: the real player who said hers 2 s ago, at every seat behind such a proxy - "You are alone in this round" again.
// SAFE: both real players' signed presences are kept and shown, whatever header a stranger writes.
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

test('audit-h2h-r4-2-1: a stranger who writes his own X-Forwarded-For first hop evicts a real player from the table', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  // the local proxy: it appends the address it saw to whatever X-Forwarded-For the client sent
  const here = (realIp, body, clientXff = null) => fetch(`http://127.0.0.1:${w.a.port}/here?round=${toHex(w.rid)}`, body
    ? { method: 'POST', headers: { 'x-forwarded-for': clientXff ? `${clientXff}, ${realIp}` : realIp }, body: JSON.stringify(body) } : {})
    .then(async (x) => ({ status: x.status, body: x.status === 200 ? await x.json() : (await x.text()).trim() }));
  const STRANGER = '203.0.113.9', ALICE_IP = '198.51.100.7', BOB_IP = '192.0.2.44';
  let n = 0;
  const fake = () => { n++; return `100.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };   // a fresh first hop per post
  try {
    const ALICE = ident(), BOB = ident();
    await here(ALICE_IP, say(ALICE, w.rid));
    await here(BOB_IP, say(BOB, w.rid));
    const junk = [];
    for (let i = 0; i < 31; i++) { const j = ident(); junk.push(j); await here(STRANGER, say(j, w.rid), fake()); }
    const seen = [];
    for (let turn = 0; turn < 4; turn++) {                  // each tab says its presence every 2 s; the stranger keeps his keys said
      await here(ALICE_IP, say(ALICE, w.rid));
      for (const j of junk) await here(STRANGER, say(j, w.rid), fake());
      await here(STRANGER, say(ident(), w.rid), fake());       // one fresh key at the full table
      await here(BOB_IP, say(BOB, w.rid));
      for (const j of junk) await here(STRANGER, say(j, w.rid), fake());
      await here(STRANGER, say(ident(), w.rid), fake());
      const r = await here(null);
      const keys = r.body.here.map((p) => p.key);
      seen.push({ n: keys.length, alice: keys.includes(toHex(ALICE.key)), bob: keys.includes(toHex(BOB.key)) });
    }
    console.log(`  FACTS per turn: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((s) => s.alice && s.bob), 'a stranger with one real address but a forged first X-Forwarded-For hop per key took a real player\'s seat');
  } finally { await w.close(); }
});
