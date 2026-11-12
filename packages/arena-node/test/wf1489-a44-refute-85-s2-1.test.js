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

test('#1489 a44-refute-85-s2-1: a stranger\'s unpayable invoice named by a note\'s hash puts that handed-out note back on the shelf at the next start', async () => {
  const s = setup();
  let f = await start(s);
  const a = await f.ask('198.51.100.1', { kind: 'welcome', account: 'aa'.repeat(32), ecash: FED });
  assert.equal(a.ecash, 'noteA', JSON.stringify(a));
  // the stranger (another account, another address) asks an invoice welcome whose payment_hash is sha256('noteA')
  writeFileSync(join(s.dir, 'hash'), sha('noteA'));
  const b = await f.ask('203.0.113.7', { kind: 'welcome', account: 'bb'.repeat(32), invoice: `lntb30u1p${'q'.repeat(40)}` });
  const book = JSON.parse(readFileSync(join(s.dir, 'book.json'), 'utf8'));
  await f.stop();
  f = await start(s);   // the faucet restarts (a deploy, a reboot)
  const takenAfter = readdirSync(join(s.pool, FED, 'taken'));
  const c = await f.ask('192.0.2.44', { kind: 'welcome', account: 'cc'.repeat(32), ecash: FED });
  await f.stop();
  const facts = { stranger: b, rowsAfterStranger: (book.players || []).map((r) => ({ account: r.account.slice(0, 4), ecash: !!r.ecash })), takenAfterRestart: takenAfter, thirdPlayerGot: c.ecash || c.why || null };
  console.log('  FACTS a44-refute-85-s2-1:', JSON.stringify(facts));
  assert.ok((book.players || []).some((r) => r.account === 'aa'.repeat(32) && r.ecash), 'the first player\'s e-cash row was deleted by a stranger\'s invoice');
  assert.ok(takenAfter.includes('3000000-1-n.json'), 'the handed-out note went back on the shelf at start');
  assert.notEqual(c.ecash, 'noteA', 'the note the first player was given was handed out again');
});

