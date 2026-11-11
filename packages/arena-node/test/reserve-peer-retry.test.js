// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RESERVE PEER CHECK DOES NOT ASK A ROW THAT WAS NOT KEPT AGAIN EVERY PASS (kanban #1079): a seat holding a reserve key
// checked up to 200 peer reserve rows every 2 min, one status read each; on the second test host's seat 2, 127,619 of 127,844
// such lines were "not kept ... status timed out", the same rows every pass. Now a row not kept waits 4 min, then twice as
// long after each further miss, at most 1 h; and a pass still running lets the next one go.
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
const row = (n) => ({ outpoint: `${toHex(new Uint8Array(32).fill(n))}:0`, roundId: 'aa'.repeat(32), entryId: toHex(new Uint8Array(32).fill(n)), amountMsat: '2000', image: null });
const MIN = 60000;

test('a reserve row that timed out is asked again after 4, 8, 16 ... min (at most 60), not every pass; one pass at a time', async () => {
  process.env.ARENA_RESERVE_DKG = '0';
  const rows = [row(1), row(2), row(3)];
  const peer = createServer((req, res) => res.end(JSON.stringify({ federations: [{ federationId: FED, paidIn: rows }] })));
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve });
  try {
    let asked = 0, slowMs = 0;
    const port = {
      async status() { asked++; if (slowMs) await new Promise((r) => setTimeout(r, slowMs)); throw new Error('arena-stake-lock status timed out after 20000 ms'); },
      async contractId() { return 'x'; },
    };
    const guardians = { [FED]: { members: [], peers: [`http://127.0.0.1:${peer.address().port}`] } };
    let t = 0;
    const pass = async () => { const before = asked; await node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf: async () => port, now: () => t }); return asked - before; };

    const seen = [];
    // passes every 2 min, as RESERVE_DKG_MS runs them
    for (t = 0; t <= 36 * MIN; t += 2 * MIN) seen.push([t / MIN, await pass()]);
    const askedAt = seen.filter(([, n]) => n).map(([m, n]) => { assert.equal(n, 3, `all three rows at ${m} min`); return m; });
    // misses at 0, then 4 min later (4), 8 later (12), 16 later (28); 28 + 32 > 36
    assert.deepEqual(askedAt, [0, 4, 12, 28], `asked at minutes ${askedAt} (passes ${seen.length})`);

    // the wait stops growing at 1 h
    for (t = 60 * MIN; t <= 600 * MIN; t += 2 * MIN) seen.push([t / MIN, await pass()]);
    const late = seen.filter(([m, n]) => n && m >= 60).map(([m]) => m);
    const gaps = late.slice(1).map((m, i) => m - late[i]);
    assert.ok(gaps.length >= 3 && gaps.slice(-3).every((g) => g === 60), `gaps settle at 60 min: ${gaps}`);

    // a pass still running when the next is due: the next is let go, not run beside it
    t = 10000 * MIN; slowMs = 300;
    const [a, b] = await Promise.all([node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf: async () => port, now: () => t }),
      (async () => { await new Promise((r) => setTimeout(r, 50)); return node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf: async () => port, now: () => t }); })()]);
    assert.equal(b && b.skipped, true, 'the second pass was let go');
    assert.equal(a.checks, 3);
    assert.equal(asked, 3 * (askedAt.length + late.length) + 3, 'only the first pass asked');
  } finally { await node.close(); peer.close(); delete process.env.ARENA_RESERVE_DKG; }
});

// kanban #1122: an installer node read every seat's GET /reserves?all=1 (~200 kB) once per federation it held a key of - 67 a minute
test('a pass reads each seat\'s reserve list once, for every federation in it', async () => {
  process.env.ARENA_RESERVE_DKG = '0';
  const FED2 = toHex(new Uint8Array(32).fill(0x44));
  let reads = 0;
  const peer = createServer((req, res) => { reads++; res.end(JSON.stringify({ federations: [{ federationId: FED, paidIn: [row(1)] }, { federationId: FED2, paidIn: [row(2)] }] })); });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const node = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, poolCurve: curve });
  try {
    const asked = [];
    const port = { async status() { throw new Error('status timed out'); }, async contractId() { return 'x'; } };
    const u = `http://127.0.0.1:${peer.address().port}`;
    const guardians = { [FED]: { members: [], peers: [u] }, [FED2]: { members: [], peers: [u] } };
    const portOf = async (f) => { asked.push(f); return port; };
    const r = await node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf, now: () => 0 });
    assert.equal(reads, 1, 'one read of the seat for both federations');
    assert.equal(r.checks, 2, 'each federation\'s row checked');
    assert.deepEqual(asked.sort(), [FED, FED2].sort());
    await node.reserves.peerRound({ guardians, keyFor: async () => KEY, portOf, now: () => 10 * MIN });
    assert.equal(reads, 2, 'the next pass reads it again');
  } finally { await node.close(); peer.close(); delete process.env.ARENA_RESERVE_DKG; }
});
