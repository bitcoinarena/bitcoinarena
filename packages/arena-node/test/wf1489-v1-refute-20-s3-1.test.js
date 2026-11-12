// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-20 skeptic 3 (re-check of #1511 / #1884): the faucet's node check trusts a listed seat by its HOSTNAME alone
// (seatTrusted: SEAT_TRUSTED_HOSTS.includes(x.hostname)) and then asks it with plain fetch - no resolved-address check. The port and path are the
// announcer's. The default trusted list is the team's public names (beelink.tail1723e2.ts.net -> the Beelink's 100.x Tailscale address, where
// signal-cli 8080, OpenClaw 18789 and the Chrome debug ports listen), and an operator whose own seats are on a loopback/LAN name lists that one.
// So a bonded node announces http://<trusted host>:<any port>/ and a stranger's node check makes the faucet GET /owner, /roles, /served there.
// Here: the operator's seat is on localhost (trusted, as faucet-feedback-1342 configures it); the attacker announces localhost on ANOTHER port.
// Safe: no request reaches the other port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('#1489 v1-refute-20-s3-1: a seat announced on a trusted host but another port is fetched without the public-address guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-v1-refute-20-s3-1-'));
  writeFileSync(join(dir, 'token'), 'x');
  const internalPaths = [];
  const internal = createServer((req, res) => { internalPaths.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => internal.listen(0, '127.0.0.1', r));
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
      FAUCET_BOUNTY_ORIGINS: 'https://bounty.page.example', FAUCET_SEASON_SEATS: `http://localhost:${seat.address().port}`, FAUCET_SEASON_GAMES: 'nextblock',
      FAUCET_SEAT_TRUSTED_HOSTS: 'localhost' } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/rewards`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const r = await fetch(`${base}/feedback/node-check?node=${'ab'.repeat(32)}`, { headers: { origin: 'https://bounty.page.example', 'x-arena-ip': '203.0.113.7' } });
    const answer = await r.json();
    console.log('  FACTS v1-refute-20-s3-1:', JSON.stringify({ status: r.status, passes: answer.passes, internalRequests: internalPaths.length, paths: internalPaths.slice(0, 4) }));
    assert.equal(internalPaths.length, 0, `an announced endpoint on the trusted host's other port got ${internalPaths.length} GET(s) from the faucet (${internalPaths.slice(0, 3).join(', ')})`);
  } finally { faucet.kill(); internal.close(); seat.close(); }
});
