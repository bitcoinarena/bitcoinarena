// kanban #3259: the card's test (audit tonight, faucet-3259)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r21 faucet 3 (P4/P5): GET /feedback/node-check (public; the bounty page's Origin header any client writes) runs ONE check at a time for
// every caller together (NODE_CHECK_BUSY) and answers every other caller 429 while it runs. A fresh check reads every listed seat (~30 s live).
// A stranger's own checks (random node keys miss the cache; 10 an hour per /64, any number of /64s) keep that one slot held back to back,
// and every honest node operator asking for their own node's checklist is refused for as long as the stranger keeps going.
// Safe: a check another caller started does not refuse an honest caller's check (it is queued or served, never 429 "a node check is running").
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

test('#1489-r21-faucet-3 a stranger\'s running node checks do not refuse an honest operator\'s node check', { timeout: 60000 }, async () => {
  // the faucet's own (honest) seat: each read takes 1.5 s, as a live check over every seat takes ~30 s
  const seat = createServer((req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.startsWith('/network-games') ? '{"seats":[]}' : '{}'); }, 1500); }).listen(0, '127.0.0.1');
  await once(seat, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r21-faucet-3-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_BOUNTY_ORIGINS: 'https://bounty.test',
    FAUCET_SEASON_SEATS: `http://127.0.0.1:${seat.address().port}`, FAUCET_FEEDBACK_EXCLUDED: join(dir, 'none') } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    await new Promise((ok) => setTimeout(ok, 2000));   // the start-up season read is done
    const ask = (node, ip) => fetch(`http://127.0.0.1:${port}/feedback/node-check?node=${node}`, { headers: { origin: 'https://bounty.test', 'x-forwarded-for': ip } })
      .then(async (r) => ({ status: r.status, j: await r.json() }));
    // the stranger: a random node key from one /64 of its /48, the next /64 as soon as the last check ends
    const stranger = (async () => { const out = []; for (let i = 1; i <= 4; i++) out.push(await ask(String(i).repeat(64).slice(0, 64), `2001:db8:77:${i}::1`)); return out; })();
    await new Promise((ok) => setTimeout(ok, 300));
    // the honest operator asks a few times for its own node, from its own address, while the stranger goes on
    const honest = [];
    for (let i = 0; i < 4; i++) { honest.push(await ask('ab'.repeat(32), '198.51.100.20')); if (honest.at(-1).status !== 429) break; await new Promise((ok) => setTimeout(ok, 1500)); }
    const s = await stranger;
    const refused = honest.filter((x) => x.status === 429).length;
    console.log('  MEASURED:', JSON.stringify({ strangerChecks: s.map((x) => x.status), honestAsks: honest.map((x) => `${x.status} ${x.j.why || ''}`.trim()), honestRefused: refused }));
    assert.equal(refused, 0, `${refused} of ${honest.length} honest node checks refused 429 while a stranger's checks held the one slot`);
  } finally { child.kill(); seat.close(); }
});
