// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-4 (state machine audit, SM-19 faucet book, one JSON file several writers): pay() (POST /faucet) reads the book, awaits
// bitcoind (getbalances, sendtoaddress), and saves the copy it read. POST /refill runs outside the queue and books its top-up in the same file
// meanwhile; pay()'s save drops that row. The refill was paid, the day's count no longer has it, so the 1,000,000 sat day cap of the test
// opponent's top-ups is passed (the same stale save also undoes the payment sweep's decisions and the refill timer's removals).
// The real tools/faucet.mjs, a fake bitcoind wallet RPC (a slow sendtoaddress) and a fake lncli that pays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ef'.repeat(32);

test('#1489 sm1-faucet-4: a refill booked while an installer payment runs stays in the book', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-faucet-4-'));
  writeFileSync(join(dir, 'cookie'), 'user:pass');
  writeFileSync(join(dir, 'token'), 'refill-token');
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '20000', payment_hash: '${HASH}', destination: 'dest' })); process.exit(0); }
if (a.includes('payinvoice')) { console.log('Payment status: SUCCEEDED'); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const rpc = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const j = JSON.parse(raw);
    const answer = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: j.id })); };
    if (j.method === 'getbalances') return answer({ mine: { trusted: 1 } });
    if (j.method === 'sendtoaddress') return setTimeout(() => answer('a1'.repeat(32)), 2500);
    return answer(null);
  }); });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: `http://127.0.0.1:${rpc.address().port}/wallet/faucet`, FAUCET_COOKIE: join(dir, 'cookie'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`,
    FAUCET_REFILL_TOKEN_FILE: join(dir, 'token'), FAUCET_SWEEP_MS: '3600000' }, stdio: 'ignore' });
  const book = () => { try { return JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { return {}; } };
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    // an installer asks: pay() has read the book and waits for sendtoaddress
    const installer = fetch(`http://127.0.0.1:${port}/faucet`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify({ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', sats: 100000 }) }).then((r) => r.json());
    await new Promise((ok) => setTimeout(ok, 600));
    // the test opponent's top-up meanwhile: paid and booked
    const refill = await (await fetch(`http://127.0.0.1:${port}/refill`, { method: 'POST', body: JSON.stringify({ token: 'refill-token', invoice: `lntb200u1p${'q'.repeat(40)}` }) })).json();
    const during = (book().refills || []).length;
    const paid = await installer;
    const after = book();
    console.log('  MEASURED #1489 sm1-faucet-4:', JSON.stringify({ refill, during, installer: [paid.ok, paid.why || paid.txid], refillsAfter: (after.refills || []).length, paidAfter: (after.paid || []).length }));
    assert.equal(refill.ok, true);
    assert.equal(during, 1);
    assert.equal(paid.ok, true);
    assert.equal((after.refills || []).length, 1, 'the paid refill is gone from the book: pay() saved the copy it read before its awaits');
  } finally { child.kill(); rpc.close(); }
});
