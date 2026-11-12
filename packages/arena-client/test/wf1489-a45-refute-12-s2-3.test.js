// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 2 (role: one seat listed first that agrees on the verdict): THE MATCH RECORD IS STILL THE FIRST SEAT'S WORD.
// The #1825 vote covers each entry's outcome and score; `match` (identities, names, score across rounds - the RPS scoreboard "me : them" and
// the opponent's name, index-v5.html last.score) is copied from whichever agreeing answer comes first in the list, unchecked against the others.
// One seat listed first that signs the right verdict shows the player a forged scoreboard and opponent name.
// SAFE: a head-to-head result's match record is what the seats agree on, or none.
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


test('#1489 a45-refute-12-s2-3: the first agreeing seat alone sets the scoreboard across rounds', async () => {
  const ids = ['aa11', 'bb22'];
  const m = (score, names) => ({ identities: ids, names, score, played: 4, players: { [mine]: 'aa11', [theirs]: 'bb22' }, seat: 'x', signature: '00' });
  const evil = { ...honest, match: m([0, 4], ['me', 'Satoshi (verified)']) };
  const good = { ...honest, match: m([3, 1], ['me', 'bob']) };
  const { result } = door({ 'http://evil': evil, 'http://h1': good, 'http://h2': good }, ['http://evil', 'http://h1', 'http://h2']);
  const got = await result(roundId);
  console.log('  FACTS (a45-refute-12-s2-3):', JSON.stringify({ match: got.match && { score: got.match.score, names: got.match.names } }));
  assert.ok(!got.match || JSON.stringify(got.match.score) === '[3,1]', `the scoreboard shown is ${JSON.stringify(got.match && got.match.score)} named ${JSON.stringify(got.match && got.match.names)}, one seat's, while two seats say [3,1]`);
});
