// Audit census r3 #1: the founding draw groups census entries by the SELF-DECLARED advert operatorId. A stranger's own bonded
// node that names an honest operator's id (and a lower bond outpoint) takes that operator's ticket and summed bond in the
// draw, and the same squat with a guardian_of[] naming any federation no seat holds removes the honest operator from every draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians } from '../../arena-protocol/src/guardian-founding.js';
import { guardingOpenOf } from '../src/founding-seat.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const node = (n, op, { bond = 1000000n, txid = b32(0x40 + n), guardianOf = [] } = {}) =>
  ({ pubkey: b32(n), txid, vout: 0, bondSats: bond, operator: op, advert: { operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, guardianOf } });

const honest = Array.from({ length: 10 }, (_, i) => node(i + 1, `op${i + 1}`));
const ATTACKER = 0x90;

test('a node under bond_min_guardian that borrows an honest operator id is not seated on that operator\'s bond', () => {
  const bondMinGuardian = 500000n;
  // a seed whose draw seats op3's honest node
  let seed = null;
  for (let s = 1; s < 255 && !seed; s++) {
    const d = drawGuardians({ entries: honest, seed: b32(s), height: 160000, nominal: 7, bondMinGuardian });
    if (d.ok && d.drawn.some((e) => e.advert.operatorId === 'op3')) seed = b32(s);
  }
  assert.ok(seed, 'a seed that draws op3');
  // the attacker's own node, its own signed advert naming operatorId 'op3', 50 000 sats (under bond_min_guardian), txid ground low
  const squat = node(ATTACKER, 'op3', { bond: 50000n, txid: b32(0x00) });
  const d = drawGuardians({ entries: [...honest, squat], seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.equal(d.ok, true, d.why);
  const seated = [...d.drawn, ...d.alternates].map((e) => toHex(e.pubkey));
  assert.ok(!seated.includes(toHex(b32(ATTACKER))), 'the stranger\'s node, under bond_min_guardian on its own, is not seated on op3\'s ticket and bond');
  assert.ok(seated.includes(toHex(b32(3))), 'op3\'s own node keeps its seat');
});

test('a stranger node that borrows an honest operator id cannot mark that operator as guarding a federation', () => {
  // the honest op3 guards nothing; the stranger's node names 'op3' and a federation id no seat holds a record of
  const squat = node(ATTACKER, 'op3', { bond: 50000n, guardianOf: [{ federationId: b32(0xee) }] });
  const out = guardingOpenOf({ entries: [...honest, squat], held: [] });
  assert.ok(!out.has('op3'), 'op3 stays in the free pool: it is held back only by its own nodes\' adverts');
});

