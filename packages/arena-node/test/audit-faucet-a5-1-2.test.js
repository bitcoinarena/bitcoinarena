// kanban #3300: the card's test (audit faucet a5-1-2)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT faucet a5-1-2 (P4/P5, P11 gap in the #3259 fix): GET /feedback/node-check now queues checks instead of refusing everyone while one runs,
// but the queue is one for all callers and holds NODE_CHECK_QUEUE_MOST (8) waiting; past that every caller is answered 429 'node checks are
// queued'. The per-caller bound is 10 checks an hour per /64, and a stranger has as many /64s as he likes (and the Origin header is his to
// write). So instead of #3259's checks one after another he sends nine at once from nine /64s - each a random node key, so no cache and no shared
// check - and the honest operator asking for his own node's checklist is refused 429 again, for as long as the stranger keeps the queue full
// (a live check reads every seat, ~30 s, so ~120 checks an hour keep it full: 12 /64s of one home /56).
// Safe (as #3259's own test states it): checks other callers started do not refuse an honest caller's node check with 429.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');

test('audit faucet a5-1-2: nine parallel stranger node checks from nine /64s do not refuse an honest operator\'s node check', { timeout: 90000 }, async () => {
  // the faucet's own (honest) seat: each read takes 1.5 s, as a live check over every seat takes ~30 s
  const seat = createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/network-games') ? '{"seats":[]}' : '{}'); }, 1500); }).listen(0, '127.0.0.1');
  await once(seat, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-a5-1-2-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_BOUNTY_ORIGINS: 'https://bounty.test',
    FAUCET_SEASON_SEATS: `http://127.0.0.1:${seat.address().port}`, FAUCET_FEEDBACK_EXCLUDED: join(dir, 'none') } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    await new Promise((ok) => setTimeout(ok, 2000));   // the start-up season read is done
    const ask = (node, ip) => fetch(`http://127.0.0.1:${port}/feedback/node-check?node=${node}`, { headers: { origin: 'https://bounty.test', 'x-forwarded-for': ip } })
      .then(async (r) => ({ status: r.status, j: await r.json() }));
    // the stranger: nine random node keys at once, each from its own /64 of one /48 (one check each - far under 10 an hour per /64)
    const stranger = Promise.all(Array.from({ length: 9 }, (_, i) => ask((i + 1).toString(16).repeat(64), `2001:db8:77:${i + 1}::1`)));
    await new Promise((ok) => setTimeout(ok, 300));
    // the honest operator asks a few times for its own node, from its own address, while the stranger's checks wait
    const honest = [];
    for (let i = 0; i < 4; i++) {
      const r = await Promise.race([ask('ab'.repeat(32), '198.51.100.20'), new Promise((ok) => setTimeout(() => ok({ status: 'queued', j: {} }), 2500))]);
      honest.push(r); if (r.status !== 429) break; await new Promise((ok) => setTimeout(ok, 1500));
    }
    const refused = honest.filter((x) => x.status === 429).length;
    console.log('  MEASURED a5-1-2:', JSON.stringify({ honestAsks: honest.map((x) => `${x.status} ${x.j.why || ''}`.trim()), honestRefused: refused }));
    await stranger.catch(() => null);
    assert.equal(refused, 0, `${refused} of ${honest.length} honest node checks refused 429 while a stranger's parallel checks filled the shared queue`);
  } finally { child.kill(); seat.close(); }
});
