// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 6 (h2h-1): PUT /transcript/<hash> KEEPS ANY NUMBER OF MADE-UP HEAD-TO-HEAD "REVEAL RECORDS" FOR ONE ENTRY (bypass of #1532).
// The #1532 fix keeps a relayed transcript only when it is the transcript of an entry this seat holds - and, for a head-to-head round,
// any 65 bytes "entry id || move || salt" (or 33 bytes "entry id || 0xff") naming a held entry. The move and salt are never checked against
// the commitment the entry named, so a stranger who knows one public entry id mints 2^256 distinct "reveal records" for it, each under its
// own hash, and every one is kept until the store reaches RELAY_MOST - after which the seat answers 507 to every honest transcript, reveal
// record and slash proof (one door, one cap).
// SAFE: a reveal record that does not open the entry's commitment (move+salt not hashing to entry.commit) is refused; only the true record
// (and at most the one no-reveal record) of a held entry is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
// a small relay store (the live default is 256 MiB), so the test fills it with 200 records instead of ~4 million
process.env.ARENA_RELAY_MOST = String(200 * 65);
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { lockRound, lockAndPlay } = await import('./lock-round-fixture.js');
const { b32 } = await import('./window-fixture.js');
const { skipTo, testNow } = await import('./test-clock.js');
const { NEXTBLOCK } = await import('../../nextblock/plugin/nextblock.js');
const { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } = await import('./plugins/rps/index.js');
const { msForTicks } = await import('../../arena-protocol/src/tick.js');
const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { headToHeadCommit } = await import('../../arena-protocol/src/head-to-head.js');

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0xb0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('#1489 r6-h2h-2: a stranger cannot store made-up reveal records for a held head-to-head entry', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const trueSalt = new Uint8Array(randomBytes(32));
    const p = await lockAndPlay(w, mk(1), { session: mk(1).session, hidden: { move: 0, salt: trueSalt }, noMarks: true, only: [], feeLock: false });
    const seat = w.nodes[0];
    const before = seat.round.relayedBytes();
    let kept = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      // the stranger: the public entry id, a move, and 32 random bytes that open nothing
      const rec = Uint8Array.of(...p.eid, i % 3, ...randomBytes(32));
      const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(rec))}`, { method: 'PUT', body: rec });
      await r.text();
      if (r.status === 201) kept++;
    }
    const grew = seat.round.relayedBytes() - before;
    // and then the player's TRUE reveal record (entry id || rock || its salt), as publish() posts it
    const real = Uint8Array.of(...p.eid, 0, ...trueSalt);
    const rr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(real))}`, { method: 'PUT', body: real });
    const realAns = `${rr.status} ${(await rr.text()).slice(0, 90)}`;
    console.log('  FACTS (r6-h2h-2):', JSON.stringify({ tried: N, kept, relayedBytesGrew: grew, trueRecord: realAns }));
    assert.ok(kept <= 1, `the seat kept ${kept} of ${N} made-up reveal records for one entry (${grew} bytes): none opens its commitment`);
    assert.equal(rr.status, 201, `the true reveal record was refused after the stranger's junk: ${realAns}`);
  } finally { await w.close(); }
});
