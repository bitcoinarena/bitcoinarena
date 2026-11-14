// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-find-h2h candidate 2: THE HOUSE RPS OPPONENT FORFEITS EVERY ROUND OF PROTOCOL 28 (new: a protocol-28 rule the bot was never moved to).
// From protocol 28 (kanban #2561) no seat takes a reveal before the round's certified lock set: POST /reveal answers 409 "not certified yet - ask
// again shortly", and the page waits for the certificate (arena-client revealWhenCertified). The house opponent tools/rps-opponent.mjs still
// reveals ONCE, with revealMove, at the entry close + 150 ms, and never again: every seat refuses it, the bot's entry has no reveal, it FORFEITS,
// and whoever sat at its table is the lone revealer and wins - every paid round against the bot, whatever the moves. A player who knows this
// taps every table the bot watches and takes the bot's stake each round.
// Safe behaviour: the reveal made the way the bot makes it (from close + 150 ms) still stands - its committed move plays.
// kanban #2658: the bot now reveals through tools/h2h-reveal.mjs revealAsPage (the page's revealWhenCertified against the contract's committee);
// this test starts that reveal at close + 150 ms, as the bot does, and the first assertion below held red before the fix with revealMove once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { revealMove } from '../../arena-client/src/head-to-head.js';
import { revealAsPage } from '../tools/h2h-reveal.mjs';

// 2.0 (kanban #2658 port): a protocol-28 round names its claims (Arena lock); the fixture's federation answers no LNv2 version, so the
// named-claim height is put past every test round, as h2h-lock-set-2561.test.js does
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';
const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, SCISSORS = 2;
let k = 0x60;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const url = (d, path) => `http://127.0.0.1:${d.port}${path}`;
const outcomes = (nodes, w, eid) => nodes.map((d) => [...new Set(d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }))].join('|'));
const decided = (nodes, w) => Promise.all(nodes.map((d) => fetch(url(d, `/api/round-result?round=${toHex(w.rid)}`)).then((x) => x.json())
  .then((j) => (j.players || []).filter((p) => p.outcome && p.signedBy > 0).length).catch(() => -1)));
const lockSetAt = async (d, w) => (await fetch(url(d, `/lock-set?round=${toHex(w.rid)}`))).json();

test('#1489 r1-h2h-2 / #2658: the house opponent\'s reveal (revealAsPage from close + 150 ms, as tools/rps-opponent.mjs) stands in a protocol-28 round', async () => {
  const endMs = testNow() + SPAN_MS + 40000;
  // seven seats, all up: the certificate forms (each seat holds six peer signatures, so r1-h2h-3 does not interfere)
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sBot = salt(), sP = salt();
    const bot = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sBot }, noMarks: true });
    const human = await lockAndPlay(w, player(), { hidden: { move: SCISSORS, salt: sP }, noMarks: true });
    const close = Number(w.c.entryCloseMs);
    skipTo(close + 150);
    // THE BOT: rps-opponent.mjs - revealAsPage from close + 150 ms (it waits for the certificate), its answer only logged
    const botGoes = revealAsPage({ c: w.c, roundIdHex: toHex(w.rid), entryIdHex: toHex(bot.eid), move: ROCK, salt: sBot, nodes: w.nodes.map((d) => url(d, '')), now: testNow });
    // THE PLAYER'S PAGE: waits for the certificate, then reveals (revealWhenCertified)
    let sets = [];
    for (let i = 0; i < 80; i++) { sets = await Promise.all(w.nodes.map((d) => lockSetAt(d, w))); if (sets.every((s) => s.certificate)) break; await wait(50); }
    const botSaid = (await botGoes).seats || [];
    const humanSaid = await revealMove({ entryIdHex: toHex(human.eid), move: SCISSORS, salt: sP, nodes: w.nodes.map((d) => url(d, '')) });
    // past the reveal deadline (the round's end): the seats close and decide
    skipTo(endMs + 500);
    await closeRound(w, { window: false });
    let n = w.nodes.map(() => 0);
    for (let i = 0; i < 80 && !n.every((v) => v >= 2); i++) { await wait(100); n = await decided(w.nodes, w); }
    const facts = { botSaid: botSaid.map((x) => `${x.status} ${x.why || ''}`.slice(0, 90)), certAtMs: sets.map((s) => s.certifiedAtMs && s.certifiedAtMs - close),
      humanSaid: humanSaid.map((x) => x.status), decided: n, bot: outcomes(w.nodes, w, bot.eid), human: outcomes(w.nodes, w, human.eid) };
    console.log('  FACTS r1-h2h-2:', JSON.stringify(facts));
    assert.ok(sets.every((s) => s.certificate), 'the fixture: the lock set is certified');
    // rock beats scissors: the bot's committed move wins - unless its reveal never stood, and it forfeits to the lone revealer
    for (const per of facts.bot) assert.equal(per, 'DELIVERED 2', `the bot's committed rock did not play - its reveal was refused and it forfeited: ${JSON.stringify(facts)}`);
  } finally { await w.close(); }
});
