// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S WINNINGS LIST, AS THE ROUNDS PAGE DRAWS IT (kanban #187 item 6, plan comment 298, Go 2026-10-05). The script
// of pages/rounds.html runs as it is, on a small fake page (no jsdom, by decision): elements by id that keep their HTML,
// and the finished cards found again from the data-id the script writes, each with its accordion and head button. fetch is
// faked with an api/rounds and an api/round-result answer. What is measured: sats formatted, players sorted by wonMsat then
// score, 'won' only for a positive win, a free round's dashes, upcoming rounds by start, and the words for the empty and
// unreadable cases. The money itself is item 1 (playerBalance), not this page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from '../../arena-client/test/page-script.js';

const HTML = readFileSync(new URL('../pages/rounds.html', import.meta.url), 'utf8');
const SCRIPT = HTML.slice(HTML.indexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'));
const tick = () => new Promise((r) => setTimeout(r, 15));
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);

function page(answers) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', innerHTML: '' });
  const cards = new Map();
  const cardFor = (id) => {
    if (!cards.has(id)) {
      const acc = { innerHTML: '' };
      const btn = { attrs: {}, handlers: [], setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this.handlers.push(fn); } };
      const card = { dataset: { id }, acc, btn, classList: { on: new Set(), contains(c) { return this.on.has(c); }, toggle(c, v) { if (v) this.on.add(c); else this.on.delete(c); } },
        querySelector: (sel) => (sel === '.acc' ? acc : sel === 'button.head' ? btn : null) };
      cards.set(id, card);
    }
    return cards.get(id);
  };
  const document = {
    hidden: false,
    getElementById: el,
    querySelectorAll: (sel) => {
      const ids = [...el('finished').innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
      const all = ids.map(cardFor);
      return sel === '#finished .card.open' ? all.filter((c) => c.classList.contains('open')) : all;
    },
  };
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const a = typeof answers === 'function' ? answers(url) : answers[url.split('?')[0]];
    return { ok: a.status === 200, status: a.status, json: async () => a.body, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  pageFunction(new URL('../pages/rounds.html', import.meta.url), ['document', 'fetch', 'setInterval'], SCRIPT)(document, fetch, () => 0);
  const click = async (id) => { for (const fn of cardFor(id).btn.handlers) fn(); await tick(); };
  return { els, cards, asked, click, cardFor };
}
const ROUNDS = {
  node: 'ab'.repeat(32), nowMs: String(Date.UTC(2026, 9, 5, 15)),
  upcoming: [
    { id: hex(3), startTime: '2026-10-05T16:03:00.000Z', endTime: '2026-10-05T16:04:22.000Z', free: false, stakeMsat: '100000', entryOpen: false, phase: 'pending', committee: { drawn: false, why: 'the beacon is not yet' } },
    { id: hex(1), startTime: '2026-10-05T16:00:00.000Z', endTime: '2026-10-05T16:01:22.000Z', free: true, stakeMsat: '0', entryOpen: true, phase: 'open', committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
    { id: hex(2), startTime: '2026-10-05T16:01:30.000Z', endTime: '2026-10-05T16:02:52.000Z', free: false, stakeMsat: '12345000', entryOpen: false, phase: 'closed', committee: null },
  ],
  finished: [
    { id: hex(5), startTime: '2026-10-05T14:00:00.000Z', endTime: '2026-10-05T14:01:22.000Z', free: false, stakeMsat: '100000', joined: 4, committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
    { id: hex(6), startTime: '2026-10-05T13:00:00.000Z', endTime: '2026-10-05T13:01:22.000Z', free: true, stakeMsat: '0', joined: 1, committee: { drawn: true, game: [hex(9)], settlement: [hex(8)] } },
  ],
};
const player = (n, more) => ({ entry: hex(0x40 + n), player: hex(0x50 + n), name: `p${n}`, stakeMsat: '100000', outcome: 'FAILED', score: 0, signedBy: 2,
  wonMsat: '0', winningsState: 'NONE', ...more });
const PAID = { id: hex(5), state: 3, free: false, players: [
  player(1, { outcome: 'FAILED', score: 900, wonMsat: '0' }),
  player(2, { outcome: 'DELIVERED', score: 400, wonMsat: '12345678', winningsState: 'PAID' }),
  player(3, { outcome: 'DELIVERED', score: 700, wonMsat: '12345678', winningsState: 'PAID' }),
  player(4, { outcome: null, score: null, signedBy: 0, name: '<img src=x>', wonMsat: '0' }),
] };

test('upcoming rounds by start, with their stake, entry and committee; finished counted', async () => {
  const p = page({ 'api/rounds': { status: 200, body: ROUNDS } });
  await tick();
  assert.match(p.els.node.textContent, new RegExp(`^node ${'ab'.repeat(32)} · read `));
  assert.equal(p.els.upcount.textContent, '(3)');
  const up = p.els.upcoming.innerHTML;
  const order = [...up.matchAll(/class="id" title="([0-9a-f]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, [hex(1), hex(2), hex(3)], 'sorted by start, not as listed');
  assert.match(up, /entry open<\/span><span class="tag">free<\/span>/);
  assert.match(up, /entry closed<\/span><span class="tag">stake 12,345 sat<\/span>/, 'sats formatted');
  assert.match(up, />pending<\/span><span class="tag">stake 100 sat<\/span>/);
  assert.match(up, /committee not drawn<\/span> <span class="muted">- the beacon is not yet<\/span>/);
  assert.equal(p.els.fincount.textContent, '(2)');
  assert.match(p.els.finished.innerHTML, /4 joined/);
});

test('a paying round\'s players: by wonMsat, then score; "won" only for a positive win; sats formatted; names escaped', async () => {
  const p = page({ 'api/rounds': { status: 200, body: ROUNDS }, 'api/round-result': { status: 200, body: PAID } });
  await tick();
  await p.click(hex(5));
  assert.equal(p.asked.at(-1), `api/round-result?round=${hex(5)}`);
  const html = p.cardFor(hex(5)).acc.innerHTML;
  const rows = [...html.matchAll(/<tr><td>(.*?)<\/tr>/g)].map((m) => m[1]);
  const names = rows.map((r) => (/^(p\d|&lt;img src=x&gt;) /.exec(r) || [])[1]);
  assert.deepEqual(names, ['p3', 'p2', 'p1', '&lt;img src=x&gt;'], 'the two winners first (the higher score first), then by score');
  assert.match(rows[0], /<td class="num won">12,345 sat<\/td><td class="muted">PAID<\/td>/, 'a win formatted and marked won');
  assert.match(rows[2], /<td class="num">0 sat<\/td>/, 'no win: not marked');
  assert.match(rows[3], /no result<\/td><td class="num">-<\/td>/, 'no outcome, no score');
  assert.match(rows[0], /DELIVERED <span class="muted">\(2 signed\)<\/span>/);
  assert.doesNotMatch(html, /<img/, 'a name is never drawn as HTML');
  assert.equal(p.cardFor(hex(5)).btn.attrs['aria-expanded'], 'true');
  await p.click(hex(5));
  assert.equal(p.cardFor(hex(5)).btn.attrs['aria-expanded'], 'false', 'a second click closes it');
});

test('a free round shows dashes and "free round"; nobody played; a round that cannot be read; the node that cannot be read', async () => {
  const p = page((url) => (url === 'api/rounds' ? { status: 200, body: ROUNDS }
    : url.endsWith(hex(6)) ? { status: 200, body: { id: hex(6), free: true, players: [player(1, { outcome: 'DELIVERED', score: 300, wonMsat: '0', winningsState: 'FREE' })] } }
      : { status: 404, body: 'this node holds no such round' }));
  await tick();
  await p.click(hex(6));
  const free = p.cardFor(hex(6)).acc.innerHTML;
  assert.match(free, /<td class="num">-<\/td><td class="muted">free round<\/td>/);
  await p.click(hex(5));
  assert.equal(p.cardFor(hex(5)).acc.innerHTML, '<div class="empty">could not read this round: 404 this node holds no such round</div>');
  const none = page((url) => (url === 'api/rounds' ? { status: 200, body: ROUNDS } : { status: 200, body: { id: hex(5), free: false, players: [] } }));
  await tick();
  await none.click(hex(5));
  assert.equal(none.cardFor(hex(5)).acc.innerHTML, '<div class="empty">nobody played this round</div>');
  const down = page({ 'api/rounds': { status: 500, body: 'down' } });
  await tick();
  assert.equal(down.els.node.textContent, 'could not read this node\'s rounds: 500');
  const empty = page({ 'api/rounds': { status: 200, body: { ...ROUNDS, upcoming: [], finished: [] } } });
  await tick();
  assert.equal(empty.els.upcoming.innerHTML, '<div class="empty">no round announced</div>');
  assert.equal(empty.els.finished.innerHTML, '<div class="empty">no round finished yet</div>');
});
