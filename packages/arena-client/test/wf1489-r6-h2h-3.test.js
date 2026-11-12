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

test('#1489 r6-h2h-3: one seat listed first cannot flip the head-to-head verdict the page shows', async () => {
  // the slice runs from the result door's head to its `return best || none;` (the page's own text)
  const fs = await import('node:fs');
  const html = fs.readFileSync(PAGE, 'utf8');
  const at = html.indexOf(SLICE); assert.ok(at > 0, 'the page holds ARENA_GAME.result');
  const endTxt = 'return best || none;\n        }';
  const end = html.indexOf(endTxt, at) + endTxt.length;
  const body = html.slice(at, end);
  const roundId = 'aa'.repeat(32), mine = '11'.repeat(32), theirs = '22'.repeat(32);
  const answers = {
    // the evil seat: the player lost, "signed by 5"
    'http://evil': { players: [{ entry: mine, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: theirs, outcome: 'DELIVERED', score: 2, signedBy: 5 }] },
    // the two honest seats: the player won, signed by both
    'http://h1': { players: [{ entry: mine, outcome: 'DELIVERED', score: 2, signedBy: 2 }, { entry: theirs, outcome: 'FAILED', score: 0, signedBy: 2 }] },
    'http://h2': { players: [{ entry: mine, outcome: 'DELIVERED', score: 2, signedBy: 2 }, { entry: theirs, outcome: 'FAILED', score: 0, signedBy: 2 }] },
  };
  const fetch = async (url) => { const seat = String(url).split('/api/')[0]; return { ok: true, status: 200, json: async () => answers[seat] }; };
  const hidden = [{ roundIdHex: roundId, entryIdHex: mine, entryCloseMs: Date.now() - 60000, nodes: ['http://evil', 'http://h1', 'http://h2'] }];
  const fn = pageFunction(PAGE, ['readHidden', 'resultsSeen', 'revealsSeen', 'game', 'provisional', 'saidProvisionally', 'checkSigned', 'fetch', 'AbortSignal', 'window'],
    body, '', 'return ');
  const result = fn(() => hidden, new Map(), new Map(), { manifest: { resultType: 3 } }, () => null, (id, p) => p, () => {}, fetch, { timeout: () => undefined, any: () => undefined }, {});   // AbortSignal.any: the page asks every seat at once since #1673 / #1867 (item 4)
  const got = await result(roundId);
  const me = got.entries.find((e) => e.entry === mine);
  console.log('  FACTS (r6-h2h-3):', JSON.stringify({ shownForMe: me, seatsSaid: { evil: 'FAILED', h1: 'DELIVERED 2', h2: 'DELIVERED 2' } }));
  assert.equal(me.outcome, 'DELIVERED', `the page shows ${me.outcome} (signedBy ${me.signedBy}) from the one seat listed first, while the other two seats signed a win`);
});
