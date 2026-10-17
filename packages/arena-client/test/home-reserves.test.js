// THE PROTOCOL RESERVES ON BITCOIN-ARENA.IO (kanban #397, the owner 2026-10-17: "Find a prominent place on the website under the
// USPs to show the reserves ... Under the fees"): the homepage's own script asks the testnet's nodes (daily.json) for /reserves
// and shows the total only when five name the same one; the games screen no longer carries the reserves box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HOME = new URL('../../../deploy/home-site/www/', import.meta.url);
const SCRIPT = readFileSync(new URL('js/reserves.js', HOME), 'utf8');
const HTML = readFileSync(new URL('index.html', HOME), 'utf8');
const GAMES = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');

function homepage(answers) {
  const els = { total: { textContent: '' }, line: { textContent: '' } };
  const root = { dataset: {}, querySelector: (q) => (q === '[data-r="total"]' ? els.total : els.line) };
  const nodes = answers.map((_, i) => `https://seat-${i}.example/`);
  const fetcher = async (u) => {
    if (u.endsWith('daily.json')) return { ok: true, json: async () => ({ testnet: { node: nodes } }) };
    const a = answers[Number(new URL(u).host.split('-')[1].split('.')[0])];
    if (a === undefined) throw new Error('down');
    return { ok: true, json: async () => a };
  };
  const window = {};
  vm.runInNewContext(SCRIPT, { window, document: { getElementById: () => null }, AbortSignal, BigInt, Promise, Number, String, Object, Array, Set });
  return window.ARENA_HOME_RESERVES.show(root, fetcher).then((r) => ({ r, root, total: els.total.textContent, line: els.line.textContent }));
}

test('five of seven name 102,000 msat: the homepage shows 102 sat with its payments in; one higher and one down do not move it', async () => {
  const ok = { totalMsat: '102000', entries: 2 };
  const h = await homepage([ok, ok, ok, ok, ok, { totalMsat: '999999000', entries: 9 }, undefined]);
  assert.deepEqual([h.total, h.line, h.root.dataset.state], ['102', '2 payments in · 5 of 7 nodes agree · Bitcoin testnet4', 'ok']);
});

test('four agreeing, or no answers: no number, and it says why', async () => {
  const a = { totalMsat: '2000', entries: 1 }, b = { totalMsat: '4000', entries: 2 };
  const four = await homepage([a, a, a, a, b, b, b]);
  assert.deepEqual([four.total, four.root.dataset.state], ['—', 'none']); assert.match(four.line, /only 4 of 7 nodes name the same total/);
  const none = await homepage([undefined, undefined]);
  assert.match(none.line, /none of 2 nodes answered/);
});

test('the panel sits under the fees on bitcoin-arena.io, and the games screen carries no reserves box and no footer home link', () => {
  const fees = HTML.indexOf('<section id="split"'), panel = HTML.indexOf('id="reserves"'), next = HTML.indexOf('<section id="build"');
  assert.ok(fees > 0 && panel > fees && panel < next, 'the reserves panel is inside the fees section');
  assert.ok(HTML.includes('<script src="js/reserves.js" defer></script>'));
  assert.equal(GAMES.includes('class="reserves"'), false, 'no reserves box on the games screen');
  assert.equal(/more-sep"> · <\/span><a href="https:\/\/bitcoin-arena.io\/">/.test(GAMES), false, 'no "← bitcoin-arena.io" in the footer links');
});
