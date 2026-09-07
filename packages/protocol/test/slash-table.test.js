// 5A.3 ROW 3: A PAYOUT TABLE THAT IS NOT F OF ITS PUBLISHED INPUTS.
//
// §20: "PayoutTable = F(RoundContract, Membership, FinalResults).
// Deterministic. Nodes sign the payout-table hash; 5-of-7 matching signatures
// make it final. A node signing a table that does not equal F(...) of its
// published inputs is slashable."
//
// NOTHING IS INJECTED, which is what separates this row from the replay one.
// `F` is `computePayoutTable` and it lives in this package, so no attesting
// party is needed and 5A.3B's residual - an attester who "can, in principle,
// slash without cause" - does not reach here at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  computePayoutTable, encodePayoutTable, decodePayoutTable, payoutTableId,
} from '../src/payout.js';
import {
  slashHoldsOnTable, payoutInputsId, slashCommitment, TABLE_IS_NOT_F,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];

// Two winners, two losers: a pool that actually divides and rows that are not
// all zero, so a tampered amount has something to be wrong against.
const entries = [
  { pubkey: b32(0xa1), outcome: 'DELIVERED', score: 900, stakeMsat: 100000n },
  { pubkey: b32(0xa2), outcome: 'DELIVERED', score: 500, stakeMsat: 100000n },
  { pubkey: b32(0xa3), outcome: 'FAILED', score: 0, stakeMsat: 100000n },
  { pubkey: b32(0xa4), outcome: 'FORFEIT', score: 0, stakeMsat: 100000n },
];
const MIN = 100;

const honest = () => computePayoutTable({ roundId: ROUND, entries, minScore: MIN });
const tableOf = (rows) => encodePayoutTable({ roundId: ROUND, table: rows });
const inputs = () => payoutInputsId({ roundId: ROUND, entries, minScore: MIN });

const proofFor = (bytes, over = {}) => ({
  roundId: ROUND, playerPubkey: b32(0xa1), nodePubkey: NODE,
  transcriptHash: inputs(), signedResultId: payoutTableId(decodePayoutTable(bytes)),
  bondTxid: BOND, bondVout: 3, ...over,
});
const advert = { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 };
const ask = (bytes, over = {}) => slashHoldsOnTable({
  proof: proofFor(bytes), signedTable: bytes, advert, committee,
  entries, minScore: MIN, ...over,
});

/**
 * THE BEFORE AND AFTER. The same node, the same bond, the same published
 * inputs - and the only thing that moves is one number in the table it signed.
 */
test('a table that is not F of its published inputs slashes the named bond', () => {
  const right = tableOf(honest().table);
  const before = ask(right);
  assert.equal(before.slashed, false, 'an honest table was slashed');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED for one');
  assert.match(before.why, /exactly F of its published inputs/);

  // one millisatoshi, moved from a winner to nobody
  const wrong = honest().table.map((r, i) =>
    (i === 0 ? { ...r, amountMsat: r.amountMsat - 1n } : r));
  const after = ask(tableOf(wrong));
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, TABLE_IS_NOT_F);
  assert.equal(toHex(after.bond.txid), toHex(BOND));
  assert.equal(after.bond.vout, 3);
  assert.equal(toHex(after.expected), toHex(payoutTableId({ roundId: ROUND, table: honest().table })),
    'and it says what F actually was, so the accusation is checkable');
  assert.equal(toHex(after.commitment), toHex(slashCommitment(proofFor(tableOf(wrong)))));
});

test('a millisatoshi moved between two players is still not F', () => {
  const rows = honest().table.map((r) => ({ ...r }));
  const from = rows.findIndex((r) => r.amountMsat > 0n);
  const to = rows.findIndex((r, i) => i !== from);
  rows[from].amountMsat -= 1n;
  rows[to].amountMsat += 1n;
  const seen = ask(tableOf(rows));
  assert.equal(seen.slashed, true, 'a table that still sums correctly is not therefore F');
});

/**
 * AND THE ORDER IS NOT AN OFFENCE. Two honest nodes handed the same entries in
 * a different order must sign the same bytes, or `F` being deterministic buys
 * nothing at all.
 */
test('the same table in another order is the same table', () => {
  const rows = [...honest().table].reverse();
  assert.equal(toHex(payoutTableId({ roundId: ROUND, table: rows })),
               toHex(payoutTableId({ roundId: ROUND, table: honest().table })));
  assert.equal(ask(tableOf(rows)).slashed, false, 'a node was slashed for row order');
});

test('the round is inside the table, so a signature cannot cross rounds', () => {
  const here = payoutTableId({ roundId: ROUND, table: honest().table });
  const there = payoutTableId({ roundId: b32(0x02), table: honest().table });
  assert.notEqual(toHex(here), toHex(there));

  const elsewhere = encodePayoutTable({ roundId: b32(0x02), table: honest().table });
  const no = slashHoldsOnTable({
    proof: proofFor(elsewhere), signedTable: elsewhere, advert, committee,
    entries, minScore: MIN,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /different round/);
});

/**
 * THE INPUTS ARE THE NODE'S, NOT THE ACCUSER'S.
 *
 * Recomputing from whatever membership suits the accuser makes every honest
 * table slashable, so the proof is bound to the inputs by a hash and a
 * mismatch is refused rather than recomputed.
 */
test('an accuser cannot swap the inputs F is recomputed from', () => {
  const right = tableOf(honest().table);
  const theirs = [...entries.slice(0, 3),
                  { pubkey: b32(0xa4), outcome: 'DELIVERED', score: 900, stakeMsat: 100000n }];

  const swapped = slashHoldsOnTable({
    proof: proofFor(right), signedTable: right, advert, committee,
    entries: theirs, minScore: MIN,
  });
  assert.equal(swapped.slashed, false);
  assert.match(swapped.why, /bound to different inputs/);

  // and the floor is one of the inputs, not a free argument
  const floorMoved = slashHoldsOnTable({
    proof: proofFor(right), signedTable: right, advert, committee,
    entries, minScore: 600,
  });
  assert.equal(floorMoved.slashed, false);
  assert.match(floorMoved.why, /bound to different inputs/);

  assert.equal(ask(right, { entries: [] }).slashed, false);
  assert.match(ask(right, { entries: [] }).why, /no published inputs/);
});

test('the evidence has to be the table the proof names', () => {
  const right = tableOf(honest().table);
  const wrong = tableOf(honest().table.map((r, i) =>
    (i === 0 ? { ...r, amountMsat: r.amountMsat - 1n } : r)));

  const mismatched = slashHoldsOnTable({
    proof: proofFor(right), signedTable: wrong, advert, committee, entries, minScore: MIN,
  });
  assert.equal(mismatched.slashed, false);
  assert.match(mismatched.why, /not the one this proof names/);

  for (const bad of [undefined, new Uint8Array(0), new Uint8Array(9)]) {
    const no = slashHoldsOnTable({
      proof: proofFor(right), signedTable: bad, advert, committee, entries, minScore: MIN,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, /no signed table|not a payout table/);
  }
});

test('the accuser cannot name a bond the node never advertised', () => {
  const wrong = tableOf(honest().table.map((r, i) =>
    (i === 0 ? { ...r, amountMsat: r.amountMsat - 1n } : r)));

  const someoneElses = slashHoldsOnTable({
    proof: proofFor(wrong, { bondTxid: b32(0x99) }), signedTable: wrong,
    advert, committee, entries, minScore: MIN,
  });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = slashHoldsOnTable({
    proof: proofFor(wrong, { bondVout: 4 }), signedTable: wrong,
    advert, committee, entries, minScore: MIN,
  });
  assert.equal(wrongVout.slashed, false, 'a different output is a different bond');
  assert.equal(ask(wrong, { advert: undefined }).slashed, false);
});

test('a stranger cannot be slashed for a round they were not serving', () => {
  const wrong = tableOf(honest().table.map((r, i) =>
    (i === 0 ? { ...r, amountMsat: r.amountMsat - 1n } : r)));
  const no = slashHoldsOnTable({
    proof: proofFor(wrong, { nodePubkey: b32(0x66) }), signedTable: wrong,
    advert: { nodePubkey: b32(0x66), bondTxid: BOND, bondVout: 3 },
    committee, entries, minScore: MIN,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /is not on this round's committee/);
  assert.equal(ask(wrong, { committee: [] }).slashed, false);
});

/**
 * INPUTS NOBODY CAN USE ARE REFUSED, NOT THROWN.
 *
 * Money here is BigInt millisatoshi and a number is not money, so an accuser
 * handing in entries with a float stake gets an answer rather than an
 * exception. Measured while writing this: it threw `u64 needs a BigInt` out of
 * the commitment, which hands a caller that asked for a verdict a crash - and
 * the caller least able to cope with that is a node acting on somebody else's
 * accusation.
 */
test('inputs that cannot be used are refused, not counted as an offence', () => {
  const broken = [{ pubkey: b32(0xa1), outcome: 'DELIVERED', score: 900, stakeMsat: 100000 }];
  const bytes = tableOf(honest().table);
  let no;
  assert.doesNotThrow(() => {
    no = slashHoldsOnTable({
      proof: proofFor(bytes), signedTable: bytes, advert, committee,
      entries: broken, minScore: MIN,
    });
  }, 'a decision function raised where it was asked for a verdict');
  assert.equal(no.slashed, false);
  assert.match(no.why, /cannot be committed to/);
});

test('the table survives the round trip and a changed row changes its hash', () => {
  const t = { roundId: ROUND, table: honest().table };
  const back = decodePayoutTable(encodePayoutTable(t));
  assert.equal(toHex(back.roundId), toHex(ROUND));
  assert.equal(back.table.length, t.table.length);
  assert.equal(toHex(payoutTableId(back)), toHex(payoutTableId(t)));

  const longer = new Uint8Array(encodePayoutTable(t).length + 1);
  longer.set(encodePayoutTable(t));
  assert.throws(() => decodePayoutTable(longer), /trailing bytes/);
});

test('every input is inside the hash a proof binds to', () => {
  const was = toHex(inputs());
  assert.notEqual(toHex(payoutInputsId({ roundId: b32(0x02), entries, minScore: MIN })), was);
  assert.notEqual(toHex(payoutInputsId({ roundId: ROUND, entries, minScore: MIN + 1 })), was);
  for (const [field, value] of [['outcome', 'FAILED'], ['score', 901], ['stakeMsat', 1n],
                                ['pubkey', b32(0xb1)]]) {
    const moved = entries.map((e, i) => (i === 0 ? { ...e, [field]: value } : e));
    assert.notEqual(toHex(payoutInputsId({ roundId: ROUND, entries: moved, minScore: MIN })),
      was, field);
  }
  // and the order of the entries is not one of them
  assert.equal(toHex(payoutInputsId({ roundId: ROUND, entries: [...entries].reverse(), minScore: MIN })),
    was, 'two nodes publishing the same membership must bind to the same bytes');
});
