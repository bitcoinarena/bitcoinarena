// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-13 skeptic 2 (bypass of #1532 / #1824 / #2242): PUT /transcript/<hash> after 0536df850.
// The #2242 door keeps a transcript (a) whose hash a round signer node's signed result held here names - with NO
// checkTranscript, NO per-entry count and NO size bound - or (b) a checkTranscript-valid one whose marks the entry's
// session key signed, at most RELAY_UNNAMED_PER_ENTRY (2) per entry but of ANY size (up to the 8 MiB body cap).
// The cap counts transcripts, not bytes, and a named one is never counted at all. So:
//  1. ONE committee seat (a signer node, other role than the stranger of s1) signs one result per entry naming a
//     multi-MiB junk transcript (random ticks, broken chain, no marks), gossips it (#keepPeerResult checks only
//     round, player, signer, signature), and PUTs the junk: kept. 8 MiB per entry it sits on - 32 entries fill the
//     live 256 MiB store, then every honest transcript, reveal record and slash proof is refused 507.
//  2. The PLAYER (entry owner) PUTs two checkTranscript-valid, session-signed forks of several MiB each: both kept.
//     2 x 8 MiB per free entry - 16 free entries fill the live store.
//  3. RETRY: a stranger PUTs the entry's empty transcript (kept as "named" though the entry started - nothing checks
//     that), the player's signed transcript is kept, and the very same bytes PUT again (a signer node's publish()
//     retry, a lost 201) are refused 422 - the door is no longer idempotent, and the stranger took a slot.
// Each store here is scaled down as the earlier tests do (ARENA_RELAY_MOST), the attack the same at any size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
const ATTACK = 64 * 1024 * 1024;
process.env.ARENA_RELAY_MOST = String(ATTACK + 30);   // room for the attack and not for one more 65-byte record (live: 256 MiB)
const { ed25519 } = await import('@noble/curves/ed25519.js');
const { schnorr } = await import('@noble/curves/secp256k1.js');
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
const { encodePlayerResult, resultId, joinSignedResult } = await import('../../arena-protocol/src/result.js');

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0xb0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

const put = async (seat, bytes) => {
  const r = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(bytes))}`, { method: 'PUT', body: bytes });
  return `${r.status} ${(await r.text()).slice(0, 70)}`;
};
// a chained run of `n` batches of 3000 ticks each (~60 KB a batch), and one mark signed by `session` over its last head
const bigRun = (rid, eid, n, session, salt) => {
  const batches = []; let prev = new Uint8Array(32), tick = 0;
  for (let i = 0; i < n; i++) {
    const ticks = Array.from({ length: 3000 }, (_, k) => [salt, i, k, 0, 0]);
    const b = { roundId: rid, entryId: eid, previousHash: prev, firstTick: tick, ticks, liquidations: [], loads: [] };
    batches.push(b); prev = batchId(b); tick += 3000;
  }
  if (!session) return { roundId: rid, entryId: eid, batches, marks: [] };
  const c = { roundId: rid, entryId: eid, tick: tick - 1, stateHash: new Uint8Array(randomBytes(32)), inputChainHash: prev, previousHash: NO_PREVIOUS };
  return { roundId: rid, entryId: eid, batches, marks: [joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session))] };
};
const open = async () => {
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  skipTo(Number(w.c.committeeTimeMs) + 20);
  const trueSalt = new Uint8Array(randomBytes(32));
  const who = mk(1), session = ed25519.utils.randomSecretKey();
  const p = await lockAndPlay(w, who, { session, hidden: { move: 0, salt: trueSalt }, noMarks: true, only: [], feeLock: false });
  return { w, p, who, session, real: Uint8Array.of(...p.eid, 0, ...trueSalt) };
};

test('#1489 a45-refute-13-s2-3: re-PUT of a kept transcript stays kept after a stranger stores the empty transcript', async () => {
  const { w, p, session } = await open();
  try {
    const relay = w.nodes[0];
    const empty = encodeTranscript({ roundId: w.rid, entryId: p.eid, batches: [], marks: [] });
    const emptyAns = await put(relay, empty);
    const t = encodeTranscript(bigRun(w.rid, p.eid, 1, session, 3));
    const first = await put(relay, t);
    const again = await put(relay, t);
    console.log('  FACTS (a45-refute-13-s2-3):', JSON.stringify({ emptyAns, first, again }));
    assert.ok(first.startsWith('201'), `the entry's signed transcript was refused: ${first}`);
    assert.ok(again.startsWith('201'), `the same bytes, PUT again (a retry), were refused: ${again}`);
  } finally { await w.close(); }
});
