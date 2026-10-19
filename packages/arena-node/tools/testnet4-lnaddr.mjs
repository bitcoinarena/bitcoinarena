#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A TESTNET4 LIGHTNING ADDRESS FOR WINNINGS (LUD-16 over LUD-06), invoices from one of our own testnet4 lnds - what the
 * page's winnings prompt is answered with in the paid testnet4 run (2026-09-27 17:24: "finish one paid run that
 * settles and pays out"). `name@host` is https://host/.well-known/lnurlp/name, so this is served at the ROOT of its own
 * public host (a quick tunnel), and its invoices carry sha256 of the metadata it answers as their description hash -
 * the check a signer node's send plan makes (winnings-send.js, `sendPlanStands`).
 *
 *   LNCLI=<lncli> LND_DIR=<lnd dir> LND_RPC=<host:port> PORT=<local port> PUBLIC=<https root> node tools/testnet4-lnaddr.mjs
 *   (ARENA_TN4_NETWORK, default testnet4: the lnd's chain; the regtest harness names regtest)
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const env = process.env;
for (const k of ['LNCLI', 'LND_DIR', 'LND_RPC', 'PORT', 'PUBLIC']) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const base = env.PUBLIC.replace(/\/+$/, '');
const metadataOf = (name) => JSON.stringify([['text/plain', `BLWP testnet4 winnings for ${name}`], ['text/identifier', `${name}@${new URL(base).host}`]]);
const lncli = (...a) => new Promise((done, fail) => execFile(env.LNCLI, [`--lnddir=${env.LND_DIR}`, `--rpcserver=${env.LND_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a],
  { timeout: 30000 }, (e, out, err) => (e ? fail(new Error(String(err || e.message).trim())) : done(JSON.parse(out)))));
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

createServer(async (req, res) => {
  const url = new URL(req.url, base);
  let m = url.pathname.match(/^\/\.well-known\/lnurlp\/([a-z0-9._-]{1,64})$/i);
  if (m) {
    say({ step: 'lnurlp', name: m[1] });
    return json(res, 200, { tag: 'payRequest', callback: `${base}/lnurlp/cb/${m[1]}`, minSendable: 1000, maxSendable: 100000000000,
      metadata: metadataOf(m[1]) });
  }
  m = url.pathname.match(/^\/lnurlp\/cb\/([a-z0-9._-]{1,64})$/i);
  if (m) {
    const msat = Number(url.searchParams.get('amount'));
    if (!Number.isInteger(msat) || msat < 1000) return json(res, 200, { status: 'ERROR', reason: 'amount in msat, at least 1000' });
    try {
      const hash = createHash('sha256').update(metadataOf(m[1])).digest('hex');
      const inv = await lncli('addinvoice', '--amt_msat', String(msat), '--description_hash', hash, '--expiry', '86400');
      say({ step: 'invoice', name: m[1], msat, r_hash: inv.r_hash });
      return json(res, 200, { pr: inv.payment_request, routes: [] });
    } catch (e) { say({ step: 'invoice failed', why: e.message }); return json(res, 200, { status: 'ERROR', reason: e.message.slice(0, 200) }); }
  }
  json(res, 404, { status: 'ERROR', reason: 'not here' });
}).listen(Number(env.PORT), '127.0.0.1', () => say({ step: 'listening', port: Number(env.PORT), public: base }));
