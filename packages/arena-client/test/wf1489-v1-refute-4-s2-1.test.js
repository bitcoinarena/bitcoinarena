// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-4-s2-1 (kanban #1673, #1489, skeptic 2 of c36c05f30): ARENA_GAME.result now counts every seat's entries and outcomes,
// but the match record (the score across rounds, whose identity is whose) is still "the first seat that has one" - one seat at the head of
// the list, even one whose own players the vote outvoted, sets the score the page shows. And signedBy is the MAX any agreeing seat claims,
// so one seat that agrees on the pair says how many seats signed it. The page's own code, extracted from index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from); const b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, 'page code moved: ' + from); return html.slice(a, b + to.length); };
const helpers = cut('      const undecided = (held) =>', "try { window.ARENA_MONEY_ALERT.coming(words); } catch { /* none */ } };");
const resultFn = cut('        result: async (id) => {', '          return best || none;\n        }');

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32), RID = 'cc'.repeat(32);
const makeGame = (answers, { moves = { [ME]: 1, [THEM]: 0 }, nodes = Object.keys(answers).map((k) => 'http://' + k) } = {}) => {
  const fetchStub = (url, opt = {}) => { const a = answers[new URL(url).host];
    if (a === 'hang') return new Promise((_, no) => { if (opt.signal) opt.signal.addEventListener('abort', () => no(new Error('timeout'))); });
    if (a === undefined) return Promise.reject(new Error('down')); return Promise.resolve({ ok: true, json: async () => a }); };
  const hidden = [{ roundIdHex: RID, entryIdHex: ME, move: 1, nodes, entryCloseMs: String(Date.now() - 60000) }];
  const window = { ARENA_MONEY_ALERT: { coming: () => {} } };
  const build = new Function('readHidden', 'game', 'fetch', 'window', 'setTimeout', 'console', 'resultsSeen',
    `${helpers}\n const revealsSeen = new Map([[${JSON.stringify(RID)}, ${JSON.stringify(moves)}]]);\n return { ${resultFn} };`);
  return build(() => hidden, { manifest: { resultType: 3 } }, fetchStub, window, () => 0, { warn: () => {}, log: () => {} }, new Map());
};
const honestPlayers = [{ entry: ME, outcome: 'DELIVERED', score: 2, signedBy: 5 }, { entry: THEM, outcome: 'FAILED', score: 0, signedBy: 5 }];
const liarPlayers = [{ entry: ME, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: THEM, outcome: 'DELIVERED', score: 2, signedBy: 5 }];
const honestMatch = { identities: ['11'.repeat(32), '22'.repeat(32)], names: ['me', 'them'], score: [3, 1], played: 4, players: {}, seat: 2, signature: 'ab' };
const liarMatch = { identities: ['22'.repeat(32), '11'.repeat(32)], names: ['them', 'me'], score: [9, 0], played: 9, players: {}, seat: 1, signature: 'cd' };

test('wf1489-v1-refute-4-s2-1: one seat at the head of the list, outvoted on the round, still sets the match score the page shows', async () => {
  const got = await makeGame({ liar: { players: liarPlayers, match: liarMatch }, a: { players: honestPlayers, match: honestMatch }, b: { players: honestPlayers, match: honestMatch } }).result(RID);
  const mine = got.entries.find((e) => e.entry === ME);
  assert.equal(mine.score, 2, 'the round itself is the agreed one');
  console.log(`  FACTS match shown: score ${JSON.stringify(got.match.score)}, played ${got.match.played} (seats a, b say [3,1], 4)`);
  assert.deepEqual(got.match.score, [3, 1], 'one seat alone set the score across rounds');
  assert.deepEqual(got.match.identities, honestMatch.identities, 'one seat alone set whose identity is whose');
});

test('wf1489-v1-refute-4-s2-1: one seat that agrees on the pair alone says how many seats signed it', async () => {
  const inflated = honestPlayers.map((p) => ({ ...p, signedBy: 99 }));
  const got = await makeGame({ liar: { players: inflated }, a: { players: honestPlayers }, b: { players: honestPlayers } }).result(RID);
  const mine = got.entries.find((e) => e.entry === ME);
  console.log(`  FACTS signedBy shown: ${mine.signedBy} (seats a, b say 5)`);
  assert.ok(mine.signedBy <= 5, 'one seat alone set signedBy to ' + mine.signedBy);
});

test('wf1489-v1-refute-4-s2-1: a seat that never answers holds back the result two seats already agree on (every call waits 5 s)', async () => {
  const g = makeGame({ a: { players: honestPlayers }, b: { players: honestPlayers }, slow: 'hang' });
  const t0 = Date.now(); const got = await g.result(RID); const took = Date.now() - t0;
  console.log(`  FACTS result took ${took} ms with seats a, b agreeing at once`);
  assert.equal(got.entries.find((e) => e.entry === ME).score, 2);
  assert.ok(took < 2500, 'one silent seat held the agreed result back ' + took + ' ms');
});
