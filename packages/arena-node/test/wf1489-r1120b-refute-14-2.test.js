// kanban #3031 refute 2 (honest path / spec §23A.2 "minus operators already guarding an OPEN federation, one ticket per operator"):
// the fix turned a claim on a federation this seat holds no record of from an OPERATOR hold-back into a NODE hold-back. An honest
// operator with two nodes, one of which guards a federation this seat has no record of (kanban #585: a restarted seat before its
// records are back, or one that never received that record), now has its OTHER node drawn into a new federation - the operator ends
// up guarding two federations, and seats that hold the record and seats that do not disagree on whether the operator is free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians } from '../../arena-protocol/src/guardian-founding.js';
import { guardingOpenOf } from '../src/founding-seat.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const node = (n, op, { bond = 1000000n, guardianOf = [] } = {}) =>
  // kanban #3156: the operator as the census binds it (#3385: `operator` is set only for a binding the operator key signed)
  ({ pubkey: b32(n), txid: b32(0x40 + n), vout: 0, bondSats: bond, operator: op, advert: { operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, guardianOf } });

test('an operator whose own node guards a federation not held stays out of the draw (operator, not node)', () => {
  const X = b32(0xee);
  const entries = [...Array.from({ length: 9 }, (_, i) => node(i + 1, `op${i + 1}`)),
    node(0x21, 'opZ', { guardianOf: [{ federationId: X }] }), node(0x22, 'opZ')];
  const out = guardingOpenOf({ entries, held: [] });
  const d = drawGuardians({ entries, seed: b32(7), height: 160000, nominal: 7, bondMinGuardian: 50000n, guardingOpen: out });
  assert.equal(d.ok, true, d.why);
  const seatedOps = [...d.drawn, ...d.alternates].map((e) => e.advert.operatorId);
  assert.ok(!seatedOps.includes('opZ'), `opZ guards ${toHex(X).slice(0, 8)} (no record here) and is not drawn into another federation; set=${[...out]}`);
});
