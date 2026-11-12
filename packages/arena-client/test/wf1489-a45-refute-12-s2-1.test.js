// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 2 (role: a stranger's round link / one peer seat under two addresses): THE #1825 VOTE COUNTS ADDRESSES, NOT SEATS.
// ARENA_GAME.result asks every address in the tab's hidden record (h.nodes, the join link's node= list, never deduplicated: join.js list())
// and counts one vote per address. The same seat named twice ('http://evil' and 'http://evil/' - the page strips the slash, so it is the
// very same URL asked twice) is two votes: one seat outvotes the honest one and its verdict stands, signed, with the Correction alert.
// SAFE: one seat cannot set the head-to-head verdict, however many times its address is listed.
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


test('#1489 a45-refute-12-s2-1: one seat listed under two spellings of its address outvotes the honest seat', async () => {
  const evil = { players: [{ entry: mine, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: theirs, outcome: 'DELIVERED', score: 2, signedBy: 5 }] };
  const { result, alerts } = door({ 'http://evil': evil, 'http://h1': honest }, ['http://evil', 'http://evil/', 'http://h1']);
  const got = await result(roundId);
  const me = got.entries.find((e) => e.entry === mine);
  console.log('  FACTS (a45-refute-12-s2-1):', JSON.stringify({ shownForMe: me, alerts }));
  assert.ok(!(me.outcome === 'FAILED' && me.signedBy > 0), `the page shows FAILED signed by ${me.signedBy} from one seat asked twice, against the honest seat's win`);
  assert.deepEqual(alerts, []);
});
