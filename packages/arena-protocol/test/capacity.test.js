// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAPACITY PRESSURE (spec §23A.3a, kanban #543): the bands with their gap, B*, B*_net, P*, the installer's minimum, and the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityBand, targetBond, networkTargetBond, targetPegIn, installMinimumBond, capacityView, capacityPlea } from '../src/capacity.js';

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

// THE PLEA (kanban #543): what the node dashboard and the owner page say to one node - how much to ADD, for the worst band it is below
// target in; the network's plea when only the network is under pressure; nothing while all is CALM
test('the plea: the node below B* in a filling federation is told how much to add; a calm network says nothing', () => {
  const fed = (band, load, below = [], gw = []) => ({ federation: 'aa'.repeat(32), band, load, targetBondSats: '86667', targetPegInSats: '50000',
    guardiansBelowTarget: below, gatewaysBelowTarget: gw });
  const calm = { federations: [fed('CALM', 0.4, [{ node: 'g1', addSats: '36667' }])], network: { band: 'CALM' } };
  assert.equal(capacityPlea(calm, 'g1'), null);
  const v = { federations: [fed('PRESSURE', 0.87, [{ node: 'g1', addSats: '36667' }], [{ node: 'g1', addSats: '12000' }])], network: { band: 'PRESSURE', lowestLoad: 0.87, targetBondSats: '86667' } };
  const p = capacityPlea(v, 'G1');
  assert.deepEqual([p.level, p.band, p.addSats, p.pegInAddSats], ['warn', 'PRESSURE', '36667', '12000']);
  assert.match(p.says, /^Federation aaaaaaaa holds 87 % of what its bonds cover \(PRESSURE\)\. Increase your bond by 36,667 sat \(Add to bond\) to bring it to 86,667 sat/);
  assert.match(p.says, /Raise your gateway's peg-in by 12,000 sat, to 50,000 sat\./);
  const other = capacityPlea(v, 'g9');
  assert.equal(other.addSats, undefined);
  assert.match(other.says, /The network is under capacity pressure \(PRESSURE, the lowest-load federation at 87 %\)\. A bond of at least 86,667 sat/);
  const full = capacityPlea({ federations: [fed('FULL', 1.02, [{ node: 'g1', addSats: '50000' }])], network: { band: 'FULL' } }, 'g1');
  assert.equal(full.level, 'bad'); assert.match(full.says, /\(FULL: deposits are closed\)/);
});
