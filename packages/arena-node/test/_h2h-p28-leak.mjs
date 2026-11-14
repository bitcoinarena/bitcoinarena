// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2536 (#2048, #2126, #2202): the #1598 c/d refutes' "the page sends its move to a lying partner seat before the close" attack, run
// on 1.9's rule for a paying head-to-head round: protocol 28's certified lock set (kanban #2561, ruling #2116 (b)). The page reveals with
// arena-client revealWhenCertified - only once a lock-set certificate stands - so no seat's GET /time, and no clock of the page's, decides when
// the move goes out. The partner seat is the attacker's: it answers /time as told and its round clock runs `partnerSkewMs` ahead, so it
// closes and signs its part of the set early. The attacker holds rock, paper and scissors under three fresh keys with fee locks only and locks
// the winner at every seat the moment the partner holds the honest move.
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { revealWhenCertified } from '../../arena-client/src/head-to-head.js';

// kanban #2536, 2.0: protocol 27 and up is also the Arena lock here (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0) and this fixture's locks
// are stock contracts, so its rounds sit below regtest's named-claim point by the harness switch, as h2h-lock-set-2561 does on 2.0
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const salt = () => new Uint8Array(randomBytes(32));
const outcomes = (w, eid) => w.nodes.map((d) => [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }))].join('|'));
const revealTo = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

/**
 * `n` seats, the last one the partner. `partnerTime(close)`: what the partner answers on GET /time; `partnerSkewMs`: its round clock ahead;
 * `pageSkewMs`: the browser's clock ahead; `pageStartAt(close)`: the real time the page starts its reveal. Answers the facts.
 */
export async function leakRun({ n, keyBase, partnerTime, partnerSkewMs, pageSkewMs, pageStartAt }) {
  const w = await lockRound({ n, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const mk = (i) => ({ name: `p${i}`, key: b32(keyBase + i), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const close = Number(w.c.entryCloseMs);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
    const pd = w.nodes[n - 1];
    const partner = `http://127.0.0.1:${pd.port}`;
    pd.round.now = () => testNow() + partnerSkewMs;
    const sent = [];
    let leaked = null;
    const fetcher = async (u, o) => {
      const s = String(u);
      if (s === `${partner}/time`) return new Response(JSON.stringify({ nowMs: partnerTime(close, testNow()) }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (s.includes('/reveal?')) sent.push({ seat: w.nodes.findIndex((d) => s.startsWith(`http://127.0.0.1:${d.port}/`)), at: testNow() - close });
      if (s.startsWith(`${partner}/reveal?`) && !leaked) leaked = { at: testNow() - close, body: JSON.parse(o.body) };   // the partner's request log
      return fetch(u, o);
    };
    skipTo(pageStartAt(close));
    const page = revealWhenCertified({ roundIdHex: toHex(w.rid), entryIdHex: toHex(honest.eid), move: ROCK, salt: hs, nodes: w.nodes.map((d) => `http://127.0.0.1:${d.port}`),
      entryCloseMs: close, fetcher, now: () => testNow() + pageSkewMs, sleep: async (ms) => { if (testNow() + ms < close - 500) { await wait(20); skipTo(testNow() + ms); } else await wait(ms); } });
    // the attacker watches the partner's log and locks the winner at every seat the moment the move is there
    let answers = null;
    const done = { v: false }; page.then(() => { done.v = true; }, () => { done.v = true; });
    for (let i = 0; i < 400 && !answers && !(done.v && !leaked); i++) {
      if (leaked) {
        const p = moves[BEATS[leaked.body.move]].played;
        answers = await Promise.all(w.nodes.map(async (d, k) => { const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
          return { seat: k, at: testNow() - close, status: r.status, said: (await r.text()).slice(0, 120) }; }));
        break;
      }
      await wait(25);
    }
    const said = await page;
    const winner = leaked ? BEATS[leaked.body.move] : PAPER, p = moves[winner].played;
    skipTo(Math.max(testNow(), close + 400));
    await revealTo(w, honest, ROCK, hs);
    await revealTo(w, p, winner, moves[winner].salt);
    await closeRound(w);
    await untilSettled(w, 20000).catch(() => {});
    for (let i = 0; i < 40 && outcomes(w, honest.eid).slice(0, n - 1).some((x) => !x); i++) await wait(100);
    return { close, sent, leaked: leaked && { at: leaked.at, move: leaked.body.move }, answers, page: { certified: !!said.certified, void: !!said.void, notCertified: !!said.notCertified, seats: (said.seats || []).map((x) => x.status) },
      results: { honest: outcomes(w, honest.eid), attacker: outcomes(w, p.eid) } };
  } finally { await w.close(); }
}
