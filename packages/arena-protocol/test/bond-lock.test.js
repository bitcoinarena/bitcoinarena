// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN'S BOND STAYS LOCKED WHILE IT SERVES (kanban #1093 part 7, ruling #1104): cap = max(0, f + 1 - k) x the smallest qualifying bond,
// k the seated guardians whose outputs maturing past record height + drain_blocks sum below bond_min_guardian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockedExposureCap, exposureCap } from '../src/federation-slash.js';
import { buildFederationRecord, BOND_LOCK_HEIGHT, bondLockPoint } from '../src/federation-record.js';

const H = 1000, DRAIN = 100, MIN = 50_000n;   // the line is 1100
const g = (...outs) => ({ outputs: outs.map(([bondSats, maturity]) => ({ bondSats: BigInt(bondSats), maturity })) });

test('every bond locked: the cap is (f + 1) x the smallest, as before', () => {
  const seven = [g([100_000, 5000]), g([80_000, 5000]), g([90_000, 2000]), g([70_000, 1101]), g([60_000, 3000]), g([75_000, 4000]), g([95_000, 9000])];
  const c = lockedExposureCap({ guardians: seven, f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
  assert.deepEqual([c.cap, c.lapsing, c.places], [180_000n, 0, 3]);
  assert.equal(c.cap, exposureCap({ bonds: [100_000n, 80_000n, 90_000n, 70_000n, 60_000n, 75_000n, 95_000n], f: 2 }).cap);
});

test('one lapsing guardian takes one place out; f + 1 of them make it 0; it is still counted as seated', () => {
  const base = [g([100_000, 5000]), g([80_000, 5000]), g([90_000, 2000]), g([70_000, 5000]), g([60_000, 3000]), g([75_000, 4000])];
  const one = lockedExposureCap({ guardians: [...base, g([10_000_000, 1100])], f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
  assert.deepEqual([one.cap, one.lapsing, one.places, one.smallest], [120_000n, 1, 2, 60_000n], 'maturing exactly at the line covers nothing, however big');
  const three = lockedExposureCap({ guardians: [...base.slice(0, 4), g([90_000, 1050]), g([90_000, 900]), g([90_000, 1100])], f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
  assert.deepEqual([three.cap, three.lapsing], [0n, 3]);
});

test('a later output beside a lapsing one qualifies the guardian, by what is locked; below the floor it does not', () => {
  const others = [g([100_000, 5000]), g([80_000, 5000]), g([90_000, 2000]), g([70_000, 5000]), g([60_000, 3000]), g([75_000, 4000])];
  const added = lockedExposureCap({ guardians: [...others, g([500_000, 1050], [55_000, 6000])], f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
  assert.deepEqual([added.cap, added.lapsing, added.smallest], [165_000n, 0, 55_000n], 'its locked 55 000 is now the smallest');
  const short = lockedExposureCap({ guardians: [...others, g([500_000, 1050], [40_000, 6000])], f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
  assert.equal(short.lapsing, 1);
});

test('the theft cover holds for every k: the qualifying bonds sum to more than the cap', () => {
  for (let k = 0; k <= 7; k++) {
    const gs = Array.from({ length: 7 }, (_, i) => (i < k ? g([60_000, 900]) : g([60_000 + i * 1000, 5000])));
    const c = lockedExposureCap({ guardians: gs, f: 2, height: H, drainBlocks: DRAIN, bondMinGuardian: MIN });
    const sum = gs.slice(k).reduce((a, x) => a + x.outputs[0].bondSats, 0n);
    assert.ok(sum >= c.cap, `k ${k}: ${sum} covers ${c.cap}`);
  }
});

test('the record: from the lock on the cap counts only locked bonds; the height is mainnet 0, testnet4 not yet named', () => {
  assert.deepEqual([BOND_LOCK_HEIGHT.mainnet, bondLockPoint('testnet4'), bondLockPoint('testnet'), bondLockPoint('signet')], [0, null, null, null]);
  const k = (n) => new Uint8Array(32).fill(n);
  const guardians = [1, 2, 3, 4].map((n) => ({ peerKey: k(n), nodePubkey: k(n + 10), operatorId: 'o', bondTxid: k(n + 20), bondVout: 0, endpoint: '',
    bondSats: 100_000n, outputs: [{ bondSats: 100_000n, maturity: n === 4 ? 1050 : 5000 }] }));
  const base = { federationId: k(9), networkId: k(8), invite: 'x', nominal: 4, guardians, height: H, reserveSats: 0n };
  assert.equal(buildFederationRecord(base).exposureCapSats, 200_000n, 'before the lock: f = 1, two of the smallest');
  assert.equal(buildFederationRecord({ ...base, bondLock: { drainBlocks: DRAIN, bondMinGuardian: MIN } }).exposureCapSats, 100_000n, 'one lapsing: one place');
  assert.equal(buildFederationRecord({ ...base, bondLock: { drainBlocks: DRAIN, bondMinGuardian: MIN } }).seated, 4, 'still seated');
});

test('the dashboard\'s warning: a guardian bond lapses at m* - drain_blocks and is warned drain_blocks before', async () => {
  const { bondLapseOf } = await import('../src/federation-slash.js');
  const outs = [{ bondSats: 30_000n, maturity: 3000 }, { bondSats: 40_000n, maturity: 2000 }];
  assert.deepEqual(bondLapseOf({ outputs: outs, drainBlocks: 100, bondMinGuardian: 50_000n, tip: 1000 }), { qualifying: true, lapsesAt: 1900, blocksLeft: 900, warn: false, warnBlocks: 100, departsAt: 3000 },   // #1318: the warning's reach and where the seat ends
    'the two outputs reach the floor only together: the earlier maturity, 2000, decides');
  assert.equal(bondLapseOf({ outputs: outs, drainBlocks: 100, bondMinGuardian: 50_000n, tip: 1800 }).warn, true, 'drain_blocks before');
  assert.equal(bondLapseOf({ outputs: outs, drainBlocks: 100, bondMinGuardian: 50_000n, tip: 1900 }).qualifying, false);
  assert.equal(bondLapseOf({ outputs: outs, drainBlocks: 100, bondMinGuardian: 30_000n, tip: 1900 }).lapsesAt, 2900, 'the later output alone meets a lower floor');
  assert.deepEqual(bondLapseOf({ outputs: [{ bondSats: 10n, maturity: 9000 }], drainBlocks: 100, bondMinGuardian: 50_000n, tip: 1 }).qualifying, false);
});
