// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAPACITY PRESSURE (spec §23A.3a, kanban #543): the bands with their gap, B*, B*_net, P*, the installer's minimum, and the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityBand, targetBond, networkTargetBond, targetPegIn, installMinimumBond, capacityView } from '../src/capacity.js';

test('bands: entered at 70 / 90 / 100 %, left only below 60 / 80 / 100 % (no flapping at a boundary)', () => {
  assert.equal(capacityBand(0.69), 'CALM');
  assert.equal(capacityBand(0.71), 'PRESSURE');
  assert.equal(capacityBand(0.65, 'PRESSURE'), 'PRESSURE', 'in the gap it stays');
  assert.equal(capacityBand(0.59, 'PRESSURE'), 'CALM');
  assert.equal(capacityBand(0.61, 'CALM'), 'CALM', 'the gap does not enter it');
  assert.equal(capacityBand(0.92), 'CRITICAL');
  assert.equal(capacityBand(0.85, 'CRITICAL'), 'CRITICAL');
  assert.equal(capacityBand(0.79, 'CRITICAL'), 'PRESSURE');
  assert.equal(capacityBand(1.0), 'FULL');
  assert.equal(capacityBand(0.99, 'FULL'), 'CRITICAL', 'FULL ends below 100 %');
  assert.equal(capacityBand(4.33), 'FULL');
  assert.equal(capacityBand(null), 'CALM', 'no cap in the record');
});

test('B*: the spec\'s example - 7 guardians, reserve 130,000 -> 86,667; never below the floor', () => {
  assert.equal(targetBond({ reserveSats: 130000n, nominal: 7, bondMinSats: 50000n }), 86667n);
  assert.equal(targetBond({ reserveSats: 10000n, nominal: 7, bondMinSats: 50000n }), 50000n);
  assert.equal(targetBond({ reserveSats: 650000n, nominal: 7, bondMinSats: 50000n }), 433334n, 'live A: 650,000 against (f + 1) = 3');
});

test('B*_net over the OPEN federations, P* a quarter of the headroom per gateway seat, the installer minimum rounded up to 10,000', () => {
  const feds = [{ status: 'OPEN', nominal: 7, reserveSats: '650000' }, { status: 'DRAINING', nominal: 7, reserveSats: '108000' }, { status: 'OPEN', nominal: 4, reserveSats: '20000' }];
  assert.equal(networkTargetBond(feds, 50000n), 268000n, '(650,000 + 20,000) / (0.5 x (3 + 2))');
  assert.equal(networkTargetBond([], 50000n), 50000n);
  assert.equal(targetPegIn({ headroomSats: 42000n, pegInMinSats: 50000n }), 50000n);
  assert.equal(targetPegIn({ headroomSats: 1000000n, pegInMinSats: 50000n }), 125000n);
  assert.equal(installMinimumBond({ bondMinSats: 50000n, networkTarget: 86667n }), 90000n);
  assert.equal(installMinimumBond({ bondMinSats: 50000n, networkTarget: 20000n }), 50000n);
});

test('the view: per federation load, band, headroom, B* and who is below it; the network band is the lowest-load OPEN federation\'s', () => {
  const v = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, was: {},
    federations: [
      { federation: 'a', status: 'OPEN', nominal: 7, reserveSats: '130000', exposureCapSats: '150000',
        guardianBonds: [{ node: 'g1', bondSats: 50000n }, { node: 'g2', bondSats: 90000n }], gateways: [{ node: 'g1', pegInSats: 248999n }] },
      { federation: 'b', status: 'OPEN', nominal: 7, reserveSats: '15000', exposureCapSats: '150000', guardianBonds: [], gateways: [] },
      { federation: 'c', status: 'DRAINING', nominal: 7, reserveSats: '1000', exposureCapSats: '150000' }] });
  const a = v.federations[0];
  assert.equal(a.band, 'PRESSURE'); assert.equal(a.load, 0.8666); assert.equal(a.headroomSats, '20000'); assert.equal(a.targetBondSats, '86667');
  assert.deepEqual(a.guardiansBelowTarget, [{ node: 'g1', bondSats: '50000', addSats: '36667' }]);
  assert.equal(a.targetPegInSats, '50000'); assert.deepEqual(a.gatewaysBelowTarget, []);
  assert.equal(v.network.lowestFederation, 'b', 'new deposits go to the lowest-load OPEN one');
  assert.equal(v.network.band, 'CALM');
  assert.equal(v.network.targetBondSats, '50000', 'B*_net = (130,000 + 15,000) / (0.5 x (3 + 3)) = 48,334, under the floor');
  assert.equal(v.network.installMinimumBondSats, '50000');
});

// ADD TO BOND (kanban #544): a guardian named twice - two bond outputs - is one guardian with their sum
test('the view sums one guardian\'s rows: 50,000 + 32,000 is one guardian at 82,000 against B*', () => {
  const v = capacityView({ bondMinSats: 50000n, pegInMinSats: 50000n, federations: [{ federation: 'aa', status: 'OPEN', nominal: 7, reserveSats: '130000',
    exposureCapSats: '150000', guardianBonds: [{ node: 'g1', bondSats: 50000n }, { node: 'g1', bondSats: 32000n }, { node: 'g2', bondSats: 50000n }], gateways: [] }] });
  const f = v.federations[0];
  assert.equal(f.targetBondSats, '86667');
  assert.equal(f.guardians, 2);
  assert.deepEqual(f.guardiansBelowTarget.map((g) => [g.node, g.bondSats, g.addSats]), [['g1', '82000', '4667'], ['g2', '50000', '36667']]);
});
