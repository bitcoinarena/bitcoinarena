// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-4-s1-2 (kanban #1673, #1489, the refute test as found; bypass of the client-4 fix aaf288ee): revealsOfRound now takes a move only when the seats agree,
// so one seat can no longer flip the head-to-head verdict the page shows. But the page's other door to the same verdict,
// ARENA_GAME.result (src/arena-ui/index.html), still takes "the round as its seats hold it" from the FIRST seat in the list that answers
// with both entries - its outcome, score and signedBy as that one seat wrote them, no signature checked, no second seat asked. One seat
// that answers first with "signedBy: 5, outcome FAILED, score 0" for the honest winner makes the page show "a loss" as the signed result,
// while the other seats (and the revealed moves) say "a win". The test runs the page's own code (extracted from index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from); const b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, 'page code moved: ' + from); return html.slice(a, b + to.length); };
const helpers = cut('      const undecided = (held) =>', "try { window.ARENA_MONEY_ALERT.coming(words); } catch { /* none */ } };");
const resultFn = cut('        result: async (id) => {', '          return best || none;\n        }');

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32), RID = 'cc'.repeat(32);

test('wf1489-v1-refute-4-1: one seat answering first cannot make the page show its own unsigned verdict as the signed result', async () => {
  // honest seats: I played paper (1), they played rock (0); both signed: I won (DELIVERED, 2)
  const honestPlayers = { players: [{ entry: ME, outcome: 'DELIVERED', score: 2, signedBy: 5 }, { entry: THEM, outcome: 'FAILED', score: 0, signedBy: 5 }] };
  const liarPlayers = { players: [{ entry: ME, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: THEM, outcome: 'DELIVERED', score: 2, signedBy: 5 }] };
  const fetchStub = async (url) => {
    const host = new URL(url).host;
    return { ok: true, json: async () => (host === 'liar' ? liarPlayers : honestPlayers) };
  };
  const hidden = [{ roundIdHex: RID, entryIdHex: ME, move: 1, nodes: ['http://liar', 'http://a', 'http://b'], entryCloseMs: String(Date.now() - 60000) }];
  const warned = [];
  const window = { ARENA_MONEY_ALERT: { coming: (w) => warned.push(w) } };
  const game = { manifest: { resultType: 3 } };
  const build = new Function('readHidden', 'game', 'fetch', 'window', 'setTimeout', 'console', 'resultsSeen',
    `${helpers}\n const revealsSeen = new Map([[${JSON.stringify(RID)}, { [${JSON.stringify(ME)}]: 1, [${JSON.stringify(THEM)}]: 0 }]]);\n return { ${resultFn} };`);
  const g = build(() => hidden, game, fetchStub, window, () => 0, { warn: () => {}, log: () => {} }, new Map());
  const got = await g.result(RID);
  const mine = got.entries.find((e) => e.entry === ME);
  console.log(`  FACTS shown for my entry: outcome ${mine.outcome}, score ${mine.score}, signedBy ${mine.signedBy} (seats a, b and the open moves say DELIVERED, 2)`);
  assert.notEqual(mine.score, 0, 'the first seat alone set the shown result: an honest win reads "a loss"');
});
