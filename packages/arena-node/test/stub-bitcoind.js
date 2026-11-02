// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The bitcoind an arbiter run in a test reads: the arbitration service's tests share it.
import { createServer } from 'node:http';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';

/** A bitcoind that answers what the service asks, off the fixture's own chain; its tip is the census height, so a LOOKBACK of 20 stays on that chain. */
export async function stubBitcoind(seen, tip, committeeSec) {
  // THE SAME BLOCKS, EACH WITH THE COINBASE A REAL ONE HAS: the fixture's are bare, and a block read off a bitcoind is refused without one
  const coinbase = fromHex(`01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0151ffffffff0100000000000000000151${'00'.repeat(4)}`);
  const view = chainOf(seen.blocks.map((b) => ({ transactions: [coinbase, ...b.transactions] })), seen.firstHeight, { timeOf: (at) => committeeSec + Math.max(0, at - 10) });
  const compact = (n) => (n < 0xfd ? [n] : [0xfd, n & 255, n >> 8]);
  const hashAt = (h) => h.toString(16).padStart(64, '0');
  const outputs = new Map();
  for (const b of view.blocks) for (const raw of b.transactions) { const t = parseTransaction(raw); outputs.set(toHex([...t.txid].reverse()), t); }
  const sent = [];
  const answers = {
    getblockcount: () => tip,
    getbestblockhash: () => hashAt(tip),
    getblockhash: ([h]) => hashAt(h),
    getblock: ([hash]) => { const b = view.blocks[parseInt(hash, 16) - view.firstHeight]; return toHex(Uint8Array.from([...b.header, ...compact(b.transactions.length), ...b.transactions.flatMap((t) => [...t])])); },
    gettxout: ([txid, vout]) => { const o = outputs.has(txid) ? outputs.get(txid).outputs[vout] : null; if (!o) return null; return { value: Number(o.value) / 1e8, scriptPubKey: { hex: toHex(o.script) } }; },
    testmempoolaccept: () => [{ allowed: true }],
    sendrawtransaction: ([hex]) => { sent.push(hex); return 'cd'.repeat(32); },
  };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { const { method, params, id } = JSON.parse(body); res.end(JSON.stringify({ id, result: answers[method](params), error: null })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)) };
}
