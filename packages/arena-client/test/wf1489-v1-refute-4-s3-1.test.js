// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1-refute-4-s3-1 (kanban #1489, skeptic 3 of 8620bc1ce): the match record now goes by the seats' vote - but when no record wins that
// vote, "a record only one seat gives is kept when that seat's signed pairs all match the counted ones". A seat that copies the honest pairs
// (they are public at every seat's /api/round-result) - or gives no signed pair at all, so the check passes vacuously - and adds a match
// record of its own, while the honest seats give none (matchOf null: an identity not at that seat, an older build), sets the score across
// rounds and whose identity is whose on its own. The page's own code, extracted from index.html.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from); const b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, 'page code moved: ' + from); return html.slice(a, b + to.length); };
const helpers = cut('      const undecided = (held) =>', "try { window.ARENA_MONEY_ALERT.coming(words); } catch { /* none */ } };");
const resultFn = cut('        result: async (id) => {', '          return best || none;\n        }');

const ME = 'aa'.repeat(32), THEM = 'bb'.repeat(32), RID = 'cc'.repeat(32);
const makeGame = (answers, { moves = { [ME]: 1, [THEM]: 0 }, nodes = Object.keys(answers).map((k) => 'http://' + k) } = {}) => {
  const fetchStub = (url) => { const a = answers[new URL(url).host];
    if (a === undefined) return Promise.reject(new Error('down')); return Promise.resolve({ ok: true, json: async () => a }); };
  const hidden = [{ roundIdHex: RID, entryIdHex: ME, move: 1, nodes, entryCloseMs: String(Date.now() - 60000) }];
  const window = { ARENA_MONEY_ALERT: { coming: () => {} } };
  const build = new Function('readHidden', 'game', 'fetch', 'window', 'setTimeout', 'console', 'resultsSeen',
    `${helpers}\n const revealsSeen = new Map([[${JSON.stringify(RID)}, ${JSON.stringify(moves)}]]);\n return { ${resultFn} };`);
  return build(() => hidden, { manifest: { resultType: 3 } }, fetchStub, window, () => 0, { warn: () => {}, log: () => {} }, new Map());
};
const honestPlayers = [{ entry: ME, outcome: 'DELIVERED', score: 2, signedBy: 5 }, { entry: THEM, outcome: 'FAILED', score: 0, signedBy: 5 }];
const liarMatch = { identities: ['22'.repeat(32), '11'.repeat(32)], names: ['them', 'me'], score: [9, 0], played: 9, players: { [ME]: '22'.repeat(32), [THEM]: '11'.repeat(32) }, seat: 1, signature: 'cd' };

test('wf1489-v1-refute-4-s3-1: one seat copying the public honest pairs alone sets the match record when the other seats have none', async () => {
  const got = await makeGame({ liar: { players: honestPlayers, match: liarMatch }, a: { players: honestPlayers, match: null }, b: { players: honestPlayers, match: null } }).result(RID);
  assert.equal(got.entries.find((e) => e.entry === ME).score, 2, 'the round itself is the agreed one');
  console.log(`  FACTS match shown: ${got.match ? JSON.stringify(got.match.score) + ' identities ' + got.match.identities.map((x) => x.slice(0, 4)).join(',') : 'none'} (seats a, b give no record)`);
  assert.equal(got.match, null, 'one seat alone set the score across rounds: ' + (got.match && JSON.stringify(got.match.score)));
});

test('wf1489-v1-refute-4-s3-1: one seat with no signed pair at all passes the lone-record check vacuously and sets the record', async () => {
  const bare = honestPlayers.map((p) => ({ entry: p.entry, outcome: null, score: null, signedBy: 0 }));
  const got = await makeGame({ liar: { players: bare, match: liarMatch }, a: { players: honestPlayers, match: null }, b: { players: honestPlayers, match: null } }).result(RID);
  console.log(`  FACTS match shown: ${got.match ? JSON.stringify(got.match.score) : 'none'} (the liar signed nothing)`);
  assert.equal(got.match, null, 'a seat that signed nothing alone set the score across rounds');
});
