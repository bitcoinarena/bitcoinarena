// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 6 (h2h-3): ONE PEER'S JUNK GET /order-locks ANSWER KEEPS AN HONEST SEAT FROM EVER SIGNING A PAID HEAD-TO-HEAD ROUND (P4).
// At a head-to-head close every seat first runs membersKnown (server.js), and for each entry it holds that lacks a lock it asks every
// peer's GET /order-locks (takeEntryParts). A seat that verified no lock answers 404 and is dropped; any 200 is tried, and the reason of the
// LAST answer that failed becomes `wait`. So for an entry nobody locked - an abandoned join, or a stranger's lockless entry - one peer that
// answers 200 with junk lock fields sets `wait` on every pass, and membersKnown loops until the round's result window ends and then answers
// false: "this seat signs nothing for it". The two real players' results are never signed at the honest seat.
// SAFE: one peer's junk lock for an entry no seat locked does not keep an honest seat from signing the seated players' results.
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

async function play({ evil }) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // an abandoned join: its entry at every seat, no lock anywhere
    const c = await lockAndPlay(w, mk(3), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    const [honest, bad] = w.nodes;
    if (evil) {
      // seat b, toward its peers: a 200 with junk lock fields for the entry nobody locked
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${bad.port}/order-locks?entry=${toHex(c.eid)}`))
          return new Response(JSON.stringify({ entry: toHex(c.eid), stake: { junk: true }, fee: null }), { status: 200, headers: { 'content-type': 'application/json' } });
        return realFetch(url, opts);
      };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb);
    await Promise.race([closeRound(w, { window: false }), sleep(15000)]);
    for (let i = 0; i < 40 && !(honest.round.hasResult(w.rid, a.eid, honest.round.pubkey) && honest.round.hasResult(w.rid, b.eid, honest.round.pubkey)); i++) await sleep(250);
    const signed = { a: honest.round.hasResult(w.rid, a.eid, honest.round.pubkey), b: honest.round.hasResult(w.rid, b.eid, honest.round.pubkey) };
    return { signed, cVoid: !!honest.round.entryVoid(c.eid) };
  } finally { globalThis.fetch = realFetch; await w.close(); }
}

test('#1489 r6-h2h-3 control: with honest peers the seat signs both seated players', async () => {
  const got = await play({ evil: false });
  console.log('  FACTS (r6-h2h-3 control):', JSON.stringify(got));
  assert.ok(got.signed.a && got.signed.b, `control: the honest seat did not sign: ${JSON.stringify(got)}`);
});

test('#1489 r6-h2h-3: one peer\'s junk /order-locks answer does not keep an honest seat from signing', async () => {
  const got = await play({ evil: true });
  console.log('  FACTS (r6-h2h-3 attack):', JSON.stringify(got));
  assert.ok(got.signed.a && got.signed.b, `the honest seat signed nothing for the two seated players after one peer's junk lock for an entry nobody locked: ${JSON.stringify(got)}`);
});
