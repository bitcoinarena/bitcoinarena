// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GUARDIAN FOUNDING BY SORTITION (§23A.2): over the guardian-capable census, one ticket per operator, operators guarding an
// OPEN federation left out, bond_min_guardian held; nominal drawn and three alternates in order; a no-show replaced by the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians, replaceNoShows, FOUNDING_WINDOW, foundingTrigger, FOUNDING_PRESSURE_HEIGHT, foundingPressurePoint, foundingRecordHeight, foundingCandidateVersion } from '../src/guardian-founding.js';
import { FOUNDING_PRESSURE_VERSION } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const node = (n, op, { capable = true, bond = 1000000n, endpoint = `wss://g${n}` } = {}) =>
  ({ pubkey: b32(n), txid: b32(0x40 + n), vout: 0, bondSats: bond, advert: { operatorId: op, guardianCapable: capable, guardianEndpoint: capable ? endpoint : '' } });

test('drawn over the eligible operators only, deterministic on the seed, nominal plus three alternates', () => {
  const entries = [...Array.from({ length: 12 }, (_, i) => node(i + 1, `op${i + 1}`)),
    node(20, 'op1'),                                    // a second node of op1: one ticket for the operator
    node(21, 'lazy', { capable: false }),               // not guardian-capable
    node(22, 'small', { bond: 1000n }),                 // under bond_min_guardian
    node(23, 'busy')];                                  // guards an OPEN federation already
  const args = { entries, seed: b32(0x77), nominal: 7, bondMinGuardian: 500000n, guardingOpen: new Set(['busy']) };
  const d = drawGuardians(args);
  assert.equal(d.ok, true, d.why); assert.equal(d.eligible, 12); assert.equal(d.drawn.length, 7); assert.equal(d.alternates.length, 3);
  const ops = [...d.drawn, ...d.alternates].map((e) => e.advert.operatorId);
  assert.equal(new Set(ops).size, 10, 'one seat per operator');
  assert.ok(!ops.some((o) => ['lazy', 'small', 'busy'].includes(o)));
  assert.deepEqual(drawGuardians(args).drawn.map((e) => toHex(e.pubkey)), d.drawn.map((e) => toHex(e.pubkey)), 'the same seed, the same draw');
  assert.notDeepEqual(drawGuardians({ ...args, seed: b32(0x78) }).drawn.map((e) => toHex(e.pubkey)), d.drawn.map((e) => toHex(e.pubkey)));
  const few = drawGuardians({ ...args, entries: entries.slice(0, 6) });
  assert.equal(few.ok, false); assert.match(few.why, /not founded with fewer/);
});

test('a no-show is replaced by the next alternate in order; more no-shows than alternates found nothing', () => {
  const entries = Array.from({ length: 10 }, (_, i) => node(i + 1, `op${i + 1}`));
  const d = drawGuardians({ entries, seed: b32(0x77), nominal: 7, bondMinGuardian: 500000n });
  const gone = [toHex(d.drawn[2].pubkey), toHex(d.drawn[5].pubkey)];
  const r = replaceNoShows({ drawn: d.drawn, alternates: d.alternates, noShows: gone });
  assert.equal(r.ok, true); assert.equal(r.used, 2);
  assert.equal(toHex(r.seated[2].pubkey), toHex(d.alternates[0].pubkey)); assert.equal(toHex(r.seated[5].pubkey), toHex(d.alternates[1].pubkey));
  const four = replaceNoShows({ drawn: d.drawn, alternates: d.alternates, noShows: d.drawn.slice(0, 4).map((e) => toHex(e.pubkey)) });
  assert.equal(four.ok, false); assert.match(four.why, /drawn again at the next trigger/);
});

test('what starts a founding: genesis at the first height with nominal operators, a draining federation, or 80 % load for abandon_blocks - the earliest', async () => {
  const { foundingTrigger } = await import('../src/guardian-founding.js');
  const capable = [{ height: 100, operators: 6 }, { height: 110, operators: 9 }, { height: 120, operators: 10 }, { height: 130, operators: 12 }];
  const g = foundingTrigger({ capable, nominal: 10 });
  assert.deepEqual([g.ok, g.kind, g.height], [true, 'genesis', 120]);
  assert.match(foundingTrigger({ capable: capable.slice(0, 2), nominal: 10 }).why, /fewer than federation_nominal 10/);
  assert.equal(foundingTrigger({ capable, nominal: 10, federationExists: true }).ok, false, 'genesis only while no federation exists');
  const drain = foundingTrigger({ records: [{ federation: 'aa'.repeat(32), status: 'OPEN', height: 200 }, { federation: 'bb'.repeat(32), status: 'DRAINING', height: 250 }], federationExists: true });
  assert.deepEqual([drain.kind, drain.height], ['succession', 250]);
  const at = (h, a, b) => ({ height: h, federations: [{ federation: 'a', status: 'OPEN', load: a }, { federation: 'b', status: 'OPEN', load: b }, { federation: 'c', status: 'DRAINING', load: 0.1 }] });
  const loads = [at(300, 0.9, 0.85), at(305, 0.9, 0.79), at(306, 0.81, 0.8), at(310, 0.95, 0.9), at(316, 0.99, 0.8)];
  const l = foundingTrigger({ loads, abandonBlocks: 10, federationExists: true });
  assert.deepEqual([l.kind, l.height], ['load', 316], 'from 306 (305 dipped under 80 %) for 10 blocks; a draining federation does not count');
  assert.equal(foundingTrigger({ loads: loads.slice(0, 4), abandonBlocks: 10, federationExists: true }).ok, false);
  const both = foundingTrigger({ loads, abandonBlocks: 10, records: [{ federation: 'x', status: 'DRAINING', height: 312 }], federationExists: true });
  assert.deepEqual([both.kind, both.height], ['succession', 312], 'the earliest event wins');
});

// SEATED FIRST (§23A.6 step 1): the old federation's seated, non-departing guardians first, in order; only the missing seats
// drawn, from the pool minus their operators and minus operators guarding another OPEN federation; then three alternates.
test('a succession seats the old guardians first, in their order, and draws only the missing seats', () => {
  const old = [node(1, 'opA'), node(2, 'opB'), node(3, 'opC')];
  const entries = [...old, node(4, 'opD'), node(5, 'opE'), node(6, 'opF'), node(7, 'opG'), node(8, 'opH'),
    node(9, 'opA'),                                     // a second node of a seated-first operator: not drawn into the missing seat
    node(10, 'busy')];                                  // guards another OPEN federation
  const d = drawGuardians({ entries, seed: b32(0x77), nominal: 4, bondMinGuardian: 500000n, guardingOpen: new Set(['busy']), seatedFirst: old });
  assert.equal(d.ok, true, d.why);
  assert.equal(d.seatedFirst, 3);
  assert.deepEqual(d.drawn.slice(0, 3).map((e) => e.advert.operatorId), ['opA', 'opB', 'opC'], 'seated first, in the order given');
  const drawnOp = d.drawn[3].advert.operatorId;
  assert.ok(['opD', 'opE', 'opF', 'opG', 'opH'].includes(drawnOp), `the missing seat drawn from the others: ${drawnOp}`);
  assert.equal(d.alternates.length, 3);
  const ops = [...d.drawn, ...d.alternates].map((e) => e.advert.operatorId);
  assert.equal(new Set(ops).size, 7, 'one seat per operator');
  assert.ok(!ops.includes('busy') && ops.filter((o) => o === 'opA').length === 1);
  assert.equal(d.eligible, 5, 'opD..opH');
  assert.match(d.why, /3 seated first, 1 drawn of 5 eligible operators, 3 alternates in order/);
  // the same seed, the same draw; a pool too small for the missing seats founds nothing
  assert.deepEqual(drawGuardians({ entries, seed: b32(0x77), nominal: 4, bondMinGuardian: 500000n, guardingOpen: new Set(['busy']), seatedFirst: old }).drawn.map((e) => toHex(e.pubkey)), d.drawn.map((e) => toHex(e.pubkey)));
  const none = drawGuardians({ entries: [...old, node(9, 'opA'), node(10, 'busy')], seed: b32(0x77), nominal: 4, bondMinGuardian: 500000n, guardingOpen: new Set(['busy']), seatedFirst: old });
  assert.equal(none.ok, false); assert.match(none.why, /3 seated first, and 0 other .* the 1 missing seats of 4 are not filled/);
});

test('fewer seated first than f + 1: everything is drawn', () => {
  const entries = Array.from({ length: 10 }, (_, i) => node(i + 1, `op${i + 1}`));
  const plain = drawGuardians({ entries, seed: b32(0x55), nominal: 7, bondMinGuardian: 500000n });
  const two = drawGuardians({ entries, seed: b32(0x55), nominal: 7, bondMinGuardian: 500000n, seatedFirst: entries.slice(8, 10) });   // f = 2: 2 < 3
  assert.equal(two.ok, true); assert.equal(two.seatedFirst, 0);
  assert.deepEqual(two.drawn.map((e) => toHex(e.pubkey)), plain.drawn.map((e) => toHex(e.pubkey)), 'the plain draw');
  assert.match(two.why, /everything drawn: 2 seated first is fewer than f \+ 1 = 3/);
  const three = drawGuardians({ entries, seed: b32(0x55), nominal: 7, bondMinGuardian: 500000n, seatedFirst: entries.slice(7, 10) });
  assert.equal(three.seatedFirst, 3, 'f + 1 = 3: seated first');
});

test('federation B, 5 of 7: B1..B6 of one operator seated first though that operator guards OPEN A; the 15th node drawn; nothing else', () => {
  const B = Array.from({ length: 7 }, (_, i) => node(i + 1, '2of2'));
  const A = Array.from({ length: 7 }, (_, i) => node(i + 11, '2of2'));
  const n15 = node(15, 'node15');
  const d = drawGuardians({ entries: [...A, ...B, n15], seed: b32(0x26), nominal: 7, bondMinGuardian: 50000n, guardingOpen: new Set(['2of2']), seatedFirst: B.slice(0, 6) });
  assert.equal(d.ok, true, d.why);
  assert.deepEqual(d.drawn.map((e) => e.pubkey[0]), [1, 2, 3, 4, 5, 6, 15]);
  assert.deepEqual(d.alternates, [], 'no alternate: a no-show voids the founding');
  assert.equal(d.eligible, 1);
});

test('a departure notice that would make a federation DRAINING triggers a succession at its posted height, carrying the seated first', async () => {
  const { foundingTrigger } = await import('../src/guardian-founding.js');
  const t = foundingTrigger({ records: [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 900 }],
    notices: [{ federation: 'bb'.repeat(32), height: 950, wouldBe: 'DRAINING', seatedFirst: ['01', '02'], departing: ['07'] }], federationExists: true });
  assert.deepEqual([t.ok, t.kind, t.height, t.notice, t.federation], [true, 'succession', 950, true, 'bb'.repeat(32)]);
  assert.deepEqual([t.seatedFirst, t.departing], [['01', '02'], ['07']]);
  assert.match(t.why, /departure notice posted at 950 would make federation bbbbbbbbbbbbbbbb DRAINING/);
  const earlier = foundingTrigger({ records: [{ federation: 'cc'.repeat(32), status: 'DRAINING', height: 940 }], notices: [{ federation: 'bb'.repeat(32), height: 950 }], federationExists: true });
  assert.deepEqual([earlier.height, earlier.federation, earlier.notice], [940, 'cc'.repeat(32), undefined], 'the earliest event wins');
});

test('the cohort (protocol 2026.0.14, ruling 3): COHORT_NOMINAL free operators found their own federation while others exist', async () => {
  const { foundingTrigger, COHORT_NOMINAL } = await import('../src/guardian-founding.js');
  assert.equal(COHORT_NOMINAL, 10);
  const capable = [{ height: 100, operators: 14, free: 8 }, { height: 101, operators: 16, free: 10 }, { height: 102, operators: 17, free: 11 },
    { height: 103, operators: 15, free: 9 }, { height: 104, operators: 16, free: 10 }, { height: 105, operators: 16, free: 10 }];
  const t = foundingTrigger({ capable, nominal: 4, abandonBlocks: 12, federationExists: true });
  assert.deepEqual([t.ok, t.kind, t.height, t.nominal], [true, 'cohort', 104, 10], 'the start of the current run: the run from 101 ended at 103');
  assert.equal(foundingTrigger({ capable: capable.slice(0, 1), nominal: 4, abandonBlocks: 12, federationExists: true }).ok, false, 'eight are not a cohort');
  assert.equal(foundingTrigger({ capable: capable.map(({ free, ...r }) => r), nominal: 4, abandonBlocks: 12, federationExists: true }).ok, false, 'a seat that counts no free operators triggers none');
  const g = foundingTrigger({ capable, nominal: 4, abandonBlocks: 12, federationExists: false });
  assert.deepEqual([g.kind, g.height], ['genesis', 100], 'before any federation the genesis trigger stands');
  const early = foundingTrigger({ capable, records: [{ federation: 'aa', status: 'DRAINING', height: 90 }], nominal: 4, abandonBlocks: 12, federationExists: true });
  assert.equal(early.kind, 'succession', 'the earliest event wins');
});

test('a founding that went void is passed over: the next trigger draws again; a voided cohort draws again later (§23A.2, measured on the test host seats: B\'s void notice at 156647 held every later trigger back)', async () => {
  const { foundingTrigger, triggerKey } = await import('../src/guardian-founding.js');
  const B = 'b1'.repeat(32);
  const notice = { height: 156647, federation: B, wouldBe: 'DRAINING' };
  const capable = [{ height: 156900, operators: 30, free: 9 }, { height: 156950, operators: 31, free: 10 }, { height: 156960, operators: 31, free: 10 }, { height: 156990, operators: 31, free: 11 }];
  const first = foundingTrigger({ notices: [notice], capable, federationExists: true });
  assert.deepEqual([first.kind, first.height], ['succession', 156647], 'the earliest event, as before');
  const next = foundingTrigger({ notices: [notice], capable, federationExists: true, voided: [triggerKey(first)] });
  assert.deepEqual([next.kind, next.height, next.nominal], ['cohort', 156950, 10], 'B\'s void notice passed over: the cohort of ten free operators starts');
  const again = foundingTrigger({ notices: [notice], capable, federationExists: true, voided: [triggerKey(first), triggerKey(next)] });
  assert.deepEqual([again.kind, again.height], ['cohort', 156960], 'the cohort went void too: it draws again from a later height of its run');
  const none = foundingTrigger({ notices: [notice], capable: capable.slice(0, 2), federationExists: true, voided: [triggerKey(first), 'cohort::156950'] });
  assert.equal(none.ok, false); assert.match(none.why, /went void/);
});

test('a cohort is drawn again every 6 blocks (2026-10-22: "every 6 blocks on all instead of 19")', () => {
  assert.equal(FOUNDING_WINDOW, 5);
  const capable = Array.from({ length: 30 }, (_, i) => ({ height: 100 + i, operators: 14, free: 12, federations: 2 }));
  const at = (tip) => foundingTrigger({ capable, federationExists: true, nominal: 10, abandonBlocks: 12, tip, foundingWindow: FOUNDING_WINDOW }).height;
  assert.deepEqual([at(101), at(103), at(108), at(109), at(115), at(121)], [undefined, 102, 102, 108, 114, 120]);
  // a seat whose memory of the run begins later names the same draw (installer a: 157,236 against 157,173)
  const late = capable.slice(5);
  assert.equal(foundingTrigger({ capable: late, federationExists: true, nominal: 10, abandonBlocks: 12, tip: 115, foundingWindow: FOUNDING_WINDOW }).height, 114);
});

// UNDER CAPACITY PRESSURE (§23A.3a, kanban #993): operators at or above B*_net take the drawn places first; the draw is otherwise the same.
const ids = (l) => l.map((e) => toHex(e.pubkey));
const pressured = () => [...[100000n, 100000n, 100000n, 50000n, 50000n, 50000n, 50000n, 50000n, 50000n, 50000n, 50000n, 50000n].map((bond, i) => node(i + 1, `op${i + 1}`, { bond }))];
const base = { seed: b32(0x77), height: 200, nominal: 7, bondMinGuardian: 50000n };

test('no pressure: the draw and the whole answer are what they were, whether the argument is left out or null', () => {
  const entries = pressured();
  const plain = drawGuardians({ ...base, entries });
  assert.deepEqual(drawGuardians({ ...base, entries, pressureBond: null }), plain);
  assert.deepEqual(drawGuardians({ ...base, entries, pressureBond: undefined }), plain);
  assert.ok(!('atPressureBond' in plain), 'the answer gains no field');
  assert.doesNotMatch(plain.why, /pressure/);
});

test('pressure: the operators at B*_net sit first, in ticket order among themselves; the same set whatever the census order', () => {
  const entries = pressured();
  const plain = drawGuardians({ ...base, entries });
  const d = drawGuardians({ ...base, entries, pressureBond: 100000n });
  assert.equal(d.ok, true, d.why); assert.equal(d.atPressureBond, 3); assert.equal(d.eligible, plain.eligible, 'it orders the pool, it does not shrink it');
  const rich = ids(entries.slice(0, 3));
  assert.deepEqual([...ids(d.drawn).slice(0, 3)].sort(), [...rich].sort());
  const alone = drawGuardians({ ...base, nominal: 1, entries: entries.slice(0, 3) });
  assert.deepEqual(ids(d.drawn).slice(0, 3), ids([...alone.drawn, ...alone.alternates]), 'their own ticket order');
  assert.match(d.why, /under pressure 3 at or above B\*_net 100000 go ahead of the rest/);
  assert.deepEqual(ids(drawGuardians({ ...base, entries: [...entries].reverse(), pressureBond: 100000n }).drawn), ids(d.drawn), 'the census order decides nothing');
  assert.notDeepEqual(ids(drawGuardians({ ...base, seed: b32(0x78), entries, pressureBond: 100000n }).drawn), ids(d.drawn), 'the beacon still decides the order');
});

test('pressure with too few at B*_net: the other seats are drawn from the rest by ticket, then the alternates carry on', () => {
  const entries = pressured();
  const plain = drawGuardians({ ...base, entries });
  const d = drawGuardians({ ...base, entries, pressureBond: 100000n });
  const rich = new Set(ids(entries.slice(0, 3)));
  const restInPlainOrder = [...ids(plain.drawn), ...ids(plain.alternates)].filter((k) => !rich.has(k));
  assert.deepEqual([...ids(d.drawn).slice(3), ...ids(d.alternates)], restInPlainOrder.slice(0, 7), 'the rest keep the plain order among themselves');
  assert.equal(d.drawn.length, 7); assert.equal(d.alternates.length, 3);
});

test('pressure with more at B*_net than seats: only they are drawn, and the next of them is the first alternate', () => {
  const entries = Array.from({ length: 12 }, (_, i) => node(i + 1, `op${i + 1}`, { bond: i < 9 ? 100000n : 50000n }));
  const d = drawGuardians({ ...base, entries, pressureBond: 100000n });
  const rich = new Set(ids(entries.slice(0, 9)));
  assert.ok(ids(d.drawn).every((k) => rich.has(k)));
  assert.deepEqual(ids(d.alternates).map((k) => rich.has(k)), [true, true, false], 'nine of them: seven drawn, two alternates, then the rest');
});

test('ties at the boundary: exactly B*_net counts, a sat below does not, equal bonds fall to the ticket', () => {
  const at = node(1, 'at', { bond: 100000n }), below = node(2, 'below', { bond: 99999n });
  const others = Array.from({ length: 8 }, (_, i) => node(i + 10, `op${i + 10}`, { bond: 50000n }));
  const d = drawGuardians({ ...base, entries: [at, below, ...others], pressureBond: 100000n });
  assert.equal(d.atPressureBond, 1); assert.equal(toHex(d.drawn[0].pubkey), toHex(at.pubkey));
  // equal bonds: the plain draw between the same two is the order, so the rule adds no tie of its own
  const pair = drawGuardians({ ...base, nominal: 1, entries: [at, node(5, 'peer', { bond: 100000n })], pressureBond: 100000n });
  const same = drawGuardians({ ...base, nominal: 1, entries: [at, node(5, 'peer', { bond: 100000n })] });
  assert.deepEqual([ids(pair.drawn), ids(pair.alternates)], [ids(same.drawn), ids(same.alternates)]);
});

test('the test reads the seated node, not the operator: two small nodes summing to B*_net are not ahead, one node\'s two outputs are (ruling #1023)', () => {
  const two = [node(3, 'two', { bond: 60000n }), node(4, 'two', { bond: 40000n })];
  const output = { ...node(2, 'added', { bond: 40000n }), txid: b32(0x7f) };
  const others = Array.from({ length: 8 }, (_, i) => node(i + 10, `op${i + 10}`, { bond: 50000n }));
  const d = drawGuardians({ ...base, entries: [node(2, 'added', { bond: 60000n }), output, ...two, ...others], pressureBond: 100000n });
  assert.equal(d.atPressureBond, 1, 'the node with two outputs; not the operator with two nodes');
  assert.equal(toHex(d.drawn[0].pubkey), toHex(b32(2)));
  // the operator's sum still decides who may sit and the weight: 60,000 + 40,000 stays one ticket of 100,000
  assert.equal(d.eligible, 10);
  // the seated node is the one its ticket names, the lowest outpoint: a larger second node does not lift it
  const big = [node(5, 'split', { bond: 50000n }), node(6, 'split', { bond: 100000n })];
  assert.equal(drawGuardians({ ...base, entries: [...big, ...others], pressureBond: 100000n }).atPressureBond, 0);
});

test('from the point a node that does not advertise the version is no candidate; before it nothing is asked', () => {
  const listing = (n, op, list) => { const e = node(n, op); e.advert.protocolVersions = list; return e; };
  const entries = [...Array.from({ length: 8 }, (_, i) => listing(i + 1, `op${i + 1}`, [23, 24])), listing(9, 'old', [23]), node(10, 'none')];
  assert.equal(drawGuardians({ ...base, entries, candidateVersion: 24 }).eligible, 8);
  assert.equal(drawGuardians({ ...base, entries }).eligible, 10);
  const op = 'two', parts = [listing(11, op, [23]), listing(12, op, [23, 24])];
  assert.equal(drawGuardians({ ...base, nominal: 1, entries: parts, candidateVersion: 24 }).drawn[0].pubkey[0], 12, 'a lagging node of an operator is out, its other node stands');
  assert.equal(drawGuardians({ ...base, entries: entries.slice(0, 6), candidateVersion: 24 }).ok, false, 'too few left founds nothing');
});

test('the point decides by the trigger: below it plain forever, not named plain everywhere, under 12 blocks no records', () => {
  assert.equal(FOUNDING_PRESSURE_VERSION, 24);
  assert.deepEqual({ ...FOUNDING_PRESSURE_HEIGHT }, { mainnet: 0, testnet4: null, regtest: null }, 'nothing moves on a live network until a release names a height');
  assert.deepEqual([foundingPressurePoint('testnet4'), foundingPressurePoint('mainnet'), foundingPressurePoint('nowhere')], [null, 0, null]);
  assert.deepEqual([foundingRecordHeight(1000, 1000), foundingRecordHeight(999, 1000), foundingRecordHeight(1000, null)], [988, null, null]);
  assert.deepEqual([foundingRecordHeight(11, 0), foundingRecordHeight(12, 0)], [null, 0]);
  assert.deepEqual([foundingCandidateVersion(1000, 1000), foundingCandidateVersion(999, 1000), foundingCandidateVersion(1000, null), foundingCandidateVersion(5, 0)], [24, null, null, 24]);
});

test('pressure leaves a succession alone: the old guardians first whatever their bonds, the rule orders the missing seats', () => {
  const old = [node(1, 'opA', { bond: 50000n }), node(2, 'opB', { bond: 50000n }), node(3, 'opC', { bond: 50000n })];
  const rich = node(4, 'opD', { bond: 100000n });
  const entries = [...old, rich, ...Array.from({ length: 5 }, (_, i) => node(i + 5, `op${i + 5}`, { bond: 50000n }))];
  const d = drawGuardians({ ...base, nominal: 4, entries, seatedFirst: old, pressureBond: 100000n });
  assert.deepEqual(ids(d.drawn), ids([...old, rich]));
  assert.equal(d.seatedFirst, 3); assert.equal(d.atPressureBond, 1);
});

test('pressure does not lower or lift who may sit: too few eligible founds nothing, and a bond under the floor is not eligible at any B*_net', () => {
  const entries = [...Array.from({ length: 6 }, (_, i) => node(i + 1, `op${i + 1}`, { bond: 100000n })), node(7, 'small', { bond: 1000n })];
  const d = drawGuardians({ ...base, entries, pressureBond: 1000n });
  assert.equal(d.ok, false); assert.match(d.why, /not founded with fewer/);
});

test('B*_net that is not a positive amount is refused, not read as no pressure', () => {
  for (const pressureBond of [0n, -1n, 100000, '100000', true]) {
    const d = drawGuardians({ ...base, entries: pressured(), pressureBond });
    assert.equal(d.ok, false); assert.match(d.why, /B\*_net under pressure is a positive amount/);
  }
});
