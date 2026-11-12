// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 skeptic 2 (re-check of #1511, a SEAT as the attacker): the faucet's node bounty check (GET /feedback/node-check, public:
// only an Origin header, which any non-browser caller sets) asks every seat the configured seats list in GET /network-games - and those are the
// census nodes' own endpoints, which any bonded node sets by a signed address announcement (no fee, any http(s) URL). The faucet fetches each
// with plain fetch: no public-name check, no resolved-address check, redirects followed. So one seat names http://127.0.0.1:<port> (or
// 169.254.169.254, signal-cli's 8080 ...) and a stranger makes the faucet GET <internal>/owner, /roles (127.0.0.1 is a "team host"), and
// /served for 7 days - the same internal fetch #1511 closed for wallet addresses. Safe: no request reaches the internal host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('#1489 v1-refute-20-s2-1: a seat listing an internal endpoint makes the faucet node check fetch it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-v1-refute-20-s2-1-'));
  writeFileSync(join(dir, 'token'), 'x');
  // the internal service a bonded node announced as its endpoint
  const internalPaths = [];
  const internal = createServer((req, res) => { internalPaths.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
  // an honest configured seat: it lists the census nodes' endpoints, the attacker's among them
  const seat = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/network-games')) return res.end(JSON.stringify({ seats: [{ seat: `http://localhost:${internal.address().port}/` }], games: [] }));
    res.end('{}');
  });
  await new Promise((r) => seat.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_BOUNTY_ORIGINS: 'https://bounty.page.example', FAUCET_SEASON_SEATS: `http://127.0.0.1:${seat.address().port}`, FAUCET_SEASON_GAMES: 'nextblock' } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/rewards`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const r = await fetch(`${base}/feedback/node-check?node=${'ab'.repeat(32)}`, { headers: { origin: 'https://bounty.page.example', 'x-arena-ip': '203.0.113.7' } });
    const answer = await r.json();
    console.log('  FACTS v1-refute-20-s2-1:', JSON.stringify({ status: r.status, passes: answer.passes, internalRequests: internalPaths.length, paths: internalPaths.slice(0, 4) }));
    assert.equal(internalPaths.length, 0, `a stranger's node check made the faucet send ${internalPaths.length} GET(s) to a seat endpoint on 127.0.0.1 (${internalPaths.slice(0, 3).join(', ')})`);
  } finally { faucet.kill(); internal.close(); seat.close(); }
});
