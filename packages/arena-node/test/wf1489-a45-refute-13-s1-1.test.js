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
// the 1.9.17 merge's unnamed-transcript caps (kanban #1725, #1795: RELAY_MOST / 32 per entry, / 8 per round) sit under one fork at this
// test's small pool; the per-entry bound under test here is #2242's
process.env.ARENA_RELAY_ENTRY_MOST = String(200 * 65);
process.env.ARENA_RELAY_ROUND_MOST = String(200 * 65);
process.env.ARENA_RELAY_UNNAMED_MOST = String(200 * 65);
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

const { encodeTranscript } = await import('../../arena-protocol/src/transcript.js');
const { SIGNED_CHECKPOINT_BYTES } = await import('../../arena-protocol/src/checkpoint.js');

// kanban #1489 a45-refute-13 (variant of #1824, the other branch of the same PUT /transcript door): the stranger who knows a held
// entry's public id and round id needs no reveal record - a "transcript" naming (round id, entry id) with zero batches and one mark of
// 32+64 random bytes decodes (decodeTranscript checks no signature, no chain, no stateHash), is "ours", and is kept under its own hash.
// 2^768 distinct ones per entry, until RELAY_MOST and every honest transcript / reveal record / slash proof is refused 507.
test('#2242 a45-refute-13-s1-1: a stranger cannot store made-up transcripts for a held entry', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const trueSalt = new Uint8Array(randomBytes(32));
    const p = await lockAndPlay(w, mk(1), { session: mk(1).session, hidden: { move: 0, salt: trueSalt }, noMarks: true, only: [], feeLock: false });
    const seat = w.nodes[0];
    const before = seat.round.relayedBytes();
    let kept = 0, first = '';
    const N = 200;
    for (let i = 0; i < N; i++) {
      const fake = encodeTranscript({ roundId: w.rid, entryId: p.eid, batches: [], marks: [new Uint8Array(randomBytes(SIGNED_CHECKPOINT_BYTES))] });
      const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(fake))}`, { method: 'PUT', body: fake });
      const t = await r.text();
      if (!first) first = `${r.status} ${t.slice(0, 80)}`;
      if (r.status === 201) kept++;
    }
    const grew = seat.round.relayedBytes() - before;
    const real = Uint8Array.of(...p.eid, 0, ...trueSalt);
    const rr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(real))}`, { method: 'PUT', body: real });
    const realAns = `${rr.status} ${(await rr.text()).slice(0, 90)}`;
    console.log('  FACTS (a45-refute-13-1):', JSON.stringify({ tried: N, kept, first, relayedBytesGrew: grew, trueRecord: realAns }));
    assert.ok(kept <= 1, `the seat kept ${kept} of ${N} made-up transcripts for one entry (${grew} bytes): none is a run anyone played`);
    assert.equal(rr.status, 201, `the true reveal record was refused after the stranger's junk: ${realAns}`);
  } finally { await w.close(); }
});

// kanban #2242: the entry's own session key can sign any number of forked mark chains; a relay keeps at most two such
// transcripts per entry it knows by no name, so even the player cannot take the shared store with one entry.
const { encodeCheckpoint, checkpointId, joinSigned } = await import('../../arena-protocol/src/checkpoint.js');
test('#2242 a45-refute-13-s1-2: an entry\'s own signed forks are kept only a bounded number of times', async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const trueSalt = new Uint8Array(randomBytes(32));
    const session = ed25519.utils.randomSecretKey();
    const p = await lockAndPlay(w, mk(1), { session, hidden: { move: 0, salt: trueSalt }, noMarks: true, only: [], feeLock: false });
    const seat = w.nodes[0];
    let kept = 0, first = '';
    for (let i = 0; i < 20; i++) {
      const c = { roundId: w.rid, entryId: p.eid, tick: 1, stateHash: new Uint8Array(randomBytes(32)), inputChainHash: new Uint8Array(32), previousHash: new Uint8Array(32) };
      const mark = joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
      const t = encodeTranscript({ roundId: w.rid, entryId: p.eid, batches: [], marks: [mark] });
      const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(t))}`, { method: 'PUT', body: t });
      const s = `${r.status} ${(await r.text()).slice(0, 60)}`;
      if (!first) first = s;
      if (r.status === 201) kept++;
    }
    const real = Uint8Array.of(...p.eid, 0, ...trueSalt);
    const rr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(real))}`, { method: 'PUT', body: real });
    console.log('  FACTS (a45-refute-13-s1-2):', JSON.stringify({ tried: 20, kept, first, trueRecord: rr.status }));
    assert.ok(kept >= 1, `a transcript the entry's key signed was refused: ${first}`);
    assert.ok(kept <= 2, `the seat kept ${kept} of 20 signed forks for one entry`);
    assert.equal(rr.status, 201);
  } finally { await w.close(); }
});
