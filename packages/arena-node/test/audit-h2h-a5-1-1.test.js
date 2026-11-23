// Audit h2h a5 r1 finding 1 (P5/P11, bypass of the #2901 b fix): a round nobody entered gets no lock-set work at any seat - not from its
// lock-set timer and not from a peer's or a stranger's GET /lock-set (#2901 b). GET /reveals (public, no auth) steps the set
// unconditionally (server.js: `lockSets.certified(id) || await lockSets.step(id)`), so one stranger GET per seat per round puts every seat
// back to viewing, signing and certifying empty sets - the ~100 % main-thread load #2901 measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { LOCK_SET_WINDOW_MS, LOCK_SET_VIEW_WAIT_MS } from '../../arena-protocol/src/lock-set.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };

test('a stranger\'s GET /reveals of a round nobody entered makes no seat sign or certify a lock set (as GET /lock-set since #2901 b)', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    skipTo(Number(w.c.entryCloseMs) + 10);
    const ask = () => Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveals?round=${toHex(w.rid)}`).then((r) => r.text()).catch(() => null)));
    await ask();                                   // the stranger, once at each seat at the close
    await wait(LOCK_SET_VIEW_WAIT_MS + 200);
    await ask();                                   // and once more after the view wait
    await wait(LOCK_SET_WINDOW_MS);
    const signed = w.nodes.map((d) => !!d.round.db.prepare('SELECT 1 FROM lock_set_signed WHERE round_id = ?').get(w.rid));
    const certified = w.nodes.map((d) => !!d.lockSets.certified(w.rid));
    console.log(`signed: ${signed.map(Number).join('')} certified: ${certified.map(Number).join('')}`);
    assert.deepEqual(signed, w.nodes.map(() => false), 'a seat signed a lock set for a round nobody entered, on a stranger\'s GET /reveals');
    assert.deepEqual(certified, w.nodes.map(() => false), 'a seat certified an empty lock set on a stranger\'s GET /reveals');
  } finally { await w.close(); }
});
