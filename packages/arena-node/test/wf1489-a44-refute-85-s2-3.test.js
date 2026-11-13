// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a44 refute #1835 skeptic 2: a stranger (any player) deletes another player's e-cash book row by asking an invoice welcome whose
// payment_hash is that row's hash (sha256 of the note's ecash - the note's holder knows it; addholdinvoice or a hand-signed invoice names any hash).
// The invoice cannot be paid, grantPay drops every players row with that hash - the e-cash row too - and the start scan, which keeps a taken/ note
// only for a booked row, puts the handed-out note back on the shelf at the next restart: the next player gets the same note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const FED = '44'.repeat(32);
const sha = (s) => createHash('sha256').update(s).digest('hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-85-s2-')), pool = join(dir, 'pool');
  mkdirSync(join(pool, FED), { recursive: true });
  for (const [i, e] of [[1, 'noteA'], [2, 'noteB'], [3, 'noteC']]) writeFileSync(join(pool, FED, `3000000-${i}-n.json`), JSON.stringify({ msat: '3000000', ecash: e, federation: FED }));
  const fake = join(dir, 'lncli');
  // decodepayreq names the hash the stranger chose (written to dir/hash); payinvoice fails at once (no route)
  writeFileSync(fake, `#!${process.execPath}
const a = process.argv.slice(2), fs = require('fs');
if (a.includes('decodepayreq')) { console.log(JSON.stringify({ num_satoshis: '3000', payment_hash: fs.readFileSync(${JSON.stringify(join(dir, 'hash'))}, 'utf8').trim(), destination: 'nowhere' })); process.exit(0); }
if (a.includes('getinfo')) { console.log(JSON.stringify({ identity_pubkey: 'payer' })); process.exit(0); }
if (a.includes('payinvoice')) { console.error('[lncli] rpc error: unable to find a path to destination'); process.exit(1); }
console.log('{}');
`);
  chmodSync(fake, 0o755);
  return { dir, pool, fake };
}
async function start({ dir, pool, fake }) {
  const port = 20000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [FAUCET], { stdio: 'ignore', env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_LNCLI: fake, FAUCET_PAYERS: `${dir}|127.0.0.1:1`, FAUCET_ECASH_POOL: pool,
    FAUCET_PAY_WAIT_MS: '800', FAUCET_PAY_SETTLE_MS: '600', FAUCET_PAY_POLL_MS: '200' } });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
  const ask = async (ip, body) => (await fetch(`http://127.0.0.1:${port}/player`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) })).json();
  const stop = () => new Promise((ok) => { child.once('exit', ok); child.kill(); });
  return { ask, stop };
}

test('#1489 a44-refute-85-s2-3: the player whose row a stranger deleted asks the welcome again and is handed a second note', async () => {
  const s = setup();
  const f = await start(s);
  const a = await f.ask('198.51.100.1', { kind: 'welcome', account: 'aa'.repeat(32), ecash: FED });
  assert.equal(a.ecash, 'noteA', JSON.stringify(a));
  writeFileSync(join(s.dir, 'hash'), sha('noteA'));
  await f.ask('203.0.113.7', { kind: 'welcome', account: 'bb'.repeat(32), invoice: `lntb30u1p${'q'.repeat(40)}` });
  const again = await f.ask('198.51.100.99', { kind: 'welcome', account: 'aa'.repeat(32), ecash: FED });   // another address: not the #1419 re-answer
  await f.stop();
  console.log('  FACTS a44-refute-85-s2-3:', JSON.stringify({ again }));
  assert.ok(!again.ecash || again.ecash === 'noteA', `the same account was handed a second note: ${again.ecash}`);
});
