// THE CLAIMS ON A HALTED FEDERATION'S ESCROW (spec §23A.5 liquidation, kanban #323): notes at face first, pro rata only when the
// escrow is short, late ones from what is left until drain_blocks, and only then the remainder 75 / 25.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleClaims, REGTEST_CLOCKS } from '../src/federation-slash.js';

const clocks = REGTEST_CLOCKS;             // halt 1000: window to 1010, late claims to 1100, remainder from 1100
const signed = (c) => !c.forged;
const claim = (nonce, sat, height, extra = {}) => ({ nonce, amountMsat: BigInt(sat) * 1000n, height, ...extra });
const base = { haltHeight: 1000, clocks, noteSigned: signed };

test('enough escrow: every valid note at face value; the refused named; the remainder waits for drain_blocks', () => {
  const r = settleClaims({ ...base, escrowMsat: 1_000_000n, atHeight: 1010, spentNonces: ['bb'],
    claims: [claim('aa', 100, 1005), claim('bb', 50, 1005), claim('cc', 30, 1006, { forged: true }), claim('aa', 100, 1007), claim('dd', 20, 1101)] });
  assert.deepEqual(r.paid.map((p) => [p.nonce, p.msat]), [['aa', 100000n]]);
  assert.deepEqual(r.refused.map((x) => x.nonce), ['bb', 'cc', 'aa', 'dd']);
  assert.match(r.refused[0].why, /spent set/);
  assert.match(r.refused[1].why, /federation's signature/);
  assert.match(r.refused[2].why, /claimed before/);
  assert.match(r.refused[3].why, /after drain_blocks/);
  assert.deepEqual([r.proRata, r.rate, r.remainderMsat, r.split], [false, 1, 900000n, null], 'no split before 1100');
  const later = settleClaims({ ...base, escrowMsat: 1_000_000n, atHeight: 1100, spentNonces: [], claims: [claim('aa', 100, 1005)] });
  assert.deepEqual(later.split, { nodes: 675000n, developers: 225000n }, '75 / 25 of the 900 000 msat left');
});

test('a short escrow pays the window pro rata and says the rate; nothing is left for late claims or the nodes', () => {
  const r = settleClaims({ ...base, escrowMsat: 150_000n, atHeight: 1100, spentNonces: null,
    claims: [claim('aa', 100, 1002), claim('bb', 100, 1003), claim('cc', 50, 1050)] });
  assert.deepEqual(r.paid.map((p) => [p.nonce, p.msat, p.late]), [['aa', 75000n, false], ['bb', 75000n, false], ['cc', 0n, true]]);
  assert.deepEqual([r.proRata, r.rate, r.spentSetPublished, r.remainderMsat], [true, 0.75, false, 0n]);
  assert.deepEqual(r.split, { nodes: 0n, developers: 0n });
});

test('late notes are paid at face from what is left, in order of height, until it runs out', () => {
  const r = settleClaims({ ...base, escrowMsat: 200_000n, atHeight: 1050, spentNonces: [],
    claims: [claim('aa', 100, 1001), claim('late2', 80, 1060), claim('late1', 50, 1020)] });
  assert.deepEqual(r.paid.map((p) => [p.nonce, p.msat, p.late]), [['aa', 100000n, false], ['late1', 50000n, true], ['late2', 50000n, true]]);
  assert.equal(r.remainderMsat, 0n);
});
