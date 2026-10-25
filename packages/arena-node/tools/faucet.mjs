#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA FAUCET (kanban #635): testnet4 coins for a new node's installer, from a bitcoind wallet of our own coins. The rules are
// src/faucet.js (an address once, an IP a few times a day, a daily cap). One request at a time, so two can never both pass the book.
//
//   POST /faucet { address, sats }  -> { ok, txid, sats } or { ok: false, why }
//   GET  /faucet                    -> { ok, balanceSats, maxSats, leftTodaySats }
//
// Each payment's txid is appended to FAUCET_PENDING, which the the test host's miner-C feeder (ops/pending-to-minerc.sh) lists for mining.
//   FAUCET_PORT  FAUCET_RPC_URL (with /wallet/<name>)  FAUCET_COOKIE  FAUCET_BOOK  FAUCET_PENDING  [FAUCET_FEE_RATE sat/vB, 2]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { faucetDecide, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS, DAY_MS } from '../src/faucet.js';

const env = process.env;
const port = Number(env.FAUCET_PORT || 18866);
const feeRate = Number(env.FAUCET_FEE_RATE || 2);
const rpc = async (method, params = []) => {
  const auth = Buffer.from(readFileSync(env.FAUCET_COOKIE, 'utf8').trim()).toString('base64');
  const r = await fetch(env.FAUCET_RPC_URL, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const readBook = () => { try { return JSON.parse(readFileSync(env.FAUCET_BOOK, 'utf8')); } catch { return { paid: [] }; } };
const saveBook = (b) => { writeFileSync(`${env.FAUCET_BOOK}.new`, JSON.stringify(b, null, 1)); renameSync(`${env.FAUCET_BOOK}.new`, env.FAUCET_BOOK); };
const balanceSats = async () => Math.round(Number((await rpc('getbalances')).mine.trusted) * 1e8);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;   // behind Funnel: no header = no IP limit

let queue = Promise.resolve();
const one = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

async function pay(ask) {
  const book = readBook();
  const d = faucetDecide(ask, book, { balanceSats: await balanceSats() });
  if (!d.ok) return d;
  const txid = await rpc('sendtoaddress', { address: ask.address, amount: (d.sats / 1e8).toFixed(8), replaceable: true, fee_rate: feeRate });
  book.paid.push({ address: ask.address, ip: ask.ip, sats: d.sats, atMs: Date.now(), txid });
  saveBook(book);
  appendFileSync(env.FAUCET_PENDING, `${txid}\n`);
  console.log(`${new Date().toISOString()} paid ${d.sats} sat to ${ask.address} (${ask.ip || 'no ip'}): ${txid}`);
  return { ok: true, txid, sats: d.sats };
}

createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/faucet') return send(404, { ok: false, why: 'no such door' });
  if (req.method === 'GET') {
    return one(async () => {
      const day = Math.floor(Date.now() / DAY_MS);
      const given = readBook().paid.filter((p) => Math.floor(p.atMs / DAY_MS) === day).reduce((a, p) => a + p.sats, 0);
      return { ok: true, balanceSats: await balanceSats(), maxSats: FAUCET_MAX_SATS, leftTodaySats: Math.max(0, FAUCET_DAY_CAP_SATS - given) };
    }).then((b) => send(200, b), (e) => send(500, { ok: false, why: e.message }));
  }
  if (req.method !== 'POST') return send(405, { ok: false, why: 'GET or POST' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let ask;
    try { ask = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, why: 'not JSON' }); }
    one(() => pay({ address: ask.address, sats: ask.sats, ip: ipOf(req) }))
      .then((r) => send(200, r), (e) => { console.log(`${new Date().toISOString()} failed: ${e.message}`); send(500, { ok: false, why: `the faucet could not pay: ${e.message}` }); });
  });
}).listen(port, '127.0.0.1', () => console.log(`faucet on 127.0.0.1:${port}`));
