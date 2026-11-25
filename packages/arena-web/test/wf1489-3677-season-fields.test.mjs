// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-faucet-1 (site Worker, role: ONE of the three season seats, gap in #2698): agreedBoard compares only the boards' `rows`; when two
// seats' rows are the same it serves boards[same] WHOLE - the first agreeing seat's own `rounds`, `seats`, `leftOut`, `agree`, `days`. guardian-1 is
// asked first, so it copies an honest seat's rows (they are public) and every other field of the website board (and /api/testers' allRounds)
// is its word alone. Safe: a field of the served board that no second seat says is not served as the season's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../src/website/worker.js';

test('#3677 #1489 r1-faucet-1: the season board\'s counts are not one seat\'s word when the rows agree', async () => {
  const REAL = 'a1'.repeat(32);
  const rows = [{ rank: 1, player: REAL, name: 'player', rounds: 12, wins: 3, netMsat: '1000' }];
  const honest = { scope: 'network', days: 30, game: { name: 'rock-paper-scissors' }, rows, rounds: 40, leftOut: 0, agree: 3, seats: { asked: 13, answered: 12 } };
  const liar = { ...honest, days: 1, rounds: 987654, leftOut: 55555, agree: 99, seats: { asked: 500, answered: 500 } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/guardian-1/season')) return new Response(JSON.stringify(liar));
    return new Response(JSON.stringify(honest));
  };
  const env = { CHAIN: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  let body;
  try {
    const r = await worker.fetch(new Request('https://bitcoinarena.io/api/season?game=rock-paper-scissors&days=30'), env, { waitUntil: () => {} });
    body = await r.json();
  } finally { globalThis.fetch = real; }
  const s = (body && body.season) || {};
  console.log('  MEASURED board served:', JSON.stringify({ days: s.days, rounds: s.rounds, leftOut: s.leftOut, agree: s.agree, seats: s.seats }));
  assert.equal(s.rounds, 40, 'the board\'s "rounds counted" is guardian-1\'s alone');
  assert.equal(s.days, 30, 'the board\'s window is guardian-1\'s alone');
  assert.deepEqual(s.seats, { asked: 13, answered: 12 }, 'the board\'s "from N of M nodes" is guardian-1\'s alone');
});

test('#3677 a field the seats do not agree on is left out; a board for another window is not counted', async () => {
  const REAL = 'b2'.repeat(32);
  const rows = [{ rank: 1, player: REAL, name: 'player', rounds: 5, wins: 1, netMsat: '10' }];
  const base = { scope: 'network', days: 7, game: { name: 'nextblock' }, rows, leftOut: 0, agree: 3 };
  const by = { 'guardian-1': { ...base, rounds: 99, node: 'aa' }, 'guardian-2': { ...base, rounds: 50, node: 'bb' }, 'guardian-3': { ...base, days: 1, rounds: 99, node: 'cc' } };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(by[/guardian-\d/.exec(String(url))[0]]));
  const env = { CHAIN: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  let body;
  try { body = await (await worker.fetch(new Request('https://bitcoinarena.io/api/season?game=nextblock&days=7'), env, { waitUntil: () => {} })).json(); }
  finally { globalThis.fetch = real; }
  const s = body.season;
  assert.equal(s.days, 7);
  assert.equal(s.rounds, undefined, 'rounds 99 is one 7-day seat\'s word (the other 99 is a 1-day board)');
  assert.equal(s.node, null);
  assert.equal(s.agree, 3);
  assert.deepEqual(s.rows, rows);
});
