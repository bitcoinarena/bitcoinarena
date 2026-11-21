// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm2-faucet-1 (state audit round 2, SM-19 faucet book, the installer's POST /faucet after #1572): pay() books the address
// `pending` before sendtoaddress and keeps the row on any failure it cannot classify. A busy bitcoind answers HTTP 503 "Work queue depth exceeded"
// (plain text, not JSON) to sendtoaddress - the send was never queued - and the same to the listtransactions check right after: walletSentTo says
// null, the row stays `pending` with txid null. Nothing ever reads such a row again (no sweep, no start scan), so once bitcoind is healthy and the
// faucet restarted, the wallet holds no send to the address and the book still says "this address got coins from the faucet already": the installer
// is refused for good, and the row counts toward the address's and the day's caps.
// Invariant: a pending installer row whose send the wallet does not hold is freed (or completed) once the wallet can say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

test('#1489 sm2-faucet-1 (kanban #2533): a send bitcoind never took (503) does not book the installer address for good', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-1-'));
  writeFileSync(join(dir, 'cookie'), 'user:pass');
  let busy = true; const sends = [];
  const rpc = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const j = JSON.parse(raw);
    const answer = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: j.id })); };
    if (j.method === 'getbalances') return answer({ mine: { trusted: 1 } });
    // bitcoind's own answer when its RPC work queue is full: HTTP 503, a plain-text body, nothing done
    if (busy && (j.method === 'sendtoaddress' || j.method === 'listtransactions')) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('Work queue depth exceeded'); }
    if (j.method === 'sendtoaddress') { sends.push(j.params.address); return answer('ab'.repeat(32)); }
    if (j.method === 'listtransactions') return answer(sends.map((a) => ({ category: 'send', address: a, txid: 'ab'.repeat(32) })));
    return answer(null);
  }); });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: `http://127.0.0.1:${rpc.address().port}/wallet/faucet`, FAUCET_COOKIE: join(dir, 'cookie') };
  const start = async () => { const c = spawn(process.execPath, [FAUCET], { env, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } } return c; };
  const stop = (c) => new Promise((ok) => { c.once('exit', ok); c.kill('SIGKILL'); });
  const ask = async () => { const r = await fetch(`http://127.0.0.1:${port}/faucet`, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7' },
    body: JSON.stringify({ address: ADDRESS, sats: 1500000 }) }); return { status: r.status, ...(await r.json()) }; };
  let child = await start();
  try {
    const first = await ask();
    const bookAfterFirst = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8'));
    // bitcoind is healthy again; the faucet is restarted (a deploy, a reboot) - every chance to look again
    busy = false;
    await stop(child); child = await start();
    const again = await ask();
    let book = {}; try { book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { book = {}; }
    console.log('  MEASURED #1489 sm2-faucet-1:', JSON.stringify({ first: [first.status, first.ok, first.why], bookAfterFirst: bookAfterFirst.paid,
      again: [again.status, again.ok, again.why || again.txid], walletSends: sends.length, bookNow: book.paid }));
    assert.equal(sends.length, 1, `the wallet sent ${sends.length} times; the address was never paid, yet the book keeps it as given: ${JSON.stringify(book.paid)}`);
    assert.equal(again.ok, true, `the installer is refused for an address nothing was sent to: ${again.why}`);
  } finally { child.kill('SIGKILL'); rpc.close(); }
});

// kanban #2533: the start scan - a pending row older than the grace whose send the wallet holds gets its txid; one the wallet does not hold is removed
test('#1489 sm2-faucet-1 (kanban #2533): the start scan settles or frees old pending installer rows', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-faucet-1b-'));
  writeFileSync(join(dir, 'cookie'), 'user:pass');
  const SENT = 'tb1qsentsentsentsentsentsentsentsentsent0', NOT = 'tb1qnotnotnotnotnotnotnotnotnotnotnotnot0', FRESH = 'tb1qfreshfreshfreshfreshfreshfreshfresh0';
  const old = Date.now() - 10 * 60000;
  writeFileSync(join(dir, 'book.json'), JSON.stringify({ paid: [
    { address: SENT, ip: '198.51.100.8', sats: 1500000, atMs: old, txid: null, pending: true },
    { address: NOT, ip: '198.51.100.9', sats: 1500000, atMs: old, txid: null, pending: true },
    { address: FRESH, ip: '198.51.100.10', sats: 1500000, atMs: Date.now(), txid: null, pending: true }] }));
  const rpc = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const j = JSON.parse(raw);
    const answer = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: j.id })); };
    if (j.method === 'listtransactions') return answer([{ category: 'send', address: SENT, txid: 'cd'.repeat(32), time: Math.floor(old / 1000) }]);
    if (j.method === 'getbalances') return answer({ mine: { trusted: 1 } });
    return answer(null);
  }); });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: `http://127.0.0.1:${rpc.address().port}/wallet/faucet`, FAUCET_COOKIE: join(dir, 'cookie') };
  const child = spawn(process.execPath, [FAUCET], { env, stdio: 'ignore' });
  try {
    let book = null;
    for (let i = 0; i < 100; i++) { await new Promise((ok) => setTimeout(ok, 100));
      try { book = JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')); } catch { continue; }
      if (!book.paid.some((p) => p.address === SENT && p.pending)) break; }
    console.log('  MEASURED #2533 start scan:', JSON.stringify(book.paid));
    const sent = book.paid.find((p) => p.address === SENT);
    assert.equal(sent && sent.txid, 'cd'.repeat(32)); assert.equal(sent.pending, undefined);
    assert.equal(book.paid.some((p) => p.address === NOT), false, 'a pending row the wallet holds no send for is freed');
    assert.equal(book.paid.find((p) => p.address === FRESH).pending, true, 'a row inside the grace is not judged yet');
    assert.match(readFileSync(join(dir, 'pending.txt'), 'utf8'), new RegExp('cd'.repeat(32)));
  } finally { child.kill('SIGKILL'); rpc.close(); }
});
