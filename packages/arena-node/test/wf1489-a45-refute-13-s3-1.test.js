// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-13 skeptic 3 (bypass of #1532 / #1824 / #2242 / #2324 / #2341 / #2347): PUT /transcript/<hash> on 651a20de5.
// The #2341 bound is PER ENTRY (relayEntryMost(blockTicks) = 3 x (64 KiB + 256 B a tick), 657 KB in a 600-tick round, ~3.9 MB live),
// and the shared cap RELAY_MOST is for the whole seat. A free round takes any number of entries, each under a fresh session key
// (#1479 is one entry per session key, not per person): one attacker enters K times for nothing and PUTs, per entry, two
// checkTranscript-valid forks its own session key signed, each inside the entry's byte budget. K x 657 KB here, K x 3.9 MB live:
// 66 free entries fill the live 256 MiB store, and then a victim's transcript (and every reveal record, every honest transcript, every slash
// proof) is refused 507 - the effect #1824 claims to have closed. The store is scaled down as the earlier tests do (ARENA_RELAY_MOST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const { encodeTranscript: enc0 } = await import('../../arena-protocol/src/transcript.js');
const { SIGNED_CHECKPOINT_BYTES: SCB0 } = await import('../../arena-protocol/src/checkpoint.js');
const K = 3, BATCHES = 5;
const FORK = (() => { const z = new Uint8Array(32); const bs = []; for (let i = 0; i < BATCHES; i++) bs.push({ roundId: z, entryId: z, previousHash: z, firstTick: i * 3000, ticks: Array.from({ length: 3000 }, (_, k) => [1, i, k, 0, 0]), liquidations: [], loads: [] }); return enc0({ roundId: z, entryId: z, batches: bs, marks: [new Uint8Array(SCB0)] }).length; })();
process.env.ARENA_RELAY_MOST = String(K * 2 * FORK + 30);   // room for the attack and not for the victim's ~70-byte transcript (live: 256 MiB)
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { lockRound, lockAndPlay } = await import('./lock-round-fixture.js');
const { b32 } = await import('./window-fixture.js');
const { skipTo, testNow } = await import('./test-clock.js');
const { NEXTBLOCK } = await import('../../nextblock/plugin/nextblock.js');
const { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } = await import('./plugins/rps/index.js');
const { msForTicks } = await import('../../arena-protocol/src/tick.js');
const { transcriptBytesHash } = await import('../../arena-protocol/src/posting.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { encodeTranscript, checkTranscript, decodeTranscript } = await import('../../arena-protocol/src/transcript.js');
const { batchId } = await import('../../arena-protocol/src/batch.js');
const { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } = await import('../../arena-protocol/src/checkpoint.js');

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0xb0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });
const put = async (seat, bytes) => {
  const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(bytes))}`, { method: 'PUT', body: bytes });
  return `${r.status} ${(await r.text()).slice(0, 70)}`;
};
const fork = (rid, eid, n, session, salt) => {
  const batches = []; let prev = new Uint8Array(32), tick = 0;
  for (let i = 0; i < n; i++) {
    const ticks = Array.from({ length: 3000 }, (_, k) => [salt, i, k, 0, 0]);
    const b = { roundId: rid, entryId: eid, previousHash: prev, firstTick: tick, ticks, liquidations: [], loads: [] };
    batches.push(b); prev = batchId(b); tick += 3000;
  }
  const c = { roundId: rid, entryId: eid, tick: tick - 1, stateHash: new Uint8Array(randomBytes(32)), inputChainHash: prev, previousHash: NO_PREVIOUS };
  return { roundId: rid, entryId: eid, batches, marks: [joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session))] };
};

test('#1489 a45-refute-13-s3-1: free sybil entries, each inside its byte budget, cannot fill a relay together', async () => {
  // a free NextBlock round (no seat limit; RPS seats 2)
  const w = await lockRound({ stakeMsat: 0n, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const relay = w.nodes[0];
    // the victim: an honest entry; what is PUT for it is its empty transcript, which the door keeps as "named" (one hash per entry)
    const victim = await lockAndPlay(w, mk(1), { session: ed25519.utils.randomSecretKey(), noMarks: true, only: [], feeLock: false });
    const real = encodeTranscript({ roundId: w.rid, entryId: victim.eid, batches: [], marks: [] });
    // the attacker: K free entries, each its own fresh session key
    const answers = [];
    for (let k = 0; k < K; k++) {
      const session = ed25519.utils.randomSecretKey();
      const p = await lockAndPlay(w, mk(10 + k), { session, noMarks: true, only: [], feeLock: false });
      for (const salt of [1, 2]) {
        const t = encodeTranscript(fork(w.rid, p.eid, BATCHES, session, salt + 10 * k));
        assert.equal(checkTranscript(decodeTranscript(t)).ok, true);
        answers.push(`${t.length}B ${(await put(relay, t)).slice(0, 3)}`);
      }
    }
    const realAns = await put(relay, real);
    console.log('  FACTS (a45-refute-13-s3-1):', JSON.stringify({ K, answers, relayed: relay.round.relayedBytes(), relayMost: process.env.ARENA_RELAY_MOST, trueRecord: realAns }));
    assert.ok(realAns.startsWith('201'), `${K} free entries of one attacker, two signed forks each inside the per-entry budget (${answers.join('; ')}), took the whole store: the victim's own (empty) transcript got ${realAns}`);
  } finally { await w.close(); }
});
