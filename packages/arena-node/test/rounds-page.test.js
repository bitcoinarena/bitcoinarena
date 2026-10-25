// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUNDS PAGE HANDS ITS DATA TO REACT (plan comment 298, Go 2026-10-05; kanban #564, 2026-10-21: "Delete the old html code of
// those components you have ported, no fall backs"). The page's script runs as it is, on a small fake page (no jsdom, by decision), with
// window.ArenaRounds faked: what is measured is what it hands the React page - /api/rounds as read, the words of an unreadable node, and a
// readResult that reads api/round-result for one round and says why it could not. How the rounds, players and sats are drawn is
// packages/arena-web's rounds test (RoundsPage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from '../../arena-client/test/page-script.js';

const HTML = readFileSync(new URL('../pages/rounds.html', import.meta.url), 'utf8');
const MODULE = HTML.slice(HTML.indexOf('<script type="module">') + '<script type="module">'.length, HTML.lastIndexOf('</script>'));
const BUNDLE = "import './rounds/react.js';\n";
const SCRIPT = MODULE.slice(MODULE.indexOf(BUNDLE) + BUNDLE.length);
const tick = () => new Promise((r) => setTimeout(r, 15));
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);

function page(answers) {
  const app = { id: 'app' };
  const document = { hidden: false, getElementById: (id) => (id === 'app' ? app : null) };
  const drawn = [];
  const window = { ArenaRounds: { draw: (el, data, readResult) => drawn.push({ el, data, readResult }) } };
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const a = typeof answers === 'function' ? answers(url) : answers[url.split('?')[0]];
    return { ok: a.status === 200, status: a.status, json: async () => a.body, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  let every = null;
  pageFunction(new URL('../pages/rounds.html', import.meta.url), ['document', 'fetch', 'setInterval', 'window'], SCRIPT)(document, fetch, (fn, ms) => { every = { fn, ms }; }, window);
  return { app, drawn, asked, every: () => every };
}
const ROUNDS = {
  node: 'ab'.repeat(32), nowMs: String(Date.UTC(2026, 9, 5, 15)),
  upcoming: [{ id: hex(1), startTime: '2026-10-05T16:00:00.000Z', endTime: '2026-10-05T16:01:22.000Z', free: true, stakeMsat: '0', entryOpen: true, phase: 'open', committee: null }],
  finished: [{ id: hex(5), startTime: '2026-10-05T14:00:00.000Z', endTime: '2026-10-05T14:01:22.000Z', free: false, stakeMsat: '100000', joined: 4, committee: null }],
};
const PAID = { id: hex(5), state: 3, free: false, players: [{ entry: hex(0x41), player: hex(0x51), name: 'p1', outcome: 'DELIVERED', score: 700, wonMsat: '12345678', winningsState: 'PAID' }] };

test('the page is React\'s: the bundle is imported, no page of its own and no fall back', () => {
  assert.ok(MODULE.startsWith(`\n${BUNDLE}`), 'the bundle is loaded first, unconditionally');
  assert.doesNotMatch(HTML, /id="legacy"|catch \{ R = false|innerHTML/, 'no drawing of its own');
  assert.match(HTML, /<div id="app"><\/div>/);
});

test('/api/rounds as read is handed to window.ArenaRounds.draw in #app, every 30 s while the page is seen', async () => {
  const p = page({ 'api/rounds': { status: 200, body: ROUNDS } });
  await tick();
  assert.equal(p.drawn.length, 1);
  assert.equal(p.drawn[0].el, p.app);
  assert.deepEqual(p.drawn[0].data, ROUNDS);
  assert.deepEqual(p.asked, ['api/rounds'], 'relative, so /guardian-N/ works');
  assert.equal(p.every().ms, 30000);
  p.every().fn(); await tick();
  assert.equal(p.drawn.length, 2, 'drawn again at the next read');
});

test('readResult: one round\'s api/round-result; a 404 said with its words', async () => {
  const p = page((url) => (url === 'api/rounds' ? { status: 200, body: ROUNDS }
    : url.endsWith(hex(5)) ? { status: 200, body: PAID } : { status: 404, body: 'this node holds no such round\n' }));
  await tick();
  const { readResult } = p.drawn[0];
  assert.deepEqual(await readResult(hex(5)), PAID);
  assert.equal(p.asked.at(-1), `api/round-result?round=${hex(5)}`);
  await assert.rejects(readResult(hex(6)), { message: '404 this node holds no such round' });
});

test('a node that cannot be read: React is handed the words', async () => {
  const down = page({ 'api/rounds': { status: 500, body: 'down' } });
  await tick();
  assert.deepEqual(down.drawn[0].data, { error: '500' });
  const gone = page(() => { throw new Error('connection refused'); });
  await tick();
  assert.deepEqual(gone.drawn[0].data, { error: 'connection refused' });
});
