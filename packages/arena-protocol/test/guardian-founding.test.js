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
