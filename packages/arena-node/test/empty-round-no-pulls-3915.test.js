// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND NOBODY ENTERED ASKS NO PEER (kanban #3915, owner 2026-11-28): measured on the live Beelink seats, 35-65 requests/s each, GET /lock-set 11.5/s
// and GET /names 12/s of seat 1's - nearly all for the RPS grid's empty rounds: the decide of an empty head-to-head round pulled every peer's lock set
// every LOCK_SET_PULL_MS until its window closed and carried names from every peer. A round with no entry now makes no peer request at its close; a
// round with an entry still certifies its lock set at every seat and decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };

// every peer request of the seats in this process, counted by door
const counts = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => {
  try { const p = new URL(String(u && u.url ? u.url : u)).pathname; counts.set(p, (counts.get(p) || 0) + 1); } catch { /* not a URL */ }
  return realFetch(u, o);
};
const PEER_DOORS = ['/lock-set', '/names', '/reveals'];
const peerAsks = () => Object.fromEntries(PEER_DOORS.map((d) => [d, counts.get(d) || 0]));

test('kanban #3915: an RPS round with no entry makes no peer request at its close (lock set, names, reveals)', async () => {
  const END = testNow() + SPAN_MS + 25000;
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: END });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    await wait(300);
    counts.clear();
    skipTo(Number(w.c.entryCloseMs) + 50);
    await wait(1500);
    skipTo(Number(w.c.entryCloseMs) + LOCK_SET_WINDOW_MS + 500);
    await wait(1500);
    skipTo(Number(w.c.entryCloseMs) + LOCK_SET_WINDOW_MS + 3000);
    await wait(1000);
    // and past the round's end, where the end sweep closes it (closeAtEnd)
    skipTo(END + 1000);
    await wait(2000);
    skipTo(END + 30000);
    await wait(2000);
    const closed = w.nodes.map((d) => d.round.get(w.rid).state);
    const asked = peerAsks();
    console.log('  FACTS (#3915 empty round):', JSON.stringify({ asked, closed }));
    for (const d of PEER_DOORS) assert.equal(asked[d], 0, `an empty round asked its peers ${asked[d]} times at ${d}`);
  } finally { await w.close(); }
});

let k = 0x70;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
test('kanban #3915: a round with an entry still certifies its lock set at every seat', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const a = await lockAndPlay(w, player(), { hidden: { move: 0, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });
    counts.clear();
    skipTo(Number(w.c.entryCloseMs) + 50);
    let sets = [];
    for (let i = 0; i < 60; i++) {
      sets = await Promise.all(w.nodes.map(async (d) => (await realFetch(`http://127.0.0.1:${d.port}/lock-set?round=${toHex(w.rid)}`)).json()));
      if (sets.every((s) => s.certificate)) break;
      await wait(100);
    }
    console.log('  FACTS (#3915 one entry):', JSON.stringify({ certified: sets.map((s) => !!s.certificate), asked: peerAsks() }));
    for (const s of sets) {
      assert.ok(s.certificate, 'a seat holds no certificate for a round with an entry');
      assert.deepEqual(s.entries, [toHex(a.eid)]);
    }
  } finally { await w.close(); }
});
