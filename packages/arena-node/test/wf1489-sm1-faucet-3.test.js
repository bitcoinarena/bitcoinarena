// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-3 (state machine audit, SM-19 faucet book, the installer's POST /faucet): pay() sends first and writes the book after
// (the players' grant writes before paying, "a crash pays nobody twice" - this door does not). bitcoind's sendtoaddress answering later than the
// faucet's 30 s RPC timeout (a big wallet, a busy node) has sent the coins, but pay() throws, nothing is booked, and the installer's retry - the
// same address - passes "this address got coins from the faucet already" and is paid a second time (up to 1,500,000 sat each).
// The real tools/faucet.mjs against a fake bitcoind wallet RPC that records every sendtoaddress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');

test('#1489 sm1-faucet-3: a send that answered after the RPC timeout is not paid again to the same address', { timeout: 110000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-faucet-3-'));
  writeFileSync(join(dir, 'cookie'), 'user:pass');
  const sends = [];
  const rpc = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const j = JSON.parse(raw);
    const answer = (result) => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: j.id })); } };
    if (j.method === 'getbalances') return answer({ mine: { trusted: 1 } });
    if (j.method === 'sendtoaddress') {
      // bitcoind sends at once (the wallet commits the transaction); the FIRST answer comes back after 32 s
      sends.push(j.params.address);
      const txid = String(sends.length).repeat(64).slice(0, 64);
      return sends.length === 1 ? setTimeout(() => answer(txid), 32000) : answer(txid);
    }
    return answer(null);
  }); });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: `http://127.0.0.1:${rpc.address().port}/wallet/faucet`, FAUCET_COOKIE: join(dir, 'cookie') }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const ask = async () => { const r = await fetch(`http://127.0.0.1:${port}/faucet`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', sats: 1500000 }) }); return { status: r.status, ...(await r.json()) }; };
    const first = await ask();
    const again = await ask();
    let book = {}; try { book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { book = {}; }
    console.log('  MEASURED #1489 sm1-faucet-3:', JSON.stringify({ first: [first.status, first.ok, first.why], again: [again.status, again.ok, again.why || again.txid], sends: sends.length, booked: (book.paid || []).length }));
    assert.equal(sends.length, 1, `the faucet sent ${sends.length} times to one address: its first send was never booked`);
  } finally { child.kill(); rpc.close(); }
});
