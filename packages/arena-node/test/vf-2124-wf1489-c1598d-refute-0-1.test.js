// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 skeptic (round d) on #1598 at 496b8db5b: THE PAGE'S maxSkewMs CAP SENDS THE MOVE >5 s BEFORE THE CLOSE, AND #2105 NO LONGER MARKS IT.
// arena-client revealMove (the page's reveal, #2006/#2047) waits by the seats' agreed clock, but "never more than maxSkewMs (10 s) past the close by
// this browser's clock": a browser whose clock runs 30 s fast (no NTP: a VM, a phone set by hand) calls reveal at its own close + 120 ms and posts
// { move, salt } to every seat at byRound + maxSkewMs = 10 s before the seats' (right) close, and retries 5 x 400 ms - all more than
// H2H_EARLY_OUT_MS (5 s) before the close, so since #2105 no seat marks the round (h2hEarlyOut), and every seat refused it, so none holds it.
// One seat of three is the attacker's partner (the one-seat assumption of b s2/s3/s4 and c s2-2/s3): it reads the body off its request.
// The attacker - rock, paper, scissors under three fresh session keys, fee locks only - hands only the winner's stake lock to the two honest
// seats ~10 s before their close: no reveal held anywhere, no early mark, no peer holds a move: both write it, 2 of 3, DELIVERED 2.
// Safe: the honest player is not beaten by a lock chosen after his move went out.
// kanban #2536 (re-check on 1.9 acbc1948c): #1598 is closed by the certified lock set (protocol 28, #2561, ruling #2116 (b)); rounds
// below 28 keep the old rules byte for byte by that ruling. The test is adapted to a protocol-28 round and its page
// (revealWhenCertified, as index.html calls it), the browser still 30 s fast; same attack - the partner seat logs every body, the
// attacker locks only the winner of what it read.
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

test('#1598 refute d-1: a browser 30 s fast reveals 10 s before the close (maxSkewMs); no seat marks it (#2105); the partner seat leaks it; the winner alone is locked', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 3, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hLockLeadMs: 1000, closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
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
    const partner = `http://127.0.0.1:${w.nodes[2].port}`;
    let leaked = null;
    const fetcher = async (u, o) => {
      const s = String(u);
      if (s.startsWith(`${partner}/reveal?`) && !leaked) leaked = { at: testNow() - close, body: JSON.parse(o.body) };   // the partner's request log
      return fetch(u, o);
    };
    // the page: its clock 30 s fast; it calls reveal at its own close + 120 ms; its waits pass on the shared test clock
    const FAST = 30000;
    skipTo(close - FAST + 120);
    const statuses = [];
    const page = revealWhenCertified({ roundIdHex: toHex(w.rid), entryIdHex: toHex(honest.eid), move: ROCK, salt: hs, nodes: w.nodes.map((d) => `http://127.0.0.1:${d.port}`),
      committee: w.nodes.map((d) => toHex(d.round.pubkey)), verify: (sg, m, k) => schnorr.verify(sg, m, k), entryCloseMs: close,
      now: () => testNow() + FAST, sleep: (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 50))),
      fetcher: async (u, o) => { const r = await fetcher(u, o); if (String(u).includes('/reveal?')) statuses.push({ at: testNow() - close, status: r.status }); return r; } });
    for (let i = 0; i < 100 && !leaked; i++) await new Promise((ok) => setTimeout(ok, 10));
    const leakedBefore = leaked;
    const lockWinner = async () => {
      const winner = BEATS[leaked.body.move], p = moves[winner].played;
      const answers = await Promise.all([0, 1, 2].map(async (i) => { const r = await fetch(`http://127.0.0.1:${w.nodes[i].port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
        return { seat: i, at: testNow() - close, status: r.status, said: (await r.text()).slice(0, 160) }; }));
      return { winner, p, answers };
    };
    let att = leakedBefore ? await lockWinner() : null;
    // the close: the attacker, if it read nothing yet, locks the winner of what it reads after the close
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
    console.log('  FACTS (#1598 refute d-1):', JSON.stringify({ leaked: leaked && { at: leaked.at, move: leaked.body.move }, page: { certified: !!said.certified, void: !!said.void, why: said.why }, early: statuses, winner, answers, seats: seats.map((s) => s.status), heldAt: w.nodes.map((d) => !!d.round.stakeLock(p.eid)), results: got }));
    assert.ok(!leaked || leaked.at >= 0, `the page sent its move before the close (${leaked && leaked.at})`);
    assert.ok(!got.attacker.slice(0, 2).some((per) => per.includes('DELIVERED 2')), `a stake lock chosen from a move the page sent 10 s early won at the honest seats: ${JSON.stringify({ answers, got })}`);
  } finally { await w.close(); }
});
