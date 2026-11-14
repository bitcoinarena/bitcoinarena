// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489, skeptic 3 (round d) on #1598 at fc82f422b: the #2126 deadline cap (revealByMs) is what the page and tools now pass, and the
// s2-1 test never passed it. With it, a partner seat lying fast moves capAt - its own clock - before the real close.
// kanban #1489, skeptic 2 (round d) on #1598 at 5391751f5: A SEAT VOUCHES FOR THE FAST BROWSER'S CLOCK AND THE #2124 CAP SENDS THE MOVE 10-20 s EARLY.
// #2124 reads the maxSkewMs cap by "the upper middle seat" when the two middle /time answers differ by more than maxSkewMs and the upper one is
// nearer this browser's clock. On two seats (the head-to-head default) the attacker's partner seat simply answers GET /time with the browser's own
// (30 s fast) clock: it is the upper median, it is nearer the browser (offset 0), so capBy = the liar and the post goes out at the browser's close
// + 10 s = 20 s before the real close to the liar, and byRound + maxSkewMs = 10 s before the real close to the honest seat - more than
// H2H_EARLY_OUT_MS early: refused (409), no mark (#2105). The partner reads the body and the attacker (rock, paper, scissors under three fresh
// session keys, fee locks only) hands only the winner's stake lock to the honest seat before its close: DELIVERED 2 there.
// kanban #2536 (re-check on 1.9 acbc1948c): #1598 is closed by the certified lock set (protocol 28, #2561, ruling #2116 (b)); rounds
// below 28 keep the old rules byte for byte by that ruling. The test is adapted to a protocol-28 round and its page
// (revealWhenCertified, as index.html calls it: the committee's threshold certificate, no /time); same attack - the partner seat
// answers /time one hour fast and logs every body, the browser is 30 s fast, the attacker locks only the winner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { revealWhenCertified } from '../../arena-client/src/head-to-head.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';

// kanban #2536, 2.0: protocol 27 and up is also the Arena lock here (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0) and this fixture's locks
// are stock contracts, so its rounds sit below regtest's named-claim point by the harness switch, as h2h-lock-set-2561 does on 2.0
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, entryCloseMs: 40500n, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x90 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const revealTo = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('#1598 refute d s3-2: the partner seat answers /time one hour fast; with revealByMs the #2126 cap sends it the move at once, 30 s early', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 2, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hLockLeadMs: 1000, closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
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
    const FAST = 30000;
    const partner = `http://127.0.0.1:${w.nodes[1].port}`;
    let leaked = null;
    const sent = [];
    const fetcher = async (u, o) => {
      const s = String(u);
      // THE PARTNER SEAT'S WORD: its /time is the browser's own clock (it vouches for it), nothing else about it changes
      if (s === `${partner}/time`) return new Response(JSON.stringify({ nowMs: testNow() + 3600000 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (s.includes('/reveal?')) sent.push({ seat: s.startsWith(partner) ? 1 : 0, at: testNow() - close });
      if (s.startsWith(`${partner}/reveal?`) && !leaked) leaked = { at: testNow() - close, body: JSON.parse(o.body) };   // the partner's request log
      return fetch(u, o);
    };
    skipTo(close - FAST + 120);   // the page calls reveal at its own close + 120 ms
    const page = revealWhenCertified({ roundIdHex: toHex(w.rid), entryIdHex: toHex(honest.eid), move: ROCK, salt: hs, nodes: w.nodes.map((d) => `http://127.0.0.1:${d.port}`),
      committee: w.nodes.map((d) => toHex(d.round.pubkey)), verify: (sg, m, k) => schnorr.verify(sg, m, k), entryCloseMs: close,
      now: () => testNow() + FAST, sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 50))), fetcher });
    for (let i = 0; i < 100 && !leaked; i++) await new Promise((ok) => setTimeout(ok, 10));
    const lockWinner = async () => {
      const winner = BEATS[leaked.body.move], p = moves[winner].played;
      const answers = await Promise.all([0, 1].map(async (i) => { const r = await fetch(`http://127.0.0.1:${w.nodes[i].port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
        return { seat: i, at: testNow() - close, status: r.status, said: (await r.text()).slice(0, 160) }; }));
      return { winner, p, answers };
    };
    let att = leaked ? await lockWinner() : null;
    skipTo(close + 300);
    const said = await page;
    if (!att && leaked) att = await lockWinner();
    const { winner, p, answers } = att || { winner: null, p: moves[PAPER].played, answers: [] };
    const seats = said.seats || [];
    skipTo(close + 400);
    if (att) await revealTo(w, p, winner, moves[winner].salt);
    await closeRound(w);
    await untilSettled(w, 20000).catch(() => {});
    const got = { attacker: results(w, p.eid), honest: results(w, honest.eid) };
    console.log('  FACTS (#1598 refute d s3-2: the):', JSON.stringify({ leaked: leaked && { at: leaked.at, move: leaked.body.move }, said: { certified: !!said.certified, void: !!said.void }, sent, winner, answers, page: seats.map((s) => s.status), heldAt: w.nodes.map((d) => !!d.round.stakeLock(p.eid)), results: got }));
    assert.ok(sent.every((x) => x.at >= 0), `the page sent its move before the seats' close: ${JSON.stringify(sent)}`);
    assert.ok(!got.attacker[0].includes('DELIVERED 2'), `a stake lock chosen from a move the page sent early won at the honest seat: ${JSON.stringify({ answers, got })}`);
  } finally { await w.close(); }
});
