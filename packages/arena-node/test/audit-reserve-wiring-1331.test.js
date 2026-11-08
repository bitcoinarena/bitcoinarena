// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1331 (1): every seat plans an audited round with its federation's reserve key, or builds nothing (§13A.1 RULED 2026-11-07)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockSettlement } from '../src/settlement.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(7);
const KEY = Uint8Array.from([0x02, ...new Uint8Array(32).fill(9)]);
const contract = { protocolVersion: 22, stakeMsat: 1000n, federationId: FED, nodes: [] };
const seat = (o) => new LockSettlement({}, { signerNodesFor: () => ({ gameVerify: [], settlement: [] }), ...o });

test('#1331 an audited round carries its federation\'s reserve key', async () => {
  const asked = [];
  const r = await seat({ auditedRoundOf: () => true, reserveKeyFor: async (f) => { asked.push(f); return KEY; } }).signerNodesWithReserve(new Uint8Array(32), contract);
  assert.equal(r.ok, true);
  assert.equal(toHex(r.signerNodes.auditReserveKey), toHex(KEY));
  assert.deepEqual(asked, [toHex(FED)]);
});

test('#1331 an audited round with no reserve key known is refused, not planned without it', async () => {
  for (const reserveKeyFor of [async () => null, async () => { throw new Error('peers silent'); }, null]) {
    const r = await seat({ auditedRoundOf: () => true, reserveKeyFor }).signerNodesWithReserve(new Uint8Array(32), contract);
    assert.equal(r.ok, false);
    assert.match(r.why, /no reserve key is known/);
  }
});

test('#1331 a round without auditors, or one taking any federation, keeps the old plan', async () => {
  const none = await seat({ auditedRoundOf: () => false, reserveKeyFor: async () => KEY }).signerNodesWithReserve(new Uint8Array(32), contract);
  assert.equal(none.ok, true); assert.equal(none.signerNodes.auditReserveKey, undefined);
  const anyFed = await seat({ auditedRoundOf: () => true, reserveKeyFor: async () => null }).signerNodesWithReserve(new Uint8Array(32), { ...contract, federationId: new Uint8Array(32) });
  assert.equal(anyFed.ok, true); assert.equal(anyFed.signerNodes.auditReserveKey, undefined);
});
