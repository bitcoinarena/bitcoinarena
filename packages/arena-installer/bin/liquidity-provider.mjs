#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIQUIDITY PROVIDER SERVICE (liquidity-provider.js, spec §23A.10): every minute its claim, the others' claims and
// the nodes' gateway claims, the assignment, and its channels. Its claim is served at --listen (GET /liquidity-claim) and written to
// --claim-file (a seat serves that file as GET /liquidity-claim, ARENA_LIQUIDITY_CLAIM_FILE).
//
//     liquidity-provider --rest https://127.0.0.1:8182 --lnddir <lnd dir> --key <node key hex file> --state <file> [--listen 8477]
//                        [--claim-file <file>] [--peers https://a,https://b] [--seeds https://testnet.bitcoin-arena.io/daily.json]
//
// HOW A NEW NODE IS FOUND (2026-10-18: "How do new nodes communicate with the lnd liquidity providers?"): it does not call a
// provider. It is bonded (so in the census, with its endpoint in its advertisement) and its seat serves its signed gateway claim (its
// LND key and address). A provider reads the census from any node that answers (GET /roles: every census node and its endpoint) and
// asks each endpoint for its gateway claim and its liquidity claim. FULLY DYNAMIC (2026-10-18: "The node discovery must be fully
// dynamic never in just a daily.json. For a seed node daily.json is ok"): daily.json only seeds the first nodes to ask; every node the
// census names is kept (in the state file) and asked next time, so the provider finds the network without it.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lndChannels, lndFunds, lndConnect, lndOpenTo, lndCoins, lndSignWithAddr, testLnd } from '../src/lnd.js';
import { createLiquidityProvider } from '../src/liquidity-provider.js';
const a = process.argv.slice(2); const opt = (k, d = null) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const lnddir = opt('--lnddir'), net = opt('--network', 'testnet4');
const cfg = { restUrl: opt('--rest'), tlsCert: join(lnddir, 'tls.cert'), macaroon: join(lnddir, `data/chain/bitcoin/${net}/admin.macaroon`) };
const secret = Uint8Array.from(Buffer.from(readFileSync(opt('--key'), 'utf8').trim(), 'hex'));
const node = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
const stateFile = opt('--state'); const claimFile = opt('--claim-file');
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const peers = String(opt('--peers', '')).split(',').filter(Boolean);
const seedsUrl = opt('--seeds', 'https://testnet.bitcoin-arena.io/daily.json');
const toHttp = (u) => String(u || '').replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
let seats = [], seatsAt = 0, current = null;
// one node's census: the endpoints of every census node (GET /roles), or null when it does not answer
const rolesOf = async (n) => { try { const r = await fetch(`${toHttp(n)}/roles`, { signal: AbortSignal.timeout(10000) }); if (r.status !== 200) return null;
  const d = await r.json(); const e = [...new Set((d.nodes || []).map((x) => toHttp(x.endpoint)).filter((u) => /^https?:\/\//.test(u)))]; return e.length ? e : null; } catch { return null; } };
const endpoints = async () => {
  if (Date.now() - seatsAt > 600000) {          // a new node is found within 10 minutes of its bond
    // the nodes to ask: every node learned before, then the seed list (daily.json) only if none of those answers
    const askOrder = [...(state.known || [])];
    let census = null;
    for (const n of askOrder) { census = await rolesOf(n); if (census) break; }
    if (!census) {
      let seeds = [];
      try { const d = await (await fetch(seedsUrl, { signal: AbortSignal.timeout(15000) })).json(); seeds = [...new Set(JSON.stringify(d).match(/https:\/\/[a-z0-9.-]+\/[a-z0-9-]+(?=")/g) || [])]; } catch { seeds = []; }
      for (const n of seeds) { census = await rolesOf(n); if (census) break; }
    }
    if (census) { seats = census; state.known = census; seatsAt = Date.now(); }
  }
  return [...peers, ...seats];
};
const log = (l) => console.log(`${new Date().toISOString()} ${l}`);
const p = createLiquidityProvider({ node, sign: (h) => schnorr.sign(h, secret), verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
  lnd: { channels: () => lndChannels(cfg), funds: () => lndFunds(cfg), info: () => testLnd(cfg), connect: (o) => lndConnect(cfg, o), openTo: (o) => lndOpenTo(cfg, o),
    coins: () => lndCoins(cfg), signWithAddr: (o) => lndSignWithAddr(cfg, o) },
  endpoints, network: net, state, log,
  writeClaim: async (c) => { current = c; if (claimFile) writeFileSync(claimFile, JSON.stringify(c, null, 2) + '\n'); } });
const port = Number(opt('--listen', 0));
// its local port (127.0.0.1 only): GET /liquidity-claim, and POST /new-address - the seat's owner page asks it (ARENA_LIQUIDITY_PROVIDER_URL)
if (port) http.createServer(async (q, s) => {
  const send = (code, o) => { s.writeHead(code, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
  if (q.method === 'POST' && q.url === '/new-address') { const r = await p.newAddress().catch((e) => ({ ok: false, why: e.message })); writeFileSync(stateFile, JSON.stringify(state) + '\n'); if (r.ok) log(`new top-up address ${r.address}`); return send(r.ok ? 200 : 502, r); }
  const ok = q.url === '/liquidity-claim' && current; send(ok ? 200 : 404, ok ? current : { ok: false });
}).listen(port, '127.0.0.1');
let last = '';
const run = async () => { let r; try { r = await p.tick(); } catch (e) { r = { why: e.message }; } writeFileSync(stateFile, JSON.stringify(state) + '\n'); if (r.why !== last) { log(r.why); last = r.why; } };
log(`liquidity provider ${node.slice(0, 16)}… on ${net}`);
await run();
setInterval(run, 60000);
