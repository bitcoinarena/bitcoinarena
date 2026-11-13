// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (h2h-1): A STRANGER FILLS A PAID HEAD-TO-HEAD ROUND WITH LOCKLESS ENTRIES, WITHOUT BOUND (P5).
// Since #1437 a paying head-to-head round seats only entries backed by a lock, so the /entry door takes an entry before any
// lock and counts no lockless one against the game's players - and nothing else bounds them: no per-round cap, no per-key cap,
// the funding gate only asks that the round pays. Each costs the stranger a fresh Ed25519 key and a handout, no sats. Every one
// is stored, relayed to every seat, and at the close each seat signs, stores and gathers a VOID result for each of them.
// SAFE: a paid 2-player round does not hold dozens of entries nobody locked a stake for.
// SINCE #2174 an entry past the lockless cap is held aside and entered once the federation holds ITS OWN stake lock (POST /lock, /fee-lock,
// /lock-claim): one that locked real sats is no longer a lockless entry. The fixture makes every client's stake lock at the federation, so the
// stranger here makes none (`stakeHeld: false`, and shows none with the handout): a stranger with fresh keys and no sats, as this test means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const JUNK = 24;

test('#1489 r5-h2h-1: a paid head-to-head round does not hold dozens of lockless entries from one stranger', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // one honest player, locked
    await lockAndPlay(w, mk(0x40), { hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });
    // the stranger: entries with fresh keys, handout + entry at every seat, no lock anywhere
    let taken = 0;
    for (let i = 0; i < JUNK; i++) {
      try { await lockAndPlay(w, mk(0x41 + i), { hidden: { move: i % 3, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], stakeHeld: false, lockFirst: false }); taken++; }
      catch { /* refused at a door: that is the safe answer */ }
    }
    const held = w.nodes.map((d) => d.round.entriesOf(w.rid).length);
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    skipTo(Number(w.c.entryCloseMs) + 500);
    await closeRound(w);
    const signedHere = w.nodes.map((d) => d.round.entriesOf(w.rid).filter(({ entryId }) => d.round.hasResult(w.rid, entryId, d.round.pubkey)).length);
    console.log('  FACTS (r5-h2h-1):', JSON.stringify({ taken, held, seated, signedHere }));
    for (const [i, n] of held.entries())
      assert.ok(n <= 8, `seat ${i} holds ${n} entries in a 2-player paid round, ${n - seated[i]} of them with no lock (the stranger's ${taken} taken), and signed ${signedHere[i]} results at the close`);
  } finally { await w.close(); }
});
