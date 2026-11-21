// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 r1-find-entry 11 (a bypass of #1605 / #2136 / #2415): ONE REAL LOCK PINS ANY NUMBER OF HANDOUTS. POST /handout pins a handout "for good"
// (round.js pinHandout) when the client shows a stake lock the federation holds whose image is the handout's A0 and whose refund key is the handout
// player's. Nothing binds the lock to ONE handout: a handout carries no player signature, and the same A0 with fresh higher coefficients is a new
// handout id every time. So one lock - the stranger's own, or any player's copied from public data (outpoint and fields) - pins an unbounded number
// of forged handouts. Pinned handouts are never loose, never pushed out, and do not count against HANDOUTS_LOOSE_CEILING: the store grows without
// bound, and every POST /refused-lock and looseHandouts call decodes them all.
// SAFE: a round's handout store stays bounded (at most HANDOUTS_LOOSE_CEILING plus a handful) however many handouts one lock is shown with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.ARENA_HANDOUTS_UNENTERED_MAX = '4';   // the ceiling is then 32 x 4 = 128
const { lockRound } = await import('./lock-round-fixture.js');
const { b32, rand, secretScalar } = await import('./window-fixture.js');
const { skipTo, testNow } = await import('./test-clock.js');
const { NEXTBLOCK } = await import('../../nextblock/plugin/nextblock.js');
const { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } = await import('./plugins/rps/index.js');
const { msForTicks } = await import('../../arena-protocol/src/tick.js');
const { STAKE_LOCK_HEADER } = await import('../src/server.js');
const { feldmanGroup } = await import('../src/curve.js');
const { dealHandout, encodeHandout } = await import('../../arena-protocol/src/handout.js');
const { FIELD, scalarFrom32 } = await import('../../arena-protocol/src/shares.js');
const { refundKeyOf, lockFieldsToJson } = await import('../../arena-protocol/src/stake-lock.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE,
  committeeTimeMs: 500n, entryCloseMs: 600500n, startTimeMs: 660500n };
const base = (d) => `http://127.0.0.1:${d.port}`;
const CEILING = 128, POSTS = 170;

test('#1489 r1-entry-11: one stake lock shown with many forged handouts does not grow a round\'s handout store without bound', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 700000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const key = b32(0x33), preimage = secretScalar(), needed = w.needed || 2;
    const deal = async () => {
      const e = rand(32);
      const d = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
        coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
      assert.equal(d.ok, true, d.why);
      return d.handout;
    };
    const first = await deal();
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: first.commitments[0] }, amountMsat: 1000n, claimPk: w.claimPk, refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);   // ONE real lock
    const shown = { [STAKE_LOCK_HEADER]: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) };
    const seat = w.nodes[0];
    const statuses = {};
    for (let i = 0; i < POSTS; i++) {
      const h = i === 0 ? first : await deal();   // same A0 (the lock's image), fresh coefficients: a new handout id each time
      const r = await fetch(`${base(seat)}/handout`, { method: 'POST', body: encodeHandout(h), headers: shown });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      await r.arrayBuffer();
    }
    const held = seat.round.handoutCount(w.rid);
    const pinned = seat.round.db.prepare('SELECT COUNT(*) AS n FROM handout_locks WHERE round_id = ?').get(Buffer.from(w.rid)).n;
    console.log('  FACTS (r1-entry-11):', JSON.stringify({ posts: POSTS, statuses, held, pinned, ceiling: CEILING }));
    assert.ok(held <= CEILING + 4, `one lock pinned ${pinned} handouts and the round holds ${held}, above the ceiling ${CEILING}: the store grows with every forged handout`);
  } finally { await w.close(); }
});
