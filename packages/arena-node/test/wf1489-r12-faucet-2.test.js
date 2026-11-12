// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12-faucet-2: the faucet's node bounty checklist (GET /feedback/node-check, public with the bounty page's Origin header, which any
// client sets; and the admin's approve) asks every seat that FAUCET_SEASON_SEATS' GET /network-games lists - census seats of any operator - for
// /owner, /roles and /served, through fetchJson1342: `r.json()` with no byte cap. ONE listed seat answers its /owner with a body as large as it
// likes, and the faucet process (players' welcomes, the mainnet bounty payer) buffers and parses all of it - #1563 capped the LNURL reads, not these.
// Safe behaviour: a seat's answer is read to a bound (as readJsonBounded does for LNURL answers) and the rest is never taken.
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
const BIG = 40 * 1024 * 1024;

test('#1489 r12-faucet-2: one listed seat\'s 40 MB /owner answer is not read whole by the faucet node check', async () => {
  // the listed seat: /owner is 40 MB of JSON, written chunk by chunk as the reader takes it
  const big = { finished: false, closedEarly: false, written: 0 };
  const seatB = createServer((req, res) => {
    if (!req.url.startsWith('/owner')) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    res.write('{"node":"');
    const pump = () => { while (big.written < BIG) { big.written += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end('"}'); };
    res.on('finish', () => { big.finished = true; }); res.on('close', () => { if (!big.finished) big.closedEarly = true; });
    pump();
  }).listen(0, '127.0.0.1');
  await once(seatB, 'listening');
  const seatA = createServer((req, res) => {
    if (req.url.startsWith('/network-games')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ seats: [{ seat: `http://127.0.0.1:${seatB.address().port}` }] })); }
    res.writeHead(404); res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(seatA, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r12-faucet-2-'));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: '/bin/false', FAUCET_BOUNTY_ORIGINS: 'https://bounty.test',
    FAUCET_SEASON_SEATS: `http://127.0.0.1:${seatA.address().port}`, FAUCET_FEEDBACK_EXCLUDED: join(dir, 'none') } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    // a stranger: any node key, the bounty page's Origin header written by hand
    const r = await fetch(`http://127.0.0.1:${port}/feedback/node-check?node=${'ab'.repeat(32)}`, { headers: { origin: 'https://bounty.test', 'x-forwarded-for': '198.51.100.9' } });
    const j = await r.json();
    const facts = { status: r.status, ok: j.ok, ownerBodyMB: Math.round(BIG / 1048576), writtenMB: Math.round(big.written / 1048576), readWhole: big.finished, cutEarly: big.closedEarly };
    console.log('  FACTS r12-faucet-2:', JSON.stringify(facts));
    assert.equal(big.finished, false, `the faucet read the listed seat's whole ${facts.ownerBodyMB} MB /owner answer (no byte cap on fetchJson1342)`);
  } finally { child.kill(); seatA.close(); seatB.close(); }
});
