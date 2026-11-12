// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 2 (role: one seat listed first, agreeing in the vote's eyes): THE VOTE COMPARES String(outcome), THE PAGE SHOWS THE RAW VALUE.
// verdictOf keys each answer by [String(entry), String(outcome), Number(score)], so a seat answering outcome ["DELIVERED"] (an array)
// counts for the honest verdict; the loop then takes the FIRST agreeing answer whole - the evil seat's, listed first - and hands the client
// outcome ["DELIVERED"] with signedBy 5. The RPS client (index-v5.html) reads `me.outcome === 'DELIVERED'` -> false -> 'loss': the winner
// is told "You lose" though all three seats signed a win.
// SAFE: what the page shows as signed is the agreed verdict itself, a string outcome and a number score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const SLICE = "async (id) => {\n          const h = readHidden().find((x) => x.roundIdHex === id);\n          // THE FIRST SECONDS AFTER THE CLOSE";


const fs = await import('node:fs');
const html = fs.readFileSync(PAGE, 'utf8');
const roundId = 'aa'.repeat(32), mine = '11'.repeat(32), theirs = '22'.repeat(32);
function door(answers, nodes) {
  const at = html.indexOf(SLICE); assert.ok(at > 0, 'the page holds ARENA_GAME.result');
  const endTxt = 'return best || none;\n        }';
  const body = html.slice(at, html.indexOf(endTxt, at) + endTxt.length);
  const fetch = async (url) => { const seat = String(url).split('/api/')[0]; const a = answers[seat]; if (a === undefined) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => a }; };
  const hidden = [{ roundIdHex: roundId, entryIdHex: mine, entryCloseMs: Date.now() - 60000, nodes }];
  const alerts = [];
  const checkSigned = (id, best) => { const e = best && best.entries.find((x) => x.entry === mine && x.outcome && x.signedBy > 0); if (e && e.outcome !== 'DELIVERED') alerts.push('Correction: signed as ' + e.outcome); };
  const fn = pageFunction(PAGE, ['readHidden', 'resultsSeen', 'revealsSeen', 'game', 'provisional', 'saidProvisionally', 'checkSigned', 'fetch', 'AbortSignal', 'window'], body, '', 'return ');
  return { result: fn(() => hidden, new Map(), new Map(), { manifest: { resultType: 3 } }, () => null, (id, p) => p, checkSigned, fetch, { timeout: () => undefined }, {}), alerts };
}
const honest = { players: [{ entry: mine, outcome: 'DELIVERED', score: 2, signedBy: 2 }, { entry: theirs, outcome: 'FAILED', score: 0, signedBy: 2 }] };


test('#1489 a45-refute-12-s2-2: a seat answering outcome as an array passes the vote and its raw answer is shown', async () => {
  const evil = { players: [{ entry: mine, outcome: ['DELIVERED'], score: 2, signedBy: 5 }, { entry: theirs, outcome: ['FAILED'], score: 0, signedBy: 5 }] };
  const { result } = door({ 'http://evil': evil, 'http://h1': honest, 'http://h2': honest }, ['http://evil', 'http://h1', 'http://h2']);
  const got = await result(roundId);
  const me = got.entries.find((e) => e.entry === mine);
  const rps = me && me.outcome && me.signedBy > 0 ? (me.outcome === 'DELIVERED' && me.score >= 2 ? 'win' : me.outcome === 'DELIVERED' ? 'draw' : 'loss') : null;
  console.log('  FACTS (a45-refute-12-s2-2):', JSON.stringify({ shownForMe: me, rpsVerdict: rps }));
  assert.equal(typeof me.outcome, 'string', `the signed outcome shown is ${JSON.stringify(me.outcome)} (signedBy ${me.signedBy}): the RPS client reads it as '${rps}'`);
  assert.equal(rps, 'win');
});
