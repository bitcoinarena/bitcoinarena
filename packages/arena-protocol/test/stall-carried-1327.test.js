// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STALLED NODE IS OUT FOR A SEASON FROM ITS THIRD PROOF, CARRIED FORWARD BY CENSUS (§5A.3, rulings #1304 and #1350, kanban #1327).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { checkStallProof, stalledFrom, stallH3Of, STALL_SEASON_BLOCKS, stallWindow } from '../src/stall.js';

const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const N = hex(0x11), M = hex(0x22), ROOT = hex(0xaa), RID = hex(0xbb);
const H3 = 1000;
const earlierRound = { censusRoot: Uint8Array.from(Buffer.from(ROOT, 'hex')), censusHeight: H3 + 100 };
const base = { window: stallWindow(1_000_000_000n), verify: () => true, drawOf: () => null, certOf: () => null, weightOf: () => 1n,
  roundOf: (r) => (r === RID ? earlierRound : null), dutyOf: (r) => (r === RID ? { ok: true } : { ok: false, why: 'no duty posting' }) };
const carried = (over = {}) => ({ node: N, carried: { root: ROOT, roundId: RID, h3: H3, ...over } });

test('a carried stall stands through its season and ends at H3 + 12,960', () => {
  assert.equal(STALL_SEASON_BLOCKS, 12960);
  assert.deepEqual(checkStallProof([carried()], { ...base, censusHeight: H3 + 5000 }), { ok: true });
  assert.deepEqual(checkStallProof([carried()], { ...base, censusHeight: H3 + STALL_SEASON_BLOCKS - 1 }), { ok: true });
  const over = checkStallProof([carried()], { ...base, censusHeight: H3 + STALL_SEASON_BLOCKS });
  assert.equal(over.ok, false); assert.equal(over.proof, 'carried'); assert.match(over.why, /season out ended at block 13960/);
});

test('a carried stall is refused when its round names another census, is no duty posting\'s, or lies outside H3 .. this census', () => {
  const other = checkStallProof([carried({ root: hex(0xcc) })], { ...base, censusHeight: H3 + 500 });
  assert.match(other.why, /names another census/);
  const notDuty = checkStallProof([carried()], { ...base, censusHeight: H3 + 500, dutyOf: () => ({ ok: false, why: 'self-posted' }) });
  assert.equal(notDuty.proof, 'not-duty');
  assert.match(checkStallProof([carried({ h3: H3 + 200 })], { ...base, censusHeight: H3 + 500 }).why, /lies not between the third proof/);
  assert.match(checkStallProof([carried()], { ...base, censusHeight: H3 + 100 }).why, /lies not between/, 'the earlier census must be below this one');
  assert.match(checkStallProof([carried()], { ...base, censusHeight: null }).why, /read against a census height/);
  assert.equal(checkStallProof([carried()], { ...base, censusHeight: H3 + 500, roundOf: () => null }).notYet, true);
});

test('a seat holding the earlier claim reads the node in its stalled list with the same H3, from proofs or carried', () => {
  const heights = { [hex(0x01)]: H3 - 20, [hex(0x02)]: H3 - 10, [hex(0x03)]: H3 };
  const roundOf = (r) => (r === RID ? earlierRound : heights[r] !== undefined ? { censusHeight: heights[r] } : null);
  const withProofs = { stalled: [{ node: N, proofs: [hex(0x01), hex(0x02), hex(0x03)].map((roundId) => ({ roundId, seatRound: roundId, notes: [] })) }] };
  assert.equal(stallH3Of(withProofs.stalled[0], (r) => heights[r] ?? null), H3);
  assert.deepEqual(checkStallProof([carried()], { ...base, roundOf, censusHeight: H3 + 500, earlierClaimOf: () => withProofs }), { ok: true });
  assert.deepEqual(checkStallProof([carried()], { ...base, roundOf, censusHeight: H3 + 500, earlierClaimOf: () => ({ stalled: [carried()] }) }), { ok: true }, 'itself carried');
  assert.match(checkStallProof([carried()], { ...base, roundOf, censusHeight: H3 + 500, earlierClaimOf: () => ({ stalled: [{ node: M, carried: carried().carried }] }) }).why, /does not list/);
  assert.match(checkStallProof([carried({ h3: H3 - 50 })], { ...base, roundOf, censusHeight: H3 + 500, earlierClaimOf: () => withProofs }).why, /lists .* from block 1000, not 950/);
});

test('the poster carries a node it does not prove afresh, before any fresh one in the cap\'s order; a node out of the census is not carried', () => {
  const got = stalledFrom({ rounds: [], census: [N, M], window: base.window, weightOf: () => 1n, baseWeight: 100n, carried: [carried(), { node: hex(0x33), carried: carried().carried }] });
  assert.deepEqual(got, [carried()]);
});
