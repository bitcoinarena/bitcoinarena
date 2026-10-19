// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYERS' ESCROW INTO THE FEDERATION (kanban #307, §5A.3B): the arbitration set spends its escrow output whole, less
// the fee, to the federation's peg-in script, signed as path B is - k of m on its own, fewer posts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrationMembers, buildEscrowPegin, memberSign, assemble, serveArbiter } from '../src/arbiter.js';
import { escrowOutput } from '../../arena-protocol/src/arbitration-tx.js';
import { tweakPoint, combine } from '../src/curve.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const set = arbitrationMembers('regtest');
const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
const PEGIN = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(7)]);        // a P2WPKH peg-in script
const OUT = { txid: new Uint8Array(32).fill(1), vout: 1, value: 150000n, script: escrow.script };

test('the escrow is spent whole less the fee to the peg-in script, k of m signing; fewer, a foreign output or dust are refused by name', () => {
  const s = buildEscrowPegin({ escrow: OUT, set, toScript: PEGIN, feeSats: 1000n });
  assert.equal(s.ok, true, s.why);
  assert.deepEqual(s.built.tx.outputs.map((o) => [o.value, toHex(o.script)]), [[149000n, toHex(PEGIN)]]);
  assert.equal(s.built.tx.inputs[0].vout, 1);
  const signed = assemble({ slash: s, signatures: set.members.slice(0, set.k).map((m) => ({ key: m.key, sig: memberSign(m, s.sighash) })), set });
  assert.equal(signed.ok, true, signed.why);
  assert.equal(signed.signers, set.k);
  const short = assemble({ slash: s, signatures: set.members.slice(0, set.k - 1).map((m) => ({ key: m.key, sig: memberSign(m, s.sighash) })), set });
  assert.match(short.why, new RegExp(`^${set.k - 1} valid arbitration signatures, and path B needs ${set.k}`));
  const foreign = buildEscrowPegin({ escrow: { ...OUT, script: PEGIN }, set, toScript: PEGIN });
  assert.equal(foreign.why, 'that output is not this arbitration set\'s escrow');
  const dust = buildEscrowPegin({ escrow: { ...OUT, value: 1200n }, set, toScript: PEGIN, feeSats: 1000n });
  assert.match(dust.why, /is 200 sat, below dust/);
});

// THE SLASH'S PAYOUTS, LISTED (kanban #307): GET /slash-payouts - every share locked to a wronged player, or one round's
test('GET /slash-payouts lists the shares the set locked, by round; a malformed round id is refused', async () => {
  const R1 = 'a1'.repeat(32), R2 = 'a2'.repeat(32);
  const list = [{ round: R1, entry: 'e0'.repeat(32), refundPk: '02' + 'bb'.repeat(32), msat: '60000000', txid: '71'.repeat(32), outIdx: 0, contractId: 'c1'.repeat(32) },
    { round: R2, entry: 'e1'.repeat(32), refundPk: '02' + 'cc'.repeat(32), msat: '40000000', txid: '72'.repeat(32), outIdx: 1, contractId: 'c2'.repeat(32) }];
  const doors = await serveArbiter({ set, allow: () => ({ ok: true }), payouts: () => list });
  try {
    const at = (q) => fetch(`http://127.0.0.1:${doors.port}/slash-payouts${q}`).then(async (r) => [r.status, await r.json()]);
    const [s1, all] = await at('');
    assert.equal(s1, 200);
    assert.deepEqual(all.payouts.map((p) => p.round), [R1, R2]);
    const [, one] = await at(`?round=${R2}`);
    assert.deepEqual(one.payouts, [list[1]]);
    const [s3, bad] = await at('?round=xyz');
    assert.deepEqual([s3, bad.why], [400, 'a round id, 32 bytes hex']);
  } finally { await doors.close(); }
});
