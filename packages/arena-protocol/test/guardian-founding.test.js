// GUARDIAN FOUNDING BY SORTITION (§23A.2, kanban #320): over the guardian-capable census, one ticket per operator, operators guarding an
// OPEN federation left out, bond_min_guardian held; nominal drawn and three alternates in order; a no-show replaced by the next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians, replaceNoShows } from '../src/guardian-founding.js';
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

test('what starts a founding: genesis at the first height with nominal operators, a draining federation, or 80 % load for abandon_blocks - the earliest (kanban #320)', async () => {
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

// SEATED FIRST (§23A.6 step 1, kanban #326): the old federation's seated, non-departing guardians first, in order; only the missing seats
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

test('the cohort (protocol 2026.0.14, #471 ruling 3): COHORT_NOMINAL free operators found their own federation while others exist', async () => {
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
