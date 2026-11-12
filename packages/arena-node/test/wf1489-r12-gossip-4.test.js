// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12 gossip-4: PEER GET /reserves?all=1 AND GET /funding-items ANSWERS READ WITH NO BYTE CAP. The reserve peer pass (server.js
// reservePeerPass listOf), the reserve key read (reserveKeyFor) and the funding pull before a decision (fundingBook pull) take each peer answer whole
// with `r.json()` - only an 8 s timeout bounds them. One guardian / network seat streams hundreds of MB in those 8 s and the seat buffers and parses all
// of it on its event loop, every pass (2 min) - the #1685/#1744/#2368 class, on doors no earlier fix capped (P5).
// SAFE: a seat stops reading one peer's reserve list / funding items after a bound (32 MB here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const curve = { ...feldmanGroup, tweakPoint };
const FED = toHex(new Uint8Array(32).fill(0x33));
const KEY = new Uint8Array(33).fill(2);
const CAP = 32 * 1024 * 1024, SENT_MAX = 256 * 1024 * 1024;

// a peer that answers a JSON body of SENT_MAX bytes (a long string), counting what the reader took
function padded() {
  const state = { sent: 0 };
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const s = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.write(`{"federations":[{"federationId":"${FED}","paidIn":[]}],"items":[],"pad":"`);
    const more = () => {
      while (state.sent < SENT_MAX) { state.sent += chunk.length; if (!res.write(chunk)) { res.once('drain', more); return; } }
      res.end('"}');
    };
    res.on('error', () => {}); req.socket.on('error', () => {});
    more();
  });
  return { s, state };
}

test('a seat stops reading one peer\'s padded GET /reserves?all=1 answer after a bound', { timeout: 120000 }, async () => {
  process.env.ARENA_RESERVE_DKG = '0';
  const { s, state } = padded();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve });
  try {
    const port = { async status() { return { stored: null }; }, async contractId() { return 'x'; } };
    const guardians = { [FED]: { members: [], peers: [`http://127.0.0.1:${s.address().port}`] } };
    await node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf: async () => port, now: () => 0 });
    console.log(`  UNCAPPED: the seat read ${Math.round(state.sent / 1048576)} MB of one peer's /reserves?all=1 answer`);
    assert.ok(state.sent <= CAP + 8 * 1024 * 1024, `the seat read ${Math.round(state.sent / 1048576)} MB of one peer's reserve list`);
  } finally { await node.close(); s.close(); delete process.env.ARENA_RESERVE_DKG; }
});
