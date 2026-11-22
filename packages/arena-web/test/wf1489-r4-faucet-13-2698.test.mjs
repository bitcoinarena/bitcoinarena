// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-faucet-13 (site Worker, role: ONE of the three season seats): GET /api/season (the website's leaderboard, and through the cron's KV
// copy the public tester report /api/testers) is Promise.any over guardian-1..3 - the FIRST seat that answers any parseable JSON is the board, kept
// for 30 minutes (P8). The seat answering fastest shows any ranking it likes: a made-up leader with 10,000 rounds, real players removed.
// Safe: a board only one of the three seats says is not shown as the season's board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../src/website/worker.js';

test('#1489 r4-faucet-13: the website\'s season board is not one seat\'s word', async () => {
  const REAL = 'a1'.repeat(32), FAKE = 'f0'.repeat(32);
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/guardian-1/season')) return new Response(JSON.stringify({ rows: [{ player: FAKE, name: 'made up', rounds: 10000, netMsat: '999999999' }] }));
    await new Promise((ok) => setTimeout(ok, 30));
    return new Response(JSON.stringify({ rows: [{ player: REAL, name: 'player', rounds: 12, netMsat: '1000' }] }));
  };
  const env = { CHAIN: { get: async () => null, put: async () => {} }, ASSETS: { fetch: async () => new Response('x') } };
  let body;
  try {
    const r = await worker.fetch(new Request('https://bitcoinarena.io/api/season?game=rock-paper-scissors&days=30'), env, { waitUntil: () => {} });
    body = await r.json();
  } finally { globalThis.fetch = real; }
  const rows = (body && body.season && body.season.rows) || [];
  console.log('  MEASURED board shown:', JSON.stringify(rows.map((x) => ({ player: x.player.slice(0, 4), rounds: x.rounds }))));
  assert.ok(!rows.some((x) => x.player === FAKE), 'the leader only guardian-1 names is shown as the season board');
  assert.ok(rows.some((x) => x.player === REAL), 'the player two seats list is missing from the board');
});
