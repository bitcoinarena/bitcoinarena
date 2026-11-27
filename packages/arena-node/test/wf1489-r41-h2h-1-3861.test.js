// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r41 (h2h-1): ONE LOCKLESS ENTRY FROM A STRANGER BLANKS EVERY SIGNED HEAD-TO-HEAD RESULT ON THE PAGE.
// The #2241 fix made the page's ARENA_GAME.result (src/arena-ui/index.html validAnswer) drop every seat answer of a head-to-head round
// that lists more than two players ("a head-to-head round of two holds at most two entries"). But an honest seat's GET /api/round-result
// lists EVERY entry it holds (round.entriesOf), and a paid round holds up to LOCKLESS_PER_SEAT x players entries with no stake lock
// (round.js, #1745), and any certified-but-unseated entry. Role (d): a stranger who only knows the public round id posts one handout and
// one entry with no lock to each seat before the close. Every honest seat then answers three players, the page drops all of them, and
// the player's tab never shows the verdict the seats signed (the RPS client reads `outcome` + `signedBy > 0` for its WON / LOST banner).
// SAFE: with the honest pair seated and signed, a stranger's lockless third entry does not keep the signed verdict off the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pageFunction } from '../../arena-client/test/page-script.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
let k = 0x50;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const reveal = (w, p, move, s) => Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(p.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) }).then((x) => x.status)));

// the page's own ARENA_GAME.result, lifted as the #2241 tests lift it, fed the seats' real answers under one host name each
const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const SLICE = "async (id) => {\n          const h = readHidden().find((x) => x.roundIdHex === id);\n          // THE FIRST SECONDS AFTER THE CLOSE";
async function pageResult(roundIdHex, mineHex, answers) {
  const fs = await import('node:fs');
  const html = fs.readFileSync(PAGE, 'utf8');
  const at = html.indexOf(SLICE); assert.ok(at > 0, 'the page holds ARENA_GAME.result');
  const endTxt = 'return best || none;\n        }';
  const body = html.slice(at, html.indexOf(endTxt, at) + endTxt.length);
  const nodes = Object.keys(answers);
  const fetchFn = async (url) => { const seat = String(url).split('/api/')[0]; const a = answers[seat]; if (a === undefined) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => a }; };
  const hidden = [{ roundIdHex, entryIdHex: mineHex, entryCloseMs: Date.now() - 60000, nodes }];
  const fn = pageFunction(PAGE, ['readHidden', 'resultsSeen', 'revealsSeen', 'game', 'provisional', 'saidProvisionally', 'checkSigned', 'fetch', 'AbortSignal', 'window'], body, '', 'return ');
  const result = fn(() => hidden, new Map(), new Map(), { manifest: { resultType: 3 } }, () => null, (id, p) => p, () => {}, fetchFn, { timeout: () => undefined }, {});
  return result(roundIdHex);
}

test('wf1489-r41-h2h-1: a stranger\'s lockless third entry keeps the seats\' signed head-to-head verdict off the page', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    // THE STRANGER: a handout and an entry at every seat while a seat is free, no stake lock anywhere, no sats (as wf1489-r5-h2h-1's stranger)
    await lockAndPlay(w, player(), { hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [], stakeHeld: false, lockFirst: false });
    const alice = await lockAndPlay(w, player(), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const bob = await lockAndPlay(w, player(), { hidden: { move: SCISSORS, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, alice, ROCK, sa);
    await reveal(w, bob, SCISSORS, sb);
    await closeRound(w, { window: false });
    const rid = toHex(w.rid);
    let answers;
    for (let i = 0; i < 40; i++) {
      answers = await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${rid}`).then((x) => x.json())));
      if (answers.every((j) => (j.players || []).some((p) => p.entry === toHex(alice.eid) && p.signedBy > 0))) break;
      await wait(250);
    }
    const seatSaid = answers.map((j) => (j.players || []).map((p) => ({ e: p.entry.slice(0, 8), o: p.outcome, s: p.score, by: p.signedBy })));
    // the seats themselves are right: Alice (rock over scissors) signed DELIVERED 2 at both seats
    const aliceAt = answers.map((j) => j.players.find((p) => p.entry === toHex(alice.eid)));
    assert.ok(aliceAt.every((p) => p && p.outcome === 'DELIVERED' && p.score === 2 && p.signedBy > 0), `both seats signed Alice's win: ${JSON.stringify(seatSaid)}`);
    // CONTROL: the same answers with the stranger's row left out - the page shows the win both seats signed
    const two = Object.fromEntries(answers.map((j, i) => [`http://s${i}`, { ...j, players: j.players.filter((p) => p.entry === toHex(alice.eid) || p.entry === toHex(bob.eid)) }]));
    const ctl = await pageResult(rid, toHex(alice.eid), two);
    const ctlMe = ctl && Array.isArray(ctl.entries) ? ctl.entries.find((e) => e.entry === toHex(alice.eid)) : null;
    assert.ok(ctlMe && ctlMe.outcome === 'DELIVERED' && ctlMe.signedBy > 0, `control: the page shows the signed win from the two-player answers (${JSON.stringify(ctlMe)})`);
    const shown = await pageResult(rid, toHex(alice.eid), Object.fromEntries(answers.map((j, i) => [`http://s${i}`, j])));
    const me = shown && Array.isArray(shown.entries) ? shown.entries.find((e) => e.entry === toHex(alice.eid)) : null;
    console.log('  FACTS:', JSON.stringify({ playersPerSeat: answers.map((j) => j.players.length), seatSaid, pageShows: shown ? { entries: (shown.entries || []).length, me } : shown }));
    assert.ok(me && me.outcome === 'DELIVERED' && me.score === 2 && me.signedBy > 0,
      `the page shows Alice ${me ? `${me.outcome} ${me.score} signedBy ${me.signedBy}` : 'no result at all'} while both seats signed her win (each seat lists ${answers.map((j) => j.players.length).join(' / ')} players)`);
  } finally { await w.close(); }
});
