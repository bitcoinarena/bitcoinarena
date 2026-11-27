// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3893 (2026-11-27): with LND A (the first payer) down, the faucet's decodepayreq failed and every bot refill was answered "that invoice
// cannot be read" though LND B was up. The real tools/faucet.mjs against a fake lncli whose first payer refuses every call: B reads and pays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'cd'.repeat(32);

test('#3893 a refill is read and paid by LND B while LND A is down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet3893-'));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), rpc = (a.find((x) => x.startsWith('--rpcserver=')) || '').slice(12);
require('fs').appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, rpc + ' ' + a.filter((x) => !x.startsWith('--')).slice(0, 1).join('') + '\\n');
if (rpc === '127.0.0.1:1') { console.error('[lncli] rpc error: connection refused'); process.exit(1); }
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', num_msat: '3000000', payment_hash: '${HASH}', destination: 'x' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'k-' + rpc })); process.exit(0); }
if (a.includes('payinvoice')) { console.log('Payment status: SUCCEEDED'); process.exit(0); }
if (a.includes('listpayments')) { console.log(JSON.stringify({ payments: [] })); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  writeFileSync(join(dir, 'token'), 'tok-3893');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_REFILL_TOKEN_FILE: join(dir, 'token'),
    FAUCET_PAYERS: `${dir}|127.0.0.1:1,${dir}|127.0.0.1:2`, FAUCET_SWEEP_MS: '600000' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const r = await (await fetch(`http://127.0.0.1:${port}/refill`, { method: 'POST', body: JSON.stringify({ token: 'tok-3893', invoice: `lntb30u1p${'q'.repeat(40)}` }) })).json();
    assert.deepEqual(r, { ok: true, sats: 3000 });
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8');
    assert.match(calls, /127\.0\.0\.1:1 decodepayreq\n127\.0\.0\.1:2 decodepayreq/);
    assert.match(calls, /127\.0\.0\.1:2 payinvoice/);
  } finally { child.kill(); }
});
