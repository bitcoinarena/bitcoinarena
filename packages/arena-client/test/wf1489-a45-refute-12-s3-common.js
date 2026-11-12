// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45-refute-12 skeptic 3: the ARENA_GAME.result slice of a page, run against seats faked by HOST (a server answers any path it is asked)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageFunction } from './page-script.js';
const SLICE = "async (id) => {\n          const h = readHidden().find((x) => x.roundIdHex === id);\n          // THE FIRST SECONDS AFTER THE CLOSE";
export const roundId = 'aa'.repeat(32), mine = '11'.repeat(32), theirs = '22'.repeat(32);
export const honest = { players: [{ entry: mine, outcome: 'DELIVERED', score: 2, signedBy: 2 }, { entry: theirs, outcome: 'FAILED', score: 0, signedBy: 2 }] };
export const evil = { players: [{ entry: mine, outcome: 'FAILED', score: 0, signedBy: 5 }, { entry: theirs, outcome: 'DELIVERED', score: 2, signedBy: 5 }] };
// `serverOf(url)` names the one server a URL reaches (a host answers every path, every spelling of its name)
export function door(page, answers, nodes, serverOf) {
  const html = fs.readFileSync(page, 'utf8');
  const at = html.indexOf(SLICE); assert.ok(at > 0, 'the page holds ARENA_GAME.result');
  const endTxt = 'return best || none;\n        }';
  const body = html.slice(at, html.indexOf(endTxt, at) + endTxt.length);
  const asked = [];
  const fetch = async (url) => { const s = serverOf(String(url)); asked.push(s); const a = answers[s]; if (a === undefined) return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => a }; };
  const hidden = [{ roundIdHex: roundId, entryIdHex: mine, entryCloseMs: Date.now() - 60000, nodes }];
  const alerts = [];
  const checkSigned = (id, best) => { const e = best && best.entries.find((x) => x.entry === mine && x.outcome && x.signedBy > 0); if (e && e.outcome !== 'DELIVERED') alerts.push('Correction: signed as ' + e.outcome); };
  const fn = pageFunction(page, ['readHidden', 'resultsSeen', 'revealsSeen', 'game', 'provisional', 'saidProvisionally', 'checkSigned', 'fetch', 'AbortSignal', 'window'], body, '', 'return ');
  return { result: fn(() => hidden, new Map(), new Map(), { manifest: { resultType: 3 } }, () => null, (id, p) => p, checkSigned, fetch, { timeout: () => undefined }, {}), alerts, asked };
}
