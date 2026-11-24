// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit client round 2, finding 2 (gap in the #3308 fix): fetchSeason confirms a row's key when two ANSWERS give it under the row's name
// (confirmRows), counted per URL of the node list. game.nodes keeps every address a seat was reached at (fetchGames, #3253), so one box
// named under two paths (https://liar.example/a, /b - a link's node list, or one seat behind two addresses) is the "second seat" #3308
// waits for. The honest seats take 22-50 s to build a network season (kanban #3289) and the race waits only SEASON_CONFIRM_MS (1.5 s)
// past the first answer: the box's two instant answers confirm its own key under the leader's name, and the page's zap pays it.
// Safe behaviour: answers of one host count as one confirmation, so the row stays keyUnconfirmed (no zap) or carries the honest key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSeason } from '../src/season-view.js';

const key = (n) => n.toString(16).padStart(2, '0').repeat(32);
const HONEST = key(0x5a), ATTACKER = key(0xee);
const row = (player) => ({ rank: 1, player, name: 'Satoshi', rounds: 40, wins: 30, netMsat: '900000', bestScore: 8304450 });
const board = (player) => ({ node: key(0x01), game: { name: 'nextblock', ids: [key(0x0a)] }, days: 7, rows: [row(player)],
  rounds: 41, leftOut: 0, scope: 'network', agree: 3, seats: { asked: 3, answered: 3 } });

test('two paths of one box do not confirm the key a zap to the board\'s leader pays', async () => {
  const seats = ['https://liar.example/a', 'https://liar.example/b', 'https://a.example', 'https://b.example', 'https://c.example'];
  const fetch = async (url) => {
    const liar = url.startsWith('https://liar.example/');
    if (!liar) await new Promise((r) => setTimeout(r, 2500));   // honest seats: a network season takes seconds to build
    return new Response(JSON.stringify(board(liar ? ATTACKER : HONEST)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  // as the page asks (index.html: race 8, answerMs 45000)
  const v = await fetchSeason({ nodes: seats, game: 'nextblock', days: 7, fetch, race: 8, answerMs: 45000 });
  const top = v.ok ? v.rows.find((r) => r.name === 'Satoshi') : null;
  // the page's zap button (index.html onZap) pays r.player unless r.keyUnconfirmed
  const zapPays = top && !top.keyUnconfirmed ? top.player : null;
  console.log(`board from ${v.seat}; Satoshi's key ${top && top.player.slice(0, 8)}…, keyUnconfirmed ${top && !!top.keyUnconfirmed}`);
  assert.ok(zapPays === null || zapPays === HONEST,
    `a zap to "Satoshi" pays ${zapPays && zapPays.slice(0, 8)}…, the key only one box (two paths) named, while three seats name ${HONEST.slice(0, 8)}…`);
});

// The same gap with no link: a batch of ONE seat is asked with a bare ask() and its view returned whole - no confirmRows, no
// keyUnconfirmed. With race 8 a node list of 9 (or 17, ...) seats ends in such a batch: when the 8 ahead of it give no board in time
// (a network season takes 22-50 s against the 45 s limit, or they answer 503 while building), the 9th seat's unconfirmed key is the zap's.
test('the last seat of a race of eight alone does not decide the key a zap pays', async () => {
  const seats = [...Array.from({ length: 8 }, (_, i) => `https://s${i}.example`), 'https://liar.example'];
  const fetch = async (url) => {
    if (!url.startsWith('https://liar.example')) return new Response('building', { status: 503 });
    return new Response(JSON.stringify(board(ATTACKER)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const v = await fetchSeason({ nodes: seats, game: 'nextblock', days: 7, fetch, race: 8, answerMs: 45000 });
  const top = v.ok ? v.rows.find((r) => r.name === 'Satoshi') : null;
  const zapPays = top && !top.keyUnconfirmed ? top.player : null;
  console.log(`board from ${v.seat}; Satoshi's key ${top && top.player.slice(0, 8)}…, keyUnconfirmed ${top && !!top.keyUnconfirmed}`);
  assert.equal(zapPays, null, `a zap to "Satoshi" pays ${zapPays && zapPays.slice(0, 8)}…, a key no second seat confirmed`);
});
