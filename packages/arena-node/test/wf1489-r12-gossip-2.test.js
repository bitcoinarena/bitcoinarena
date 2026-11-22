// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12 gossip-2: ONE PEER SEAT'S MADE-UP GET /reserves?all=1 ROWS USE THE WHOLE PER-PASS CHECK BUDGET. Every 2 min a seat reads each
// guardian seat's reserve list and checks each row it does not hold with its federation port (server.js reservePeerPass) - at most
// RESERVE_PEER_CHECKS (200) checks a pass, across ALL seats and federations. A row not kept waits 4 min+ before it is asked again (kanban #1079), but
// that backoff is per outpoint: one seat listed first that answers 200 fresh made-up outpoints each pass takes every check, and the rows the honest
// guardian seats list are never checked - this seat never keeps the reserve outputs its federation holds (P4 one of n blocks all, P5).
// SAFE: one peer's listing cannot keep another peer's verifying reserve row from being checked and kept.
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
const MIN = 60000;
const rowOf = (txHex) => ({ outpoint: `${txHex}:0`, roundId: 'aa'.repeat(32), entryId: txHex, amountMsat: '2000', image: null });
const REAL = rowOf(toHex(new Uint8Array(32).fill(0x77)));

test('one guardian seat listing 200 made-up reserve rows each pass does not keep an honest seat\'s real reserve row from being checked', async () => {
  process.env.ARENA_RESERVE_DKG = '0';
  let pass = 0;
  // THE ATTACKER'S SEAT M: 200 fresh made-up outpoints every pass
  const M = createServer((req, res) => res.end(JSON.stringify({ federations: [{ federationId: FED,
    paidIn: Array.from({ length: 200 }, (_, i) => rowOf(toHex(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? pass & 255 : j === 1 ? i & 255 : j === 2 ? 0xee : 1))))) }] })));
  // AN HONEST GUARDIAN SEAT H: the one real reserve output
  const H = createServer((req, res) => res.end(JSON.stringify({ federations: [{ federationId: FED, paidIn: [REAL] }] })));
  await new Promise((r) => M.listen(0, '127.0.0.1', r)); await new Promise((r) => H.listen(0, '127.0.0.1', r));
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve });
  try {
    let realAsked = 0;
    // the federation holds REAL (to the reserve key), nothing at the made-up outpoints
    const port = {
      async status(op) { const tx = toHex(op.txid); if (tx === REAL.entryId) { realAsked++; return { stored: { contractId: 'x' } }; } return { stored: null }; },
      async contractId() { return 'x'; },
    };
    const guardians = { [FED]: { members: [], peers: [`http://127.0.0.1:${M.address().port}`, `http://127.0.0.1:${H.address().port}`] } };
    let kept = 0;
    for (pass = 0; pass < 5; pass++) {
      const r = await node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf: async () => port, now: () => pass * 2 * MIN });
      kept += r.kept || 0;
    }
    console.log(`  BUDGET TAKEN: 5 passes, the honest row asked ${realAsked}x, kept ${kept}`);
    assert.ok(realAsked > 0, 'the honest seat\'s reserve row was never checked: one seat\'s made-up rows used every check of every pass');
    assert.equal(kept, 1, 'the real reserve output was kept');
  } finally { await node.close(); M.close(); H.close(); delete process.env.ARENA_RESERVE_DKG; }
});
