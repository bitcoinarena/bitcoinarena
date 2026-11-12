// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 6 (h2h-2): THE PAGE SHOWS A HEAD-TO-HEAD VERDICT FROM THE FIRST SEAT THAT LISTS TWO ENTRIES, WHOLE AND UNCHECKED (P8/P1).
// ARENA_GAME.result (src/arena-ui/index.html) asks the round's seats one by one and stops at the first answer naming both entries; each
// entry's outcome, score and `signedBy` count are that one seat's words - no signature is read, and `signedBy` is a number the seat types.
// The Rock Paper Scissors client turns `outcome` + `signedBy > 0` straight into "You win" / "You lose", and checkSigned turns a disagreement
// with the page's provisional verdict into a money alert ("Correction: the game servers signed your last round as lost"). One committee
// seat (role b) listed before the others therefore tells every winner of its rounds that they lost (and every loser that they won), while
// all the other seats signed the opposite.
// SAFE: one seat out of three cannot set the verdict the page shows against what the other two seats say.
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

test('#1489 a45-refute-12-1: one seat listing THREE players (a junk third entry) still sets the head-to-head verdict, signed', async () => {
  const evil = { players: [{ entry: mine, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: theirs, outcome: 'DELIVERED', score: 2, signedBy: 5 }, { entry: '33'.repeat(32), outcome: 'FAILED', score: 0, signedBy: 5 }] };
  const { result, alerts } = door({ 'http://evil': evil, 'http://h1': honest, 'http://h2': honest }, ['http://evil', 'http://h1', 'http://h2']);
  const got = await result(roundId);
  const me = got.entries.find((e) => e.entry === mine);
  console.log('  FACTS (a45-refute-12-1):', JSON.stringify({ shownForMe: me, entries: got.entries.length, alerts }));
  assert.equal(me.outcome, 'DELIVERED', `the page shows ${me.outcome} (signedBy ${me.signedBy}) from the one seat that listed a third entry, while two seats signed a win`);
  assert.deepEqual(alerts, []);
});
