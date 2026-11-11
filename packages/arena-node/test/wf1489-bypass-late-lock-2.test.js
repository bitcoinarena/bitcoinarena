// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit of #1485: the seat's late-handout refusal comes AFTER the money for a client that locks first.
// tools/rps-opponent.mjs (the head-to-head opponent bot) and this fixture lock the stake and fee in the federation first
// (lockEntry submitOnly), and only then post the handout and the entry; the bot goes ahead with as little as 400 ms left.
// With the live lead (node-start.js h2hHandoutLeadMs: 2000), such an order with 1 s left - time enough for the entry,
// which a head-to-head seat takes until its close - is now refused at the handout: the lock is spent, every seat refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('wf1489 bypass-late-lock 2 (kanban #1596): a lock-first order (the RPS bot) with 1 s left is locked, then refused at the handout under the live 2 s lead', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: 2000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    const close = Number(w.c.entryCloseMs);
    skipTo(close - 1000);
    let entered = null, why = null;
    try { entered = await lockAndPlay(w, mk(1), { hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true }); }
    catch (e) { why = String(e.message).split('\n').join(' ').slice(0, 260); }
    const lockedInFederation = w.port && typeof w.port.size === 'number' ? w.port.size : '(port)';
    console.log('  FACTS (wf1489-1):', JSON.stringify({ leftMs: close - testNow(), why, lockedInFederation, entries: w.nodes.map((d) => d.round.entriesOf(w.rid).length) }));
    assert.equal(why, null, `the stake and fee were locked first, and the order was then refused: ${why}`);
    assert.ok(entered && w.nodes.every((d) => d.round.entry(entered.eid)), 'every seat holds the entry whose lock was made');
    // kanban #1596: and the lock must really be held - one shown at an outpoint the federation does not hold is refused as before (#1485)
    let forged = null;
    try { await lockAndPlay(w, mk(2), { hidden: { move: 1, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, lockFirst: 'unheld' }); forged = 'taken'; }
    catch (e) { forged = String(e.message).split('\n').join(' ').slice(0, 300); }
    console.log('  FACTS (#1596 unheld lock):', JSON.stringify({ leftMs: close - testNow(), forged }));
    assert.match(forged, /the stake lock shown: the federation holds no lock at that outpoint/, `a handout showing a lock the federation does not hold: ${forged}`);
    assert.ok(w.nodes.every((d) => d.round.entriesOf(w.rid).length === 1), 'only the entry whose lock was made stands');
  } finally { await w.close(); }
});
