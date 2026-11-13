// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (federation): the #1244 halt check of the e-cash exchange is wired to `liquidations.haltOf`
// (server.js, createEcashExchange `halted`), but createLiquidations returns only { offer, list } - no haltOf. The call throws, the
// server's try/catch turns it into null, and a federation that turned HALTED (signed record or the seats' halt proof) is still
// exchanged out of and into: the notes the arbitration set pays for at the liquidation are taken and paid here as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';
import { createLiquidations } from '../src/liquidations.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const NOTES = 'fedimintA'.padEnd(40, 'a')  // kanban #2384, #2436: notes that decode;

test('wf1489-sm1-federation-2: a federation the seat holds HALTED is not exchanged (as server.js wires the check)', async () => {
  // the wiring as server.js has it, word for word
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // (kanban #1577: no catch-to-null any more - a throw refuses in ecash-exchange.js)
  assert.match(src, /halted: \(f\) => \(liquidations \? liquidations\.haltOf\(String\(f\)\.toLowerCase\(\)\) : null\),/);
  // this seat holds A's record HALTED at 1000 (federation-records.js haltOf / haltedFederations)
  const records = { haltOf: (f) => (f === A ? { height: 1000, bytes: null } : null), haltedFederations: () => [A], recordOf: () => null };
  const liquidations = createLiquidations({ records, clocks: { abandonBlocks: 144, claimWindowBlocks: 1008, lateClaimBlocks: 1008 }, verify: () => true, halts: null });
  const halted = (f) => (liquidations ? liquidations.haltOf(String(f).toLowerCase()) : null);
  let received = 0, holdsB = 500_000n;
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashReceive: async () => { received++; return { state: 'Success', msat: 100_000n }; } },
    [B]: { ecashBalance: async () => holdsB, ecashSend: async (m) => { holdsB -= m; return { ecash: 'fedimintb-1', msat: m }; }, ecashSent: async () => ({ found: false }) },
  };
  const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null, halted });
  const r = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  console.log('  MEASURED:', JSON.stringify({ liquidationsHasHaltOf: typeof liquidations.haltOf, haltedA: halted(A), exchange: { ok: r.ok, status: r.status || 200 }, reissuedAtA: received, paidOutAtB: String(500_000n - holdsB) }));
  assert.equal(r.ok, false, 'an exchange out of a federation this seat holds HALTED was paid');
  assert.equal(received, 0, 'the halted federation\'s notes were taken');
});

test('wf1489-sm1-federation-2 (kanban #1577): the exchange INTO a halted federation is refused, and a halt check that throws refuses', async () => {
  const records = { haltOf: (f) => (f === A ? { height: 1000, bytes: null } : null), haltedFederations: () => [A], recordOf: () => null };
  const liquidations = createLiquidations({ records, clocks: { abandonBlocks: 144, claimWindowBlocks: 1008, lateClaimBlocks: 1008 }, verify: () => true, halts: null });
  assert.equal(typeof liquidations.haltOf, 'function');
  assert.deepEqual(liquidations.haltedFederations(), [A]);
  let received = 0;
  const port = { ecashBalance: async () => 500_000n, ecashReceive: async () => { received++; return { state: 'Success', msat: 100_000n }; },
    ecashSend: async (m) => ({ ecash: 'fedimintx-1', msat: m }), ecashSent: async () => ({ found: false }) };
  const into = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async () => port, halted: (f) => liquidations.haltOf(f) });
  const r1 = await into.exchange({ from: B, to: A, ecash: 'fedimintB'.padEnd(40, 'b'), amountMsat: '100000' });
  assert.equal(r1.ok, false); assert.equal(r1.status, 409);
  const broken = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async () => port, halted: () => { throw new Error('records unreadable'); } });
  const r2 = await broken.exchange({ from: B, to: 'cc'.repeat(32), ecash: 'fedimintB'.padEnd(40, 'c'), amountMsat: '100000' });
  assert.equal(r2.ok, false); assert.equal(r2.status, 503);
  assert.equal(received, 0, 'notes were taken although the halt was not ruled out');
});
