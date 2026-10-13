// THE OWNER PAGE'S STANDING PANEL (kanban #302, #310): the page's own standingPanel, run on the doors' answers - the missed
// seatings' warning with the serving = false update, and the bond's standing with each warning in the seat's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nodeStanding } from '../src/node-standing.js';
import { seatingWarning } from '../src/seatings.js';

const HTML = readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8');
const a = HTML.indexOf('async function standingPanel() {');
const body = HTML.slice(a, HTML.indexOf('\n}\n', a) + 2);
const esc = (v) => String(v).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function render(seatings, standing) {
  const el = { innerHTML: '' };
  const fetch = async (u) => ({ json: async () => (u.endsWith('/owner/seatings') ? seatings : standing) });
  const fn = new Function('$', 'at', 'fetch', 'esc', `${body}; return standingPanel;`)(() => el, (p) => `https://seat${p}`, fetch, esc);
  await fn();
  return el.innerHTML;
}
const me = 'aa'.repeat(32);
const rounds = (bondMin, bonds) => [{ atMs: 2, bondMinSats: bondMin, entries: bonds.map(([k, b]) => ({ pubkey: k, bondSats: b })), excluded: [] }];

test('three seatings missed and a bond under the common bracket: both warnings, the update named', async () => {
  const st = nodeStanding({ me, rounds: rounds(200000n, [[me, 150000n], ['bb'.repeat(32), 300000n]]) });
  const html = await render({ missedInARow: 3, warning: seatingWarning(3) }, st);
  assert.match(html, /Seatings missed in a row<\/span><b>3/);
  assert.match(html, /MISSED SEATINGS/); assert.match(html, /serving = false/); assert.match(html, /ARENA_ADVERT_SERVING=false/);
  assert.match(html, /LOSING BRACKETS/); assert.match(html, /0\.75x the bond_min now common \(200,000 sat\)/);
  assert.match(html, /Bond<\/span><b>150,000 sat/);
});

test('seated when drawn and a bond above the margin: no warning', async () => {
  const st = nodeStanding({ me, rounds: rounds(100000n, [[me, 1000000n]]) });
  const html = await render({ missedInARow: 0, warning: null }, st);
  assert.match(html, /No warning/); assert.doesNotMatch(html, /class="err"/);
});
