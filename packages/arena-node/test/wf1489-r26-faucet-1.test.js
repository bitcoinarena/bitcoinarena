// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 26 (faucet): #2589 held the bounty payout to the invoice's msat, but the players' faucet (grant(), POST /player) still reads
// lnd's num_satoshis - the msat cut down to whole sats. A stranger's welcome invoice for 3,000,999 msat decodes as num_satoshis 3000, passes
// playerGrantDecide's "exactly 3000", and payinvoice pays the whole 3,000,999 msat.
// Safe: an invoice whose msat is not exactly the grant's is never paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const HASH = 'ab'.repeat(32);

for (const door of ['player', 'refill']) test(`#1489-r26-faucet-1 #2857 an invoice 999 msat over whole sats is not paid at /${door}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r26-f1-'));
  const fake = join(dir, 'lncli');
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', num_msat: '3000999', payment_hash: '${HASH}', destination: 'elsewhere' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'payer' })); process.exit(0); }
if (a.includes('payinvoice')) { require('fs').appendFileSync(${JSON.stringify(join(dir, 'pays.log'))}, a.join(' ') + '\\n'); console.log('Payment status: SUCCEEDED'); process.exit(0); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_REFILL_TOKEN_FILE: join(dir, 'token') } });
  writeFileSync(join(dir, 'token'), 't0ken-2857');
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const out = await (await fetch(`http://127.0.0.1:${port}/${door}`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(door === 'player' ? { kind: 'welcome', account: 'cd'.repeat(32), invoice: `lntb30u1p${'q'.repeat(40)}` } : { token: 't0ken-2857', invoice: `lntb30u1p${'q'.repeat(40)}` }) })).json();
    let pays = []; try { pays = readFileSync(join(dir, 'pays.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { pays = []; }
    console.log('  MEASURED:', JSON.stringify({ door, answer: out, payinvoiceCalls: pays.length }));
    assert.deepEqual(pays, [], 'the faucet paid an invoice for 3,000,999 msat as a 3,000 sat welcome');
    assert.equal(out.ok, false);
  } finally { child.kill(); }
});
