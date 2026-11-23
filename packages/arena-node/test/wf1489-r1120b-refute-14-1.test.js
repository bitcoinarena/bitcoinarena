// kanban #3031 refute 1: the fix prefers an operator's node that holds bond_min_guardian ON ITS OWN. On the deployed defaults the
// census floor (BOND_MIN_DEFAULT_SATS, 50 000) and bond_min_guardian (server.js ARENA_BOND_MIN_GUARDIAN || 50000) are the same number,
// so a stranger's node AT THE CENSUS MINIMUM holds bond_min_guardian itself and, with a ground-low outpoint, still takes the honest
// operator's seat. The fix's own test passes only because it sets bond_min_guardian to 500 000.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawGuardians } from '../../arena-protocol/src/guardian-founding.js';
import { BOND_MIN_DEFAULT_SATS } from '../../arena-protocol/src/census-median.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const node = (n, op, { bond = 1000000n, txid = b32(0x40 + n) } = {}) =>
  ({ pubkey: b32(n), txid, vout: 0, bondSats: bond, advert: { operatorId: op, guardianCapable: true, guardianEndpoint: `wss://g${n}`, guardianOf: [] } });
const honest = Array.from({ length: 10 }, (_, i) => node(i + 1, `op${i + 1}`));
const ATTACKER = 0x90;

test('deployed defaults: a stranger at the census minimum borrowing op3 does not take op3\'s seat', () => {
  const bondMinGuardian = 50000n;                    // server.js: BigInt(process.env.ARENA_BOND_MIN_GUARDIAN || 50000)
  const censusMin = BOND_MIN_DEFAULT_SATS.testnet4;  // 50 000: the census floor
  let seed = null;
  for (let s = 1; s < 255 && !seed; s++) {
    const d = drawGuardians({ entries: honest, seed: b32(s), height: 160000, nominal: 7, bondMinGuardian });
    if (d.ok && d.drawn.some((e) => e.advert.operatorId === 'op3')) seed = b32(s);
  }
  assert.ok(seed);
  const squat = node(ATTACKER, 'op3', { bond: censusMin, txid: b32(0x00) });
  const d = drawGuardians({ entries: [...honest, squat], seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.equal(d.ok, true, d.why);
  const seated = [...d.drawn, ...d.alternates].map((e) => toHex(e.pubkey));
  const honestDraw = drawGuardians({ entries: honest, seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.equal(d.eligible, honestDraw.eligible + 1, 'the stranger is a ticket of its own, not grouped with op3');
  // naming op3 buys nothing: the draw is the same as with the stranger naming an id of its own
  const plain = drawGuardians({ entries: [...honest, { ...squat, advert: { ...squat.advert, operatorId: 'stranger' } }], seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.deepEqual(seated, [...plain.drawn, ...plain.alternates].map((e) => toHex(e.pubkey)), 'the stranger\'s draw does not depend on naming op3');
});

test('variant: a stranger with an honest-sized bond borrowing op3 does not evict op3\'s node', () => {
  const bondMinGuardian = 500000n;                   // the fix's own test value
  let seed = null;
  for (let s = 1; s < 255 && !seed; s++) {
    const d = drawGuardians({ entries: honest, seed: b32(s), height: 160000, nominal: 7, bondMinGuardian });
    if (d.ok && d.drawn.some((e) => e.advert.operatorId === 'op3')) seed = b32(s);
  }
  const squat = node(ATTACKER, 'op3', { bond: bondMinGuardian, txid: b32(0x00) });
  const d = drawGuardians({ entries: [...honest, squat], seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.equal(d.ok, true, d.why);
  const seated = [...d.drawn, ...d.alternates].map((e) => toHex(e.pubkey));
  const honestDraw = drawGuardians({ entries: honest, seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.equal(d.eligible, honestDraw.eligible + 1, 'the stranger is a ticket of its own, not grouped with op3');
  // naming op3 buys nothing: the draw is the same as with the stranger naming an id of its own
  const plain = drawGuardians({ entries: [...honest, { ...squat, advert: { ...squat.advert, operatorId: 'stranger' } }], seed, height: 160000, nominal: 7, bondMinGuardian });
  assert.deepEqual(seated, [...plain.drawn, ...plain.alternates].map((e) => toHex(e.pubkey)), 'the stranger\'s draw does not depend on naming op3');
});
