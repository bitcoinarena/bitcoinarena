// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute 75 (a bypass of #1745): THE LOCKLESS CAP IS A FREE LOCKOUT OF EVERY HONEST PLAYER.
// #1745 refuses a new entry into a paying head-to-head round once LOCKLESS_PER_SEAT x players lockless entries joined in the last
// minute - counted across the whole round, whoever posted them, and without asking whether the NEW entry is itself locked. A stranger
// with fresh keys and no sats posts 6 lockless entries (handout + entry, never a lock) and every honest player who then enters - even
// one showing its stake lock with its handout, as the RPS client does - is refused "try again in a minute". He posts 6 more each minute
// and the paid round never seats anyone. Before #1745 the honest player was seated.
// SAFE: an honest locked player still enters a paid head-to-head round a stranger flooded with lockless entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { LOCKLESS_PER_SEAT, LOCKLESS_HOLD_MS } from '../src/round.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
// kanban #2174: entry stays open 3 minutes past committee time (the fixture's default is 1.5 s), so the stranger's next batch a minute later
// meets an open round - the cap, not the entry close, is what this measures
const OPEN_MS = 3n * BigInt(LOCKLESS_HOLD_MS);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE,
  committeeTimeMs: 500n, entryCloseMs: 500n + OPEN_MS, startTimeMs: 60500n + OPEN_MS };
const mk = (n) => ({ name: `p${n}`, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const hid = (i) => ({ hidden: { move: i % 3, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });

async function flood(w, from, n) {
  let taken = 0;
  for (let i = 0; i < n; i++) { try { await lockAndPlay(w, mk(from + i), { ...hid(i), only: [] }); taken++; } catch { /* refused */ } }
  return taken;
}
async function honest(w, key) {
  try { await lockAndPlay(w, mk(key), hid(0)); return 'seated'; } catch (e) { return String(e.message).slice(0, 200); }
}

test('#1489 a44-75: a stranger\'s lockless flood does not keep honest locked players out of a paid head-to-head round', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 5 * LOCKLESS_HOLD_MS });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const cap = LOCKLESS_PER_SEAT * 2;
    const flooded = await flood(w, 0x41, cap);
    const first = await honest(w, 0x20);
    // the stranger keeps it up: a minute later, the next batch
    skipTo(testNow() + LOCKLESS_HOLD_MS + 1000);
    const flooded2 = await flood(w, 0x61, cap);
    const second = await honest(w, 0x21);
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    console.log('  FACTS (a44-75):', JSON.stringify({ cap, flooded, first, flooded2, second, seated }));
    assert.equal(first, 'seated', `an honest locked player was refused after ${flooded} lockless entries from a stranger: ${first}`);
    assert.equal(second, 'seated', `an honest locked player was refused after the stranger's next ${flooded2}: ${second}`);
  } finally { await w.close(); }
});
