// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1829 / #2244 / #2327 (skeptic 3, second copies): 726c67b5f caps entry-relay.js handLocks' read of a committee peer's
// GET /order-locks (jsonUpTo, 64 kB), but server.js takeEntryParts - run by membersKnown for every entry at every head-to-head close, on every
// pass - reads the SAME door of the SAME peers with `(r) => r.json()`, no byte limit, and GET /payout-address the same way. One committee
// seat answering tens of MB of whitespace + '{}' is buffered and parsed whole by every honest committee seat, for every entry, every pass.
// SAFE: a peer's GET /order-locks / GET /payout-address answer is read only up to a small cap, as handLocks reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xc0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

const PADDED = 32 * 1024 * 1024, CHUNK = 256 * 1024, CAP = 4 * 1024 * 1024;
// a 200 whose body is PADDED bytes of spaces and then '{}' - valid JSON, so r.json() takes it whole; counts what the reader pulled
const padded = (st) => {
  let sent = 0; const space = new Uint8Array(CHUNK).fill(0x20);
  st.asked++;
  const body = new ReadableStream({
    pull(ctl) {
      if (sent >= PADDED) { ctl.enqueue(new TextEncoder().encode('{}')); st.pulled += 2; ctl.close(); return; }
      sent += CHUNK; st.pulled += CHUNK; ctl.enqueue(space);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

async function play(door) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  const st = { asked: 0, pulled: 0 };
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // an abandoned join: its entry at every seat, no lock anywhere and no payout address - takeEntryParts asks every peer for both
    const c = await lockAndPlay(w, mk(3), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    const [, bad] = w.nodes;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(`http://127.0.0.1:${bad.port}/${door}?entry=${toHex(c.eid)}`)) return padded(st);
      return realFetch(url, opts);
    };
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb);
    await Promise.race([closeRound(w, { window: false }), sleep(15000)]);
    for (let i = 0; i < 40 && st.asked === 0; i++) await sleep(250);
    await sleep(500);
    return st;
  } finally { globalThis.fetch = realFetch; await w.close(); }
}

for (const door of ['order-locks', 'payout-address']) {
  test(`wf1489-a45-refute-16-s3-1: a committee peer's padded GET /${door} is not read whole by takeEntryParts`, async () => {
    const st = await play(door);
    const per = st.asked ? Math.round(st.pulled / st.asked) : 0;
    console.log(`  FACTS (${door}): the bad seat was asked ${st.asked} time(s); ${st.pulled} bytes pulled in all, ${per} per ask (cap ${CAP})`);
    assert.ok(st.asked >= 1, `no seat asked the bad peer's GET /${door}`);
    assert.ok(per <= CAP, `an honest seat read ${per} bytes of one peer's GET /${door} answer (cap ${CAP})`);
  });
}
