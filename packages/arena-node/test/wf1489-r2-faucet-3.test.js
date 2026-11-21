// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2 (faucet): THE INSTALLERS' PUBLIC DOOR HOLDS THE PLAYERS' WELCOMES. GET /faucet (https://tn4.bitcoinarena.io/faucet, the
// installer's FAUCET_URL - public, no sign-in) and every POST /faucet, even one naming no address, run in the players' queue one() and ask bitcoind
// getbalances there, before anything is decided; no limit per caller, no cache. The welcome (POST /player) and the top-up run in that same queue,
// one at a time. A stranger keeping a few hundred GETs open holds every welcome behind them - the page gives up after 45 s and the faucet drops a
// request whose page stopped waiting (#1419). The admin's approve (#1419) and the bounty claims (#2023) were taken out of this queue for the same
// reason; this door was not. Safe: a burst of a stranger's GET /faucet does not hold a player's welcome answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, get as httpGet, Agent } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('#1489-r2 a burst of GET /faucet does not hold a player\'s welcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r2f3-'));
  writeFileSync(join(dir, 'cookie'), 'u:p');
  // bitcoind: getbalances in 20 ms (a wallet under load)
  const btc = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { mine: { trusted: 1 } }, error: null, id: 'faucet' })); }, 20)); });
  await new Promise((r) => btc.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'), FAUCET_COOKIE: join(dir, 'cookie'),
      FAUCET_RPC_URL: `http://127.0.0.1:${btc.address().port}/wallet/w`, FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_LNCLI: '/bin/false' } });
  const base = `http://127.0.0.1:${port}`;
  const many = new Agent({ maxSockets: 1000 });
  const getOnce = () => new Promise((ok) => { const r = httpGet(`${base}/faucet`, { agent: many }, (res) => { res.resume(); res.on('end', ok); }); r.on('error', ok); });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/player`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    // the stranger: 400 GETs at once
    const flood = Array.from({ length: 400 }, () => getOnce());
    await new Promise((r) => setTimeout(r, 300));
    // a player's welcome, asked meanwhile (no e-cash pool, no invoice: answered at once when its turn comes)
    const t0 = Date.now();
    const w = await fetch(`${base}/player`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'welcome', account: 'acct-1' }) }).then((r) => r.json());
    const waited = Date.now() - t0;
    await Promise.all(flood);
    console.log(`  MEASURED: the welcome's answer ("${w.why}") came after ${waited} ms behind 400 GET /faucet`);
    assert.ok(waited < 2000, `a player's welcome waited ${waited} ms behind a stranger's GET /faucet burst`);
  } finally { faucet.kill(); btc.close(); many.destroy(); }
});
