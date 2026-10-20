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

// kanban #553: the owner page names the amount AND the incentive - §23A.3a's own example: 7 guardians at 50,000 sat, B* 86,667 sat
test('bondIncentive: the spec\'s example - the raiser takes 33.3 % instead of 14.3 % under pressure; even while CALM', async () => {
  const { bondIncentive } = await import('../src/capacity.js');
  const bonds = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ node: `0${i}`, bondSats: '50000' }));
  const p = bondIncentive({ bonds, targetBondSats: '86667', node: '01', pressure: true });
  assert.equal(p.addSats, '36667');
  assert.equal(p.even.toFixed(3), '0.143'); assert.equal(p.now.toFixed(3), '0.143'); assert.equal(p.ifRaised.toFixed(3), '0.334');
  const calm = bondIncentive({ bonds, targetBondSats: '86667', node: '01', pressure: false });
  assert.deepEqual([calm.now.toFixed(3), calm.ifRaised.toFixed(3), calm.underPressure.toFixed(3)], ['0.143', '0.143', '0.334']);
  // three raised (the table's third row): the others' weight falls, a raiser has 23.1 %
  const three = bonds.map((b, i) => (i < 2 ? { ...b, bondSats: '86667' } : b));
  assert.equal(bondIncentive({ bonds: three, targetBondSats: '86667', node: '07', pressure: true }).ifRaised.toFixed(3), '0.231');
  // two outputs of one node are one guardian; a node not among them gets nothing
  assert.equal(bondIncentive({ bonds: [...bonds, { node: '01', bondSats: '36667' }], targetBondSats: '86667', node: '01', pressure: true }).addSats, '0');
  assert.equal(bondIncentive({ bonds, targetBondSats: '86667', node: 'ff', pressure: true }), null);
});

// kanban #559/#543 (spec §23A.3a part 1): the guardians' weights under pressure, and the spec's table
test('guardian weights: (min(bond, B*))^2 under PRESSURE or worse; the spec\'s 7-guardian table; none while CALM', async () => {
  const { guardianWeights } = await import('../src/capacity.js');
  const node = (i) => String(i).repeat(64).slice(0, 64);
  const at = (raised) => [1, 2, 3, 4, 5, 6, 7].map((i) => ({ node: node(i), bondSats: i <= raised ? 86_667n : 50_000n }));
  const share = (w, i) => Number((w.get(node(i)) * 10000n) / [...w.values()].reduce((a, b) => a + b, 0n)) / 100;
  const base = { reserveSats: 130_000n, exposureCapSats: 150_000n, nominal: 7, bondMinSats: 50_000n };   // load 0.87: PRESSURE, B* 86,667
  const one = guardianWeights({ ...base, bonds: at(1) });
  const near = (a, b, why) => assert.ok(Math.abs(a - b) <= 0.1, `${why}: ${a} against ${b}`);
  near(share(one, 1), 33.3, 'one raiser 33.3 % (2.3x even)'); near(share(one, 2), 11.1, 'each other 11.1 %');
  const three = guardianWeights({ ...base, bonds: at(3) });
  near(share(three, 1), 23.1, 'three: 23.1 % each'); near(share(three, 7), 7.7, 'the others 7.7 %');
  const all = guardianWeights({ ...base, bonds: at(7) });
  near(share(all, 4), 14.3, 'all seven raised: even again');
  const whale = guardianWeights({ ...base, bonds: [{ node: node(1), bondSats: 900_000n }, ...at(0).slice(1)] });
  assert.equal(whale.get(node(1)), 86_667n * 86_667n, 'capped at B*: a bigger bond earns nothing more');
  assert.equal(guardianWeights({ ...base, reserveSats: 60_000n, bonds: at(1) }), null, 'load 0.4: CALM, the even split');
  assert.equal(guardianWeights({ ...base, bonds: at(1), band: 'CALM' }), null, 'a record that says CALM wins over the load');
});

// kanban #559/#543 (spec §23A.3a part 2): the gateways' weights under peg-in pressure
test('gateway weights: (min(proved peg-in, P*))^2 under PRESSURE and peg-in pressure; the one at P* takes 80 %; none otherwise', async () => {
  const { gatewayWeights } = await import('../src/capacity.js');
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  // load 0.8: PRESSURE; headroom 200,000 -> P* = max(50,000, ceil(200,000 / 8)) = 50,000
  const base = { reserveSats: 800_000n, exposureCapSats: 1_000_000n, pegInMinSats: 50_000n };
  const w = gatewayWeights({ ...base, pegIns: [{ node: A, pegInSats: 50_000n }, { node: B, pegInSats: 25_000n }] });
  const share = (n) => Number((w.get(n) * 1000n) / [...w.values()].reduce((a, b) => a + b, 0n)) / 10;
  assert.equal(share(A), 80, 'at P* against half of it: 80 %');
  assert.equal(gatewayWeights({ ...base, pegIns: [{ node: A, pegInSats: 900_000n }, { node: B, pegInSats: 25_000n }] }).get(A), 50_000n * 50_000n, 'capped at P*');
  assert.equal(gatewayWeights({ ...base, pegIns: [{ node: A, pegInSats: 50_000n }, { node: B, pegInSats: 60_000n }] }), null, 'both at P*: no peg-in pressure, evenly');
  assert.equal(gatewayWeights({ ...base, reserveSats: 300_000n, pegIns: [{ node: A, pegInSats: 50_000n }, { node: B, pegInSats: 0n }] }), null, 'CALM: evenly');
  assert.equal(gatewayWeights({ ...base, pegIns: [{ node: A, pegInSats: 0n }, { node: B, pegInSats: 0n }] }), null, 'nothing proved: evenly');
});
