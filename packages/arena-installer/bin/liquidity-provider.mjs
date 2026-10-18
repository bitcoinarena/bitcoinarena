#!/usr/bin/env node
// THE LIQUIDITY PROVIDER SERVICE (liquidity-provider.js, spec §23A.10, kanban #494): every minute its claim, the others' claims and
// the nodes' gateway claims, the assignment, and its channels. Its claim is served at --listen (GET /liquidity-claim) and written to
// --claim-file (a seat serves that file as GET /liquidity-claim, ARENA_LIQUIDITY_CLAIM_FILE).
//
//     liquidity-provider --rest https://127.0.0.1:8182 --lnddir <lnd dir> --key <node key hex file> --state <file> [--listen 18860]
//                        [--claim-file <file>] [--peers https://a,https://b] [--seats https://testnet.bitcoin-arena.io/daily.json]
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lndChannels, lndFunds, lndConnect, lndOpenTo, testLnd } from '../src/lnd.js';
import { createLiquidityProvider } from '../src/liquidity-provider.js';
const a = process.argv.slice(2); const opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const lnddir = opt('--lnddir'), net = opt('--network', 'testnet4');
const cfg = { restUrl: opt('--rest'), tlsCert: join(lnddir, 'tls.cert'), macaroon: join(lnddir, `data/chain/bitcoin/${net}/admin.macaroon`) };
const secret = Uint8Array.from(Buffer.from(readFileSync(opt('--key'), 'utf8').trim(), 'hex'));
const node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const stateFile = opt('--state'); const claimFile = opt('--claim-file');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const peers = String(opt('--peers', '')).split(',').filter(Boolean);
const seatsUrl = opt('--seats', 'https://testnet.bitcoin-arena.io/daily.json');
let seats = [], seatsAt = 0, current = null;
const endpoints = async () => {
  if (Date.now() - seatsAt > 3600000) {
    try { const d = await (await fetch(seatsUrl, { signal: AbortSignal.timeout(15000) })).json(); seats = [...new Set(JSON.stringify(d).match(/https:\/\/[a-z0-9.-]+\/[a-z0-9-]+(?=")/g) || [])].filter((u) => /tn4\.bitcoin-arena\.io/.test(u)); seatsAt = Date.now(); } catch { /* keep the last */ }
  }
  return [...peers, ...seats];
};
const log = (l) => console.log(`${new Date().toISOString()} ${l}`);
const p = createLiquidityProvider({ node, sign: (h) => schnorr.sign(h, secret), verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
  lnd: { channels: () => lndChannels(cfg), funds: () => lndFunds(cfg), info: () => testLnd(cfg), connect: (o) => lndConnect(cfg, o), openTo: (o) => lndOpenTo(cfg, o) },
  endpoints, network: net, state, log,
  writeClaim: async (c) => { current = c; if (claimFile) writeFileSync(claimFile, JSON.stringify(c, null, 2) + '\n'); } });
const port = Number(opt('--listen', 0));
if (port) http.createServer((q, s) => { const ok = q.url === '/liquidity-claim' && current; s.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' }); s.end(JSON.stringify(ok ? current : { ok: false })); }).listen(port, '127.0.0.1');
let last = '';
const run = async () => { let r; try { r = await p.tick(); } catch (e) { r = { why: e.message }; } writeFileSync(stateFile, JSON.stringify(state) + '\n'); if (r.why !== last) { log(r.why); last = r.why; } };
log(`liquidity provider ${node.slice(0, 16)}… on ${net}`);
await run();
setInterval(run, 60000);
