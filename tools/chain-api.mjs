#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OUR OWN TESTNET4 BLOCK API FOR INSTALLER NODES (kanban #656, 2026-10-25: "also do our own API for the testnet installer"): an
// installer node in Electrum mode reads headers and its addresses from an Electrum server and whole blocks from an Esplora API
// (arena-installer/src/chain-bridge.js); on 2026-10-25 mempool.space answered neither for hours. This serves the Esplora routes the
// bridge reads, from a testnet4 bitcoind on the public chain - read only, nothing about any node stored:
//     GET /block/<hash>/status   { in_best_chain, height, next_best }
//     GET /block/<hash>/raw      the block's bytes
//     GET /blocks/tip/height     the tip's height
// The Electrum side is Fulcrum on the same node. The bridge checks every block against its header itself, so it trusts neither.
//
//     node tools/chain-api.mjs <port> <bitcoind rpc url> <cookie file>
import http from 'node:http';
import { readFileSync } from 'node:fs';

const [port, rpcUrl, cookieFile] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const rpc = async (method, params = []) => {
  const auth = Buffer.from(readFileSync(cookieFile, 'utf8').trim()).toString('base64');
  const r = await fetch(rpcUrl, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
  return j.result;
};
const HASH = /^[0-9a-f]{64}$/;

export function createChainApi({ call = rpc } = {}) {
  return http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(body); };
    const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
    if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'GET only' }));
    try {
      if (parts.length === 3 && parts[0] === 'blocks' && parts[1] === 'tip' && parts[2] === 'height') return send(200, String(await call('getblockcount')), 'text/plain');
      if (parts.length === 3 && parts[0] === 'block' && HASH.test(parts[1])) {
        if (parts[2] === 'status') {
          let h = null; try { h = await call('getblockheader', [parts[1], true]); } catch { h = null; }
          return send(200, JSON.stringify(h && h.confirmations > 0 ? { in_best_chain: true, height: h.height, next_best: h.nextblockhash || null } : { in_best_chain: false }));
        }
        if (parts[2] === 'raw') {
          let hex; try { hex = await call('getblock', [parts[1], 0]); } catch (e) { return send(404, JSON.stringify({ error: 'no such block' })); }
          return send(200, Buffer.from(hex, 'hex'), 'application/octet-stream');
        }
      }
      return send(404, JSON.stringify({ error: 'not a route here' }));
    } catch (e) { return send(502, JSON.stringify({ error: `bitcoind: ${e.message}` })); }
  });
}

if (process.argv[1] && process.argv[1].endsWith('chain-api.mjs') && port) {
  createChainApi().listen(port, '127.0.0.1', () => console.log(`[chain-api] testnet4 blocks on 127.0.0.1:${port} from ${rpcUrl}`));
}
