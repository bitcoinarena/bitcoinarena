// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEASON BOARD IN THE PAGE (docs/PLATFORM-RESEARCH.md item 1). The page's own code runs under the page's
// name (page-script.js) on a small fake page, with the bundle the template carries: opened from a game's tile, it asks the
// game's seats for GET /season?game=<name>&days=7&scope=network, the first that answers; draws one row per player with the
// viewer's own marked; the day switch asks for 30 and 90 days at once; it asks again every 30 s while open and never while
// closed; an answer that comes back after a newer ask or after the close is dropped; and it is hidden in the clean view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const BUNDLE = createRequire(import.meta.url)('../../../src/arena-ui/arena-client.js');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SEASON = slice('    (function seasonBoard() {', '\n    })();\n');

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ME = key(0xb2);
const GAME = { id: key(0x0a), name: 'nextblock', title: 'Tick Tock, Next Block', nodes: ['https://seat-1.example', 'https://seat-2.example', 'https://seat-3.example'] };
const answerFor = (days) => ({ node: key(1), game: { name: 'nextblock', ids: [key(0x0a)] }, days, rounds: 9, leftOut: 0, unchecked: [], scope: 'network', agree: 3,
  seats: { asked: 12, answered: 12 },
  rows: [
    { rank: 1, player: key(0x11), name: 'satoshi', rounds: 6, wins: 4, netMsat: String(4200 * days), stakedMsat: '6000', paidMsat: '10200', bestScore: 8304450, lastPlayed: '2026-10-14T12:00:00.000Z' },
    { rank: 2, player: ME, name: 'brave-otter-0042', rounds: 3, wins: 0, netMsat: '3000', stakedMsat: '3000', paidMsat: '6000', bestScore: 120000, lastPlayed: '2026-10-14T13:00:00.000Z' },
  ] });

/** A fake DOM enough for the season view: elements with children, classes, text, attributes, data and handlers. */
function fakePage() {
  const make = (tag, cls = '') => {
    const el = { tag, children: [], className: cls, dataset: {}, handlers: {}, attrs: {}, title: '',
      classList: { add(c) { const s = new Set(el.className.split(' ').filter(Boolean)); s.add(c); el.className = [...s].join(' '); },
        remove(c) { el.className = el.className.split(' ').filter((x) => x && x !== c).join(' '); },
        contains(c) { return el.className.split(' ').includes(c); } },
      append(...xs) { for (const x of xs) el.children.push(typeof x === 'string' ? { tag: '#text', textContent: x, children: [] } : x); },
      addEventListener(ev, f) { el.handlers[ev] = f; },
      click() { if (el.handlers.click) el.handlers.click({ stopPropagation() {}, preventDefault() {} }); },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k]; },
      // as the DOM does: setting the text replaces the children with one text node, and the text is every child's in order
      get textContent() { return el.children.map((c) => c.textContent).join(''); },
      set textContent(t) { el.children = String(t) ? [{ tag: '#text', textContent: String(t), children: [] }] : []; },
    };
    return el;
  };
  const parts = { h2: make('h2'), '.head': make('div', 'head'), '.state': make('div', 'state'), '.board': make('ol', 'board'), '.foot': make('div', 'foot'), '.back': make('button', 'back') };
  const days = [7, 30, 90].map((d) => { const b = make('button'); b.dataset.days = String(d); b.setAttribute('aria-pressed', String(d === 7)); return b; });
  const box = make('div');
  box.querySelector = (sel) => parts[sel] || null;
  box.querySelectorAll = (sel) => (sel === '.days button' ? days : []);
  const els = { 'arena-season': box, 'arena-season-go': make('button'), 'arena-wb-season': make('button') };
  const docHandlers = {};
  const document = { getElementById: (id) => els[id] || null, createElement: (t) => make(t), addEventListener: (ev, f) => { docHandlers[ev] = f; } };
  return { document, box, parts, days, els, docHandlers };
}

/** The view lifted from the page, with a fetch that answers per seat and timers the test runs by hand. */
function liftSeason({ seats = {} } = {}) {
  const dom = fakePage();
  const asked = [];
  const pending = [];          // [{ url, resolve }] while a seat is held back by the test
  const holdBack = { on: false };
  const fetch = (url) => {
    asked.push(url);
    if (!url.startsWith('https://seat-')) throw new Error('asked a seat that is not the game\'s: ' + url);
    const seat = new URL(url).origin;
    const say = seats[seat] || 'answer';
    const days = Number(new URL(url).searchParams.get('days'));
    const reply = say === 'down' ? Promise.reject(new Error('down')) : say === 'busy' ? Promise.resolve({ ok: false, status: 503 })
      : Promise.resolve({ ok: true, status: 200, json: async () => answerFor(days) });
    if (!holdBack.on) return reply;
    return new Promise((resolve) => pending.push({ url, resolve: () => resolve(reply) }));
  };
  const timers = new Map(); let nextTimer = 1;
  const setTimeout = (f, ms) => { const id = nextTimer++; timers.set(id, { f, ms }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const window = { ARENA_IDENTITY: { name: 'brave-otter-0042', pubkey: ME } };
  pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'fetch', 'setTimeout', 'clearTimeout', 'AbortSignal'], SEASON)(
    dom.document, window, BUNDLE, fetch, setTimeout, clearTimeout, { timeout: () => undefined });
  const fire = async () => { const [[id, t]] = [...timers]; timers.delete(id); t.f(); await settle(); };
  return { ...dom, window, asked, timers, fire, pending, holdBack, seats };
}
const settle = () => new Promise((r) => setImmediate(r));
// THE SEASON'S OWN ASKS: a drawn board then asks its seats which of them award badges (page-season-badges.test.js)
const seasonAsks = (asked) => asked.filter((u) => new URL(u).pathname === '/season');
const rowsOf = (board) => board.children.map((li) => ({ rank: li.children[0].textContent, who: li.children[1].children[0].textContent,
  line: li.children[1].children[1].textContent, net: li.children[2].textContent, mine: li.className.split(' ').includes('mine'),
  cls: li.children[2].className }));

test('opened from a tile: the game\'s seats in turn, the first that answers, the board drawn with the viewer\'s row marked', async () => {
  const p = liftSeason({ seats: { 'https://seat-1.example': 'down' } });
  assert.equal(typeof p.window.ARENA_SEASON.open, 'function');
  p.window.ARENA_SEASON.open(GAME);
  assert.equal(p.box.classList.contains('show'), true);
  assert.equal(p.parts['.state'].textContent, 'Asking the nodes …');
  await settle();
  assert.deepEqual(seasonAsks(p.asked), ['https://seat-1.example/season?game=nextblock&days=7&scope=network', 'https://seat-2.example/season?game=nextblock&days=7&scope=network']);
  assert.equal(p.parts.h2.textContent, 'Tick Tock, Next Block');
  assert.equal(p.parts['.head'].textContent, 'Tick Tock, Next Block · last 7 days · 2 players ahead · from 13 of 13 nodes');
  const rows = rowsOf(p.parts['.board']);
  console.log('  SEASON:', JSON.stringify(rows));
  assert.deepEqual(rows, [
    { rank: '1', who: 'satoshi', line: '6 rounds · 4 wins · best 83.04450', net: '+29 sat', mine: false, cls: 'net up' },
    { rank: '2', who: 'brave-otter-0042you', line: '3 rounds · 0 wins · best 1.20000', net: '+3 sat', mine: true, cls: 'net up' },
  ]);
  assert.match(p.parts['.foot'].textContent, /9 rounds counted .* answered by seat-2\.example$/);
  assert.equal(p.window.ARENA_SEASON_LAST.seat, 'https://seat-2.example');
});

test('the day switch asks for 30 and 90 days at once, and marks the window it shows', async () => {
  const p = liftSeason();
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  p.days[1].click();
  await settle();
  assert.equal(p.asked.at(-1), 'https://seat-1.example/season?game=nextblock&days=30&scope=network');
  assert.deepEqual(p.days.map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.equal(p.parts['.head'].textContent, 'Tick Tock, Next Block · last 30 days · 2 players ahead · from 13 of 13 nodes');
  assert.equal(rowsOf(p.parts['.board'])[0].net, '+126 sat');
  p.days[2].click();
  await settle();
  assert.equal(p.asked.at(-1), 'https://seat-1.example/season?game=nextblock&days=90&scope=network');
  assert.equal(rowsOf(p.parts['.board'])[0].net, '+378 sat');
  const n = p.asked.length;
  p.days[2].click();
  await settle();
  assert.equal(p.asked.length, n, 'the window it shows already is not asked again on a tap');
  // AN ANSWER THAT COMES BACK AFTER A NEWER ASK IS DROPPED: 7 days asked, then 30 before 7 answered; 7 answers last
  p.holdBack.on = true;
  p.days[0].click(); p.days[1].click();
  const [seven, thirty] = p.pending;
  thirty.resolve(); await settle();
  seven.resolve(); await settle();
  assert.equal(p.parts['.head'].textContent, 'Tick Tock, Next Block · last 30 days · 2 players ahead · from 13 of 13 nodes', 'the older ask drew over the newer');
});

test('asked again every 30 s while open, never while closed; Back and Escape close it', async () => {
  const p = liftSeason();
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  assert.deepEqual([...p.timers.values()].map((t) => t.ms), [30000], 'one ask pending, in 30 s');
  await p.fire();
  assert.equal(seasonAsks(p.asked).length, 2);
  assert.deepEqual([...p.timers.values()].map((t) => t.ms), [30000], 'and the next one, never two');
  p.parts['.back'].click();
  assert.equal(p.box.classList.contains('show'), false);
  assert.equal(p.timers.size, 0, 'closed: nothing is asked any more');
  assert.equal(p.window.ARENA_SEASON.polling(), false);
  // an answer in flight when it closed is dropped, and schedules nothing
  p.holdBack.on = true;
  p.window.ARENA_SEASON.open(GAME);
  p.docHandlers.keydown({ key: 'Escape' });
  assert.equal(p.window.ARENA_SEASON.isOpen(), false);
  p.pending[0].resolve(); await settle();
  assert.equal(p.timers.size, 0, 'an answer after the close asked again');
});

test('no seat answers: said, the board from before kept, and asked again in 30 s', async () => {
  // never answered: said, nothing drawn
  const q = liftSeason({ seats: Object.fromEntries(GAME.nodes.map((n) => [n, 'busy'])) });
  q.window.ARENA_SEASON.open(GAME);
  await settle();
  assert.equal(q.asked.length, 3, 'every seat asked once');
  assert.equal(q.parts['.state'].textContent, 'No node answered the leaderboard just now. Asking again in 30 s.');
  assert.equal(q.parts['.state'].className, 'state bad');
  assert.equal(q.parts['.board'].children.length, 0);
  assert.deepEqual([...q.timers.values()].map((t) => t.ms), [30000]);
  // answered once, then every seat down: the board of 30 s ago stays, and says so
  const p = liftSeason();
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  const before = rowsOf(p.parts['.board']);
  for (const n of GAME.nodes) p.seats[n] = n.includes('seat-1') ? 'down' : 'busy';
  await p.fire();
  assert.deepEqual(rowsOf(p.parts['.board']), before);
  assert.equal(p.parts['.state'].textContent, 'No node answered just now; this is the board from before. Asking again in 30 s.');
  assert.equal(p.window.ARENA_SEASON_LAST.ok, false);
  assert.equal(p.timers.size, 1);
});

test('its ways in: a link on each tile, the strip beside the gear and the wallet bar once a game is chosen; hidden in the clean view', async () => {
  assert.match(HTML, /season\.className = 'season-go'/);
  assert.match(HTML, /b\.append\(play, head, desc, signed, stats, season\);/);
  assert.match(HTML, /window\.ARENA_SEASON\.open\(g\)/);
  // the class follows the choice within a few lines (22b2b331 put the wallet's early start between them)
  assert.match(HTML, /window\.ARENA_GAME_CHOSEN = game;\n(?:.*\n){1,6}\s+document\.body\.classList\.add\('arena-game-chosen'\);/);
  assert.match(HTML, /<button id="arena-season-go" type="button"/);
  assert.match(HTML, /<button id="arena-wb-season" type="button"/);
  assert.match(HTML, /body\.blwp-clean #arena-season, body\.blwp-clean #arena-season-go, body\.blwp-clean #arena-wb-season \{ display: none !important; \}/);
  assert.match(HTML, /#arena-season-go, #arena-wb-season \{ display: none; \}/, 'not before a game is chosen');
  // the strip's button opens the chosen game's board
  const p = liftSeason();
  p.window.ARENA_GAME_CHOSEN = GAME;
  p.els['arena-season-go'].click();
  await settle();
  assert.equal(p.window.ARENA_SEASON.isOpen(), true);
  assert.equal(p.asked[0], 'https://seat-1.example/season?game=nextblock&days=7&scope=network');
});
