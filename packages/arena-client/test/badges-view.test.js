// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S BADGES ON THE SEASON BOARD (kanban #362, PLATFORM-RESEARCH items 13 + 1; badges-view.js): the badge seats'
// answers merged by (d, scope) - one award shown once whichever seat issued it - the shown game's only, an `on: false` seat
// and an answer for somebody else read as nothing, the first seat's definition winning, the icon (the seat's image or the
// built-in glyph), the words, and the book that asks each player once per badge seat and nothing once closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBadgeAwards, readBadgeDefinition, badgeTitle, yourBadgesLine, badgeGlyph, badgeImagePath, badgesPath, badgeBook,
  BADGE_GLYPHS } from '../src/badges-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const P = key(0x11), Q = key(0x22);
const def = (d, name, description, image = true) => ({ event: { kind: 30009, pubkey: key(1), created_at: 1, content: '', id: 'x', sig: 'y',
  tags: [['d', d], ['name', name], ['description', description], ...(image ? [['image', `https://seat.example/badge-image/${d}.svg`]] : []), ['alt', 'a']] }, publishedMs: null });
const award = (d, game, scope, player = P) => ({ d, game, scope, evidence: {}, awardedMs: 1, publishedMs: null,
  event: { kind: 8, tags: [['a', `30009:${key(1)}:${d}`], ['p', player], ['t', game]] } });
const FW = def('arena-first-win', 'First win', 'Won a staked round of a game for the first time.');
const TOP = def('arena-season-top-3', 'Season top 3', 'Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).', false);

test('merged by (d, scope): a badge two seats issued shows once; two weeks on the podium count twice under one icon', () => {
  const a = { player: P, on: true, definitions: [FW, TOP], awards: [award('arena-first-win', 'nextblock', 'nextblock'),
    award('arena-season-top-3', 'nextblock', 'nextblock@2026-10-05')] };
  const b = { player: P, on: true, definitions: [def('arena-first-win', 'Other words', 'Other.'), TOP], awards: [award('arena-first-win', 'nextblock', 'nextblock'),
    award('arena-season-top-3', 'nextblock', 'nextblock@2026-09-28')] };
  const m = mergeBadgeAwards([{ seat: 'https://seat-1.example/', answer: a }, { seat: 'https://seat-7.example', answer: b }], { player: P, game: 'nextblock' });
  assert.equal(m.count, 3);
  assert.deepEqual(m.badges.map((x) => [x.d, x.count, x.name, x.image]), [
    ['arena-first-win', 1, 'First win', 'https://seat-1.example/badge-image/arena-first-win.svg'],
    ['arena-season-top-3', 2, 'Season top 3', null],
  ], 'the first seat\'s definition wins; a definition with no image is the glyph');
  assert.equal(m.badges[1].title, 'Season top 3 ×2: Finished first, second or third on a game\'s weekly board (Monday to Monday, UTC).');
  assert.deepEqual(m.badges[1].glyph, BADGE_GLYPHS['arena-season-top-3']);
});

test('only the shown game, only `on: true`, only this player; odd awards and definitions are nothing', () => {
  const answer = { player: P, on: true, definitions: [FW, { event: { kind: 30009, tags: [['d', 'Bad D']] } }, { event: { kind: 1, tags: [['d', 'x']] } }],
    awards: [award('arena-first-win', 'rps', 'rps'), award('arena-five-rounds', 'nextblock', 'nextblock', Q), { d: '../x', game: 'nextblock', scope: 'nextblock' },
      { d: 'arena-perfect-run', game: 'nextblock', scope: '' }, null, award('arena-perfect-run', 'nextblock', 'nextblock')] };
  const m = mergeBadgeAwards([{ seat: 'https://a.example', answer }, { seat: 'https://b.example', answer: { ...answer, on: false, awards: [award('arena-five-rounds', 'nextblock', 'nextblock')] } },
    { seat: 'https://c.example', answer: { ...answer, player: Q, awards: [award('arena-five-rounds', 'nextblock', 'nextblock')] } }], { player: P, game: 'nextblock' });
  assert.equal(m.count, 1);
  assert.deepEqual(m.badges.map((x) => [x.d, x.name, x.description, x.image]), [['arena-perfect-run', 'arena-perfect-run', '', null]], 'no definition: its d, the glyph');
  assert.equal(m.badges[0].title, 'arena-perfect-run');
  assert.deepEqual(mergeBadgeAwards([], { player: P, game: 'nextblock' }), { player: P, count: 0, badges: [] });
  assert.deepEqual(mergeBadgeAwards(null, { player: P, game: 'nextblock' }).badges, []);
});

test('the catalogue\'s order, at most five icons, a definition read and cut', () => {
  const ds = ['zz-later', 'arena-season-top-3', 'aa-other', 'arena-perfect-run', 'arena-five-rounds', 'arena-first-win'];
  const m = mergeBadgeAwards([{ seat: 'https://a.example', answer: { player: P, on: true, definitions: [], awards: ds.map((d) => award(d, 'g', 'g')) } }], { player: P, game: 'g' });
  assert.equal(m.count, 6);
  assert.deepEqual(m.badges.map((x) => x.d), ['arena-first-win', 'arena-five-rounds', 'arena-perfect-run', 'arena-season-top-3', 'aa-other']);
  assert.deepEqual(badgeGlyph('aa-other'), { colour: '#8a96a8', mark: '•' });
  const long = readBadgeDefinition({ kind: 30009, tags: [['d', 'arena-x'], ['name', 'N'.repeat(80)], ['description', ' D ']] });
  assert.equal(long.name.length, 60);
  assert.equal(long.description, 'D');
  assert.equal(long.image, false);
  assert.equal(readBadgeDefinition(null), null);
  assert.equal(badgeImagePath('arena-first-win'), '/badge-image/arena-first-win.svg');
  assert.equal(badgeImagePath('../etc'), null);
  assert.equal(badgesPath(P.toUpperCase()), `/badges?player=${P}`);
});

test('the words: a tooltip, the viewer\'s line', () => {
  assert.equal(badgeTitle({ name: 'First win', description: 'Won.' }), 'First win: Won.');
  assert.equal(badgeTitle({ name: 'First win', count: 3 }), 'First win ×3');
  assert.equal(yourBadgesLine({ count: 3 }), 'Your badges: 3');
  assert.equal(yourBadgesLine({ count: 0 }), null);
  assert.equal(yourBadgesLine(null), null);
});

test('the book: the seats asked once which award badges, each player once per badge seat, nothing once closed', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (u.origin === 'https://down.example') throw new Error('down');
    const on = u.origin === 'https://on.example';
    if (u.pathname === '/badge-definitions') return { ok: true, status: 200, json: async () => ({ on, definitions: on ? [FW] : [] }) };
    const player = u.searchParams.get('player');
    return { ok: true, status: 200, json: async () => ({ player, on, definitions: on ? [FW] : [], awards: on && player === P ? [award('arena-first-win', 'nextblock', 'nextblock')] : [] }) };
  };
  const heard = [];
  const book = badgeBook({ nodes: ['https://off.example', 'https://on.example/', 'https://down.example', 'not a url'], game: 'nextblock', fetch,
    via: (u) => u, atOnce: 1, onBadges: (p, m) => heard.push([p.slice(0, 2), m.count]) });
  book.want(P); book.want(P); book.want(Q); book.want('nope');
  assert.equal(book.get(P), null, 'not in yet');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard, [['11', 1], ['22', 0]]);
  assert.deepEqual(book.seats(), ['https://on.example']);
  assert.deepEqual(asked.filter((u) => u.includes('/badges?')), [`https://on.example/badges?player=${P}`, `https://on.example/badges?player=${Q}`]);
  assert.equal(asked.filter((u) => u.endsWith('/badge-definitions')).length, 3, 'each seat asked once which badges it awards');
  assert.deepEqual(book.asked, { definitions: 3, badges: 2 });
  assert.equal(book.get(P).badges[0].image, 'https://on.example/badge-image/arena-first-win.svg');
  book.want(P);
  book.close();
  book.want(key(0x33));
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 5, 'asked again, or asked once closed');
});
