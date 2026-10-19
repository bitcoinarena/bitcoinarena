// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BADGES ON THE SEASON BOARD IN THE PAGE (kanban #362, PLATFORM-RESEARCH items 13 + 1). The page's season view (lifted by
// its text and run under the page's name, page-script.js) on a small fake page, with the bundle the template carries, over
// three fake seats: seat-1 answers `on: false` (it awards no badges), seat-2 `on: true`, seat-3 is down for badges. The rows
// are drawn before any badge is in; then each row's icons fill in (the seat's image where its definition names one, the
// glyph where not), the viewer's row too, and "Your badges: N" under the header; each player is asked once per badge seat
// for the board's life - through the 30 s re-ask and a day switch - and nothing while closed; only the rows on screen when
// the page can tell (IntersectionObserver); a tap says the badge in words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const BUNDLE = createRequire(import.meta.url)('../../../unity-proto/Assets/WebGLTemplates/NextBlock/arena-client.js');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SEASON = slice('    (function seasonBoard() {', '\n    })();\n');

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const ME = key(0xb2), SAT = key(0x11), BOB = key(0x33);
const GAME = { id: key(0x0a), name: 'nextblock', title: 'Tick Tock, Next Block', nodes: ['https://seat-1.example', 'https://seat-2.example', 'https://seat-3.example'] };
const season = (days) => ({ node: key(1), game: { name: 'nextblock', ids: [key(0x0a)] }, days, rounds: 9, leftOut: 0, scope: 'network', agree: 3,
  seats: { asked: 12, answered: 12 },
  rows: [
    { rank: 1, player: SAT, name: 'satoshi', rounds: 6, wins: 4, netMsat: '4200', bestScore: 8304450 },
    { rank: 2, player: ME, name: 'brave-otter-0042', rounds: 5, wins: 1, netMsat: '3000', bestScore: 120000 },
    { rank: 3, player: BOB, name: 'bob', rounds: 1, wins: 0, netMsat: '1000', bestScore: null },
  ] });
const def = (d, name, description, image) => ({ event: { kind: 30009, tags: [['d', d], ['name', name], ['description', description],
  ...(image ? [['image', `https://seat-2.example/badge-image/${d}.svg`]] : []), ['alt', 'a']] }, publishedMs: null });
const DEFS = [def('arena-first-win', 'First win', 'Won a staked round of a game for the first time.', true),
  def('arena-five-rounds', 'Five rounds', 'Played five staked rounds of a game.', true),
  def('arena-season-top-3', 'Season top 3', 'Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).', false)];
const award = (d, game, scope, player) => ({ d, game, scope, evidence: {}, event: { kind: 8, tags: [['a', `30009:${key(2)}:${d}`], ['p', player]] } });
// SEAT-2'S AWARDS: satoshi a first win and a weekly podium (and a badge in another game, never shown here); the viewer five
// rounds and a first win; bob none
const AWARDS = {
  [SAT]: [award('arena-first-win', 'nextblock', 'nextblock', SAT), award('arena-season-top-3', 'nextblock', 'nextblock@2026-10-05', SAT), award('arena-first-win', 'rps', 'rps', SAT)],
  [ME]: [award('arena-five-rounds', 'nextblock', 'nextblock', ME), award('arena-first-win', 'nextblock', 'nextblock', ME)],
  [BOB]: [],
};

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
      get textContent() { return el.children.map((c) => c.textContent).join(''); },
      set textContent(t) { el.children = String(t) ? [{ tag: '#text', textContent: String(t), children: [] }] : []; },
    };
    return el;
  };
  const parts = { h2: make('h2'), '.head': make('div', 'head'), '.mybadges': make('div', 'mybadges'), '.state': make('div', 'state'), '.board': make('ol', 'board'),
    '.foot': make('div', 'foot'), '.back': make('button', 'back') };
  const days = [7, 30, 90].map((d) => { const b = make('button'); b.dataset.days = String(d); b.setAttribute('aria-pressed', String(d === 7)); return b; });
  const box = make('div');
  box.querySelector = (sel) => parts[sel] || null;
  box.querySelectorAll = (sel) => (sel === '.days button' ? days : []);
  const els = { 'arena-season': box, 'blwp-season-go': make('button'), 'arena-wb-season': make('button') };
  const docHandlers = {};
  const document = { getElementById: (id) => els[id] || null, createElement: (t) => make(t), addEventListener: (ev, f) => { docHandlers[ev] = f; } };
  return { document, box, parts, days, els, docHandlers };
}

/**
 * The view lifted from the page over the three seats, reached through a route (BLWP_ROUTED_URL: https://r.<seat>), badge
 * answers (never the season's) held back while `hold.on`. `observer`: a fake IntersectionObserver class, or none (every drawn row is asked).
 */
function liftSeason({ observer } = {}) {
  const dom = fakePage();
  const asked = [];
  const pending = [];
  const hold = { on: false };
  const fetch = (routed) => {
    asked.push(routed);
    assert.match(routed, /^https:\/\/r\.seat-\d\.example\//, 'every seat is asked through its route');
    const url = new URL(routed.replace('https://r.', 'https://'));
    const seat = url.origin;
    if (url.pathname === '/season') return Promise.resolve({ ok: true, status: 200, json: async () => season(Number(url.searchParams.get('days'))) });
    // THE ANSWER MADE WHEN IT IS GIVEN: a refusal made while held back would be a rejection nobody handles yet
    let reply;
    if (seat === 'https://seat-3.example') reply = () => Promise.reject(new Error('down'));
    else if (url.pathname === '/badge-definitions') reply = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ on: seat === 'https://seat-2.example', definitions: seat === 'https://seat-2.example' ? DEFS : [] }) });
    else if (url.pathname === '/badges') {
      const player = url.searchParams.get('player');
      const on = seat === 'https://seat-2.example';
      const mine = on ? AWARDS[player] || [] : [];
      reply = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ player, on, awards: mine, definitions: on ? DEFS.filter((x) => mine.some((a) => a.d === x.event.tags[0][1])) : [] }) });
    } else reply = () => Promise.resolve({ ok: false, status: 404 });
    if (!hold.on) return reply();
    return new Promise((resolve, reject) => pending.push({ url: routed, go: () => reply().then(resolve, reject) }));
  };
  const timers = new Map(); let nextTimer = 1;
  const setTimeout = (f, ms) => { const id = nextTimer++; timers.set(id, { f, ms }); return id; };
  const clearTimeout = (id) => { timers.delete(id); };
  const window = { BLWP_IDENTITY: { name: 'brave-otter-0042', pubkey: ME }, BLWP_ROUTED_URL: (u) => u.replace('https://', 'https://r.') };
  pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'fetch', 'setTimeout', 'clearTimeout', 'AbortSignal', 'IntersectionObserver'], SEASON)(
    dom.document, window, BUNDLE, fetch, setTimeout, clearTimeout, { timeout: () => undefined }, observer);
  const fire = async () => { const [[id, t]] = [...timers]; timers.delete(id); t.f(); await settle(); };
  return { ...dom, window, asked, timers, fire, pending, hold };
}
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };
const rowOf = (board, i) => board.children[i];
const nameLine = (li) => li.children[1].children[0];
const iconsOf = (li) => nameLine(li).children[1].children.map((b) => ({ title: b.title, img: b.children[0] ? b.children[0].src : null,
  mark: b.attrs['data-mark'] || null, style: b.attrs.style || null }));
const badgeAsks = (asked) => asked.filter((u) => u.includes('/badges?'));
const defAsks = (asked) => asked.filter((u) => u.endsWith('/badge-definitions'));

test('rows first, icons after: each row\'s badges from the badge seat, the viewer\'s line, the request bound', async () => {
  const p = liftSeason();
  p.hold.on = true;
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  // THE BOARD IS DRAWN while every badge answer is still on its way: rows, names, no icons, no line
  assert.equal(p.parts['.board'].children.length, 3);
  assert.deepEqual(p.parts['.board'].children.map((li) => nameLine(li).textContent), ['satoshi', 'brave-otter-0042you', 'bob']);
  assert.deepEqual(p.parts['.board'].children.map((li) => iconsOf(li).length), [0, 0, 0]);
  assert.equal(p.parts['.mybadges'].textContent, '');
  assert.equal(p.asked[0], 'https://r.seat-1.example/season?game=nextblock&days=7&scope=network', 'the board asked first');
  assert.deepEqual(defAsks(p.asked), ['https://r.seat-1.example/badge-definitions', 'https://r.seat-2.example/badge-definitions', 'https://r.seat-3.example/badge-definitions']);
  p.hold.on = false;
  for (const x of p.pending.splice(0)) x.go();
  await settle();
  const icons = [0, 1, 2].map((i) => iconsOf(rowOf(p.parts['.board'], i)));
  console.log('  BADGES:', JSON.stringify(icons));
  assert.deepEqual(icons[0], [
    { title: 'First win: Won a staked round of a game for the first time.', img: 'https://r.seat-2.example/badge-image/arena-first-win.svg', mark: null, style: null },
    { title: 'Season top 3: Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).', img: null, mark: '3', style: '--bc:#b06cff' },
  ], 'satoshi: the seat\'s image where its definition names one, the glyph where not; the other game\'s badge not shown');
  assert.deepEqual(icons[1].map((x) => x.title.split(':')[0]), ['First win', 'Five rounds'], 'the viewer\'s row too, in the catalogue\'s order');
  assert.deepEqual(icons[2], [], 'bob: none, nothing shown');
  assert.equal(p.parts['.mybadges'].textContent, 'Your badges: 2');
  assert.equal(nameLine(rowOf(p.parts['.board'], 1)).textContent, 'brave-otter-0042you', 'the row\'s words are still the name and "you"');
  // ONE REQUEST PER PLAYER, of the one seat that awards badges; none of the seat that said `on: false` or the one that is down
  const once = () => {
    const b = badgeAsks(p.asked);
    assert.deepEqual(b.map((u) => new URL(u).origin), ['https://r.seat-2.example', 'https://r.seat-2.example', 'https://r.seat-2.example']);
    assert.deepEqual(b.map((u) => new URL(u).searchParams.get('player')).sort(), [SAT, ME, BOB].sort());
    assert.equal(defAsks(p.asked).length, 3, 'each seat asked once which badges it awards');
  };
  once();
  assert.deepEqual(p.window.ARENA_SEASON.badgesAsked(), { definitions: 3, badges: 3 });
  // THE 30 s RE-ASK AND A DAY SWITCH redraw the rows: the icons are drawn from what the board holds, nothing asked again
  await p.fire();
  p.days[1].click();
  await settle();
  once();
  assert.equal(iconsOf(rowOf(p.parts['.board'], 0)).length, 2);
  assert.equal(p.parts['.mybadges'].textContent, 'Your badges: 2');
  // A TAP SAYS IT on the row's own line; the same badge again hides it
  const say = rowOf(p.parts['.board'], 0).children[1].children[2];
  nameLine(rowOf(p.parts['.board'], 0)).children[1].children[1].click();
  assert.equal(say.textContent, 'Season top 3: Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).');
  nameLine(rowOf(p.parts['.board'], 0)).children[1].children[1].click();
  assert.equal(say.textContent, '');
});

test('closed: nothing asked, a late answer not drawn; opened again, a new board\'s life asks again', async () => {
  const p = liftSeason();
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  assert.equal(badgeAsks(p.asked).length, 3);
  p.parts['.back'].click();
  assert.equal(p.parts['.mybadges'].textContent, '', 'the viewer\'s line goes with the board');
  const n = p.asked.length;
  await settle();
  assert.equal(p.asked.length, n, 'nothing asked while closed');
  // A BADGE ANSWER STILL ON ITS WAY AT THE CLOSE is dropped
  p.hold.on = true;
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  const before = p.asked.length;
  assert.ok(defAsks(p.asked.slice(n)).length === 3, 'the new board asks again which seats award badges');
  p.window.ARENA_SEASON.close();
  p.hold.on = false;
  for (const x of p.pending.splice(0)) x.go();
  await settle();
  assert.equal(p.asked.length, before, 'a board closed while its seats were asked asks nobody after');
  assert.equal(iconsOf(rowOf(p.parts['.board'], 0)).length, 0, 'and draws nothing');
  assert.equal(p.parts['.mybadges'].textContent, '');
});

test('only the rows on screen: an IntersectionObserver names the rows seen, and only those (and the viewer) are asked', async () => {
  const made = [];
  class Seen {
    constructor(f, o) { this.f = f; this.o = o; this.watched = new Set(); made.push(this); }
    observe(t) { this.watched.add(t); }
    unobserve(t) { this.watched.delete(t); }
    disconnect() { this.watched.clear(); }
    show(t) { this.f([{ target: t, isIntersecting: true }], this); }
  }
  const p = liftSeason({ observer: Seen });
  p.window.ARENA_SEASON.open(GAME);
  await settle();
  const seen = made.at(-1);
  assert.equal(seen.o.root, p.box, 'seen within the board\'s own scrolling view');
  assert.equal(seen.watched.size, 3);
  assert.deepEqual(badgeAsks(p.asked).map((u) => new URL(u).searchParams.get('player')), [ME], 'the viewer, for the line under the header');
  seen.show(rowOf(p.parts['.board'], 0));
  await settle();
  assert.deepEqual(badgeAsks(p.asked).map((u) => new URL(u).searchParams.get('player')), [ME, SAT]);
  assert.equal(seen.watched.size, 2, 'a row seen once is watched no more');
  assert.equal(iconsOf(rowOf(p.parts['.board'], 0)).length, 2);
  assert.equal(iconsOf(rowOf(p.parts['.board'], 2)).length, 0, 'bob, never on screen, never asked');
});
