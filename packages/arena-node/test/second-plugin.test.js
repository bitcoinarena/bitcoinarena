// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SECOND GAME ON THE SAME NODES AS NEXTBLOCK (2026-10-06/07: "Done when a round of a second,
// minimal test plugin opens, replays and settles on the same nodes as nextblock").
//
// Two signer nodes host two games: nextblock (core/plugin/nextblock.js, as the launcher hands it) and tally
// (test/plugins/tally: one input number a tick, the score is the sum, a run finishes at its round's run length). A paying
// tally round opens on them, two players play it, the nodes replay each run with tally's core and sign that core's
// results, and the round settles ACCEPTED. Then a paying nextblock round opens on the same two nodes and settles too. A
// round naming a game neither node hosts is refused at the door, by its id, and nothing of it is stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, WINNER, LOSER } from './window-fixture.js';
import { NEXTBLOCK, TRUCK } from '../../nextblock/plugin/nextblock.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// A TALLY ROUND: its game, its core and config, a run of 600 ticks, a first mark due by tick 300.
const TALLY_ROUND = { gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
const TALLY_PLAY = { adapter: TALLY_CORE.adapter, config: {} };
// Two tally players: 7 a tick and 2 a tick, every tick of the run.
const HIGH = { name: 'high', key: b32(0x21), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0] };
const LOW = { name: 'low', key: b32(0x22), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] };

const signedResults = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => {
  const p = decodePlayerResult(splitSignedResult(r.bytes).body);
  return { outcome: p.outcome, score: p.score, core: toHex(p.simCoreHash) };
}));

test('a round of tally, a second minimal game, opens, replays and settles ACCEPTED on the same two nodes as a nextblock round; a round of a game they do not host is refused by name', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, TALLY] }, round: TALLY_ROUND });
  try {
    // THE TALLY ROUND: opened on both nodes by lockRound (201 at each), played by tally's core
    const high = await lockAndPlay(w, HIGH, { game: TALLY_PLAY, address: true });
    const low = await lockAndPlay(w, LOW, { game: TALLY_PLAY });
    await closeRound(w);
    const tally = await untilSettled(w);
    const tallyResults = { high: signedResults(w, high.eid), low: signedResults(w, low.eid) };
    // A GAME THAT DRAWS NO PICTURE HAS NO GHOST, said for that reason (hole 2 of comment 747), on the slow and the live path
    const tallyGhost = { frame: w.a.ghosts.frameFor(w.rid, high.eid, 300), latest: w.a.ghosts.latest(w.rid, high.eid) };

    // THE NEXTBLOCK ROUND ON THE SAME TWO NODES
    const n = await openLockRound(w);
    const won = await lockAndPlay(n, WINNER, { address: true });
    const lost = await lockAndPlay(n, LOSER);
    await closeRound(n);
    const nextblock = await untilSettled(n);
    const nextblockResults = { won: signedResults(n, won.eid), lost: signedResults(n, lost.eid) };
    const truckGhost = n.a.ghosts.frameFor(n.rid, won.eid, 600);

    // A ROUND OF A GAME NEITHER NODE HOSTS
    const stranger = { ...n.c, gameId: b32(0x99) };
    const refused = await Promise.all(w.nodes.map(async (d) => {
      const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(stranger) });
      const held = await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(roundId(stranger))}`);
      return { status: r.status, why: (await r.text()).trim(), held: held.status };
    }));

    console.log('  FACTS (second plugin):', JSON.stringify({
      games: [toHex(NEXTBLOCK.gameId).slice(0, 16), toHex(TALLY_GAME_ID).slice(0, 16)],
      tally: { round: toHex(w.rid).slice(0, 16), state: tally.state, why: tally.why, results: tallyResults },
      nextblock: { round: toHex(n.rid).slice(0, 16), state: nextblock.state, why: nextblock.why, results: nextblockResults },
      refused: refused.map((r) => ({ ...r, why: r.why.slice(0, 120) })),
      ghosts: { tally: tallyGhost, truck: { ok: truckGhost.ok, why: truckGhost.why, x: truckGhost.ghost && truckGhost.ghost.x } },
    }));
    for (const [k, g] of Object.entries(tallyGhost)) {
      assert.equal(g.ok, false, `${k}: a tally run was pictured`);
      assert.equal(g.why, 'tally draws no picture, so its runs have no ghost', k);
    }
    assert.equal(truckGhost.ok, true, truckGhost.why);

    // TALLY: each run replayed by tally's core at both nodes, DELIVERED, scored by its sum; the round settled
    for (const [k, per, sum] of [['high', tallyResults.high, 600 * 7], ['low', tallyResults.low, 600 * 2]])
      for (const [i, held] of per.entries()) {
        assert.ok(held.length >= 1, `${k}: node ${i} holds no signed result`);
        for (const r of held) assert.deepEqual(r, { outcome: 'DELIVERED', score: sum, core: TALLY_CORE.hash }, `${k} at node ${i}`);
      }
    assert.equal(tally.state, 'ACCEPTED', tally.why);
    // NEXTBLOCK: replayed by the truck's core on the same nodes, and settled
    for (const per of Object.values(nextblockResults)) for (const held of per) for (const r of held) assert.equal(r.core, TRUCK.hash);
    assert.equal(nextblock.state, 'ACCEPTED', nextblock.why);
    // THE STRANGER: refused at each node by the game it names, nothing stored
    for (const r of refused) {
      assert.equal(r.status, 409, r.why);
      assert.match(r.why, /this node does not host game 9999999999999999/);
      assert.equal(r.held, 404, 'a round of a game this node does not host was stored');
    }
  } finally { await w.close(); }
});
