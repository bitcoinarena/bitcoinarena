// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WARNINGS BEFORE ENTRY (spec §18A.7 / §22A): the engine's from the contract, the game's from the seats (known
// codes only), each a sentence; the page's gate shows them and takes the player's answer before anything is locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryWarnings, warningsSay, WARNING_SAYS } from '../src/entry-warnings.js';
import { pageFunction } from './page-script.js';

const base = { rankNumerator: 3, rankDenominator: 4, minScore: 1 };

test('the engine\'s warnings come from the contract; the seats\' only as codes this page names; a market has no curve to call flat', () => {
  assert.deepEqual(entryWarnings(base), []);
  assert.deepEqual(entryWarnings({ ...base, rankNumerator: 19, rankDenominator: 20 }), ['flat_rank_curve'], 'r = 0.95');
  assert.deepEqual(entryWarnings({ ...base, rankNumerator: 94, rankDenominator: 100 }), [], 'r = 0.94');
  assert.deepEqual(entryWarnings({ ...base, rankNumerator: 0, rankDenominator: 0, minScore: 0 }), [], 'an attested market: rank 0 of 0');
  assert.deepEqual(entryWarnings({ ...base, minScore: 100 * 100000 + 1 }), ['minimum_score_is_a_danger_rule']);
  assert.deepEqual(entryWarnings(base, ['exposure_ignored', 'exposure_ignored', '<b>free money</b>', 7]), ['exposure_ignored'], 'unknown text from a seat is dropped');
  assert.deepEqual(warningsSay(['exposure_ignored', 'nope']), [WARNING_SAYS.exposure_ignored]);
});

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
function gate(rows) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {}, children: [], appendChild(c) { this.children.push(c); } });
  for (const id of ['awc-list', 'arena-warn-confirm', 'awc-go', 'awc-cancel']) el(id);
  const document = { getElementById: (id) => els[id] || null, createElement: () => ({ textContent: '' }) };
  const window = { ARENA_LOBBY_ROWS: rows };
  const fn = pageFunction(PAGE, ['document', 'window', 'ARENACLIENT'], [
    (() => { const html = require_(); const a = html.indexOf('    window.ARENA_WARNINGS_GATE = async'); return html.slice(a, html.indexOf('\n    };\n', a) + 7); })()],
    'return window.ARENA_WARNINGS_GATE;');
  return { run: fn(document, window, { entryWarnings, warningsSay }), els, window };
}
import { readFileSync } from 'node:fs';
const require_ = () => readFileSync(PAGE, 'utf8');

test('the gate: no warning, no dialog; a warning shown and Cancel refuses the entry; Enter anyway goes on', async () => {
  const id = 'ab'.repeat(32);
  const quiet = gate([{ id, warnings: [] }]);
  assert.deepEqual(await quiet.run({ round: base, roundIdHex: id }), { ok: true, codes: [] });
  assert.equal(quiet.els['arena-warn-confirm'].style.display, undefined, 'no dialog');
  const g = gate([{ id, warnings: ['exposure_ignored'] }]);
  const p = g.run({ round: { ...base, rankNumerator: 19, rankDenominator: 20 }, roundIdHex: id });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(g.els['arena-warn-confirm'].style.display, 'flex');
  assert.deepEqual(g.els['awc-list'].children.map((c) => c.textContent), [WARNING_SAYS.flat_rank_curve, WARNING_SAYS.exposure_ignored]);
  g.els['awc-cancel'].onclick();
  const r = await p;
  assert.deepEqual([r.ok, r.codes, g.els['arena-warn-confirm'].style.display], [false, ['flat_rank_curve', 'exposure_ignored'], 'none']);
  assert.match(r.why, /warnings were not accepted: nothing is staked/);
  const g2 = gate([{ id, warnings: ['exposure_ignored'] }]);
  const p2 = g2.run({ round: base, roundIdHex: id });
  await new Promise((r2) => setTimeout(r2, 0));
  g2.els['awc-go'].onclick();
  assert.deepEqual(await p2, { ok: true, codes: ['exposure_ignored'], confirmed: true });
  assert.deepEqual(g2.window.ARENA_WARNINGS_SHOWN, { round: id, codes: ['exposure_ignored'] });
});
