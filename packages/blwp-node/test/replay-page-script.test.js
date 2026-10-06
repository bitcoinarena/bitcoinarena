// THE REPLAY PAGE'S OWN SCRIPT, RUN (kanban #150: pages/replay.html was outside coverage - no test ran a line of it). The
// script runs as it is, under the page's own name (page-script.js), on a small fake page (no jsdom, as rounds-page rules):
// a status element, fetch faked per path. Measured: what the page tells the player when the link names no run, when no
// node it asks holds the run - this node first, then the round's committee endpoints it is given - and when the run's
// round cannot be read. Stepping and drawing a run needs the round's own core script, served per round; not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from '../../blwp-client/test/page-script.js';

const PAGE = new URL('../pages/replay.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('(async function () {\n  const q = new URLSearchParams(location.search);');
const SCRIPT = HTML.slice(at, HTML.lastIndexOf('})();', HTML.indexOf('</script>', at)) + '})();'.length);
assert.ok(at > 0, 'replay.html holds its replay script');

const RID = 'ab'.repeat(32), EID = 'cd'.repeat(32);

/** Runs the page's script against `answer(url)` (a Response or null for a refused fetch); resolves to what it said. */
async function run(search, answer) {
  const said = [];
  const status = { set textContent(s) { said.push(s); }, get textContent() { return said.at(-1) || ''; }, style: {} };
  const document = { getElementById: (id) => (id === 'status' ? status : null) };
  const asked = [];
  const fetch = async (url) => { asked.push(String(url)); const r = answer(String(url)); if (!r) throw new Error('refused'); return r; };
  const location = { search, origin: 'https://node.example', pathname: '/blwp-a/replay' };
  const BLWPCLIENT = { decodeRoundContract: () => { throw new Error('not a round contract'); }, decodeEntryContract: () => ({}) };
  await pageFunction(PAGE, ['document', 'fetch', 'location', 'BLWPCLIENT', 'window', 'console'], SCRIPT, '', 'return ')(
    document, fetch, location, BLWPCLIENT, {}, { log: () => {} });
  return { said, asked };
}
const json = (v) => new Response(JSON.stringify(v), { status: 200 });

test('a link that names no round and entry: the page says so and asks nothing', async () => {
  const { said, asked } = await run('?round=zz', () => null);
  assert.deepEqual(said, ['the link names no round and entry (?round=<hex>&entry=<hex>)']);
  assert.deepEqual(asked, []);
});

test('no node holds the run: this node first, then each committee endpoint the node names, then the count it asked', async () => {
  const { said, asked } = await run(`?round=${RID}&entry=${EID}`, (url) =>
    (url.includes('/replay/nodes') ? json({ endpoints: ['https://node.example/blwp-a', 'https://b.example'] }) : new Response('no', { status: 404 })));
  assert.equal(asked[0], `https://node.example/blwp-a/replay/nodes?round=${RID}`, 'this node, under the path it is published at');
  assert.deepEqual(asked.slice(1), [`https://node.example/blwp-a/replay/transcript?round=${RID}&entry=${EID}`,
    `https://b.example/replay/transcript?round=${RID}&entry=${EID}`], 'this node, then the other endpoint - not this node twice');
  assert.equal(said.at(-1), 'no committee node holds that run (asked 2)');
});

test('a node holds the run but its round cannot be read: the page names why and stops before the core', async () => {
  const { said, asked } = await run(`?round=${RID}&entry=${EID}`, (url) =>
    url.includes('/replay/nodes') ? json({ endpoints: [] })
      : url.includes('/replay/transcript') ? json({ ticks: [] })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  assert.match(said.at(-1), /^the run cannot be read: not a round contract$/);
  assert.ok(!asked.some((u) => u.includes('/replay/core.js')), 'no core asked for a run it cannot read');
});
