// A ROUND EXISTS ONLY ONCE ITS HASH IS ON BITCOIN, BELOW ITS BEACON BLOCK
// (5A.5, v4.6.2, P1). The transaction is built and parsed the way a node reads
// a block, so what is checked is bytes a chain would carry, not an object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, toHex } from '../src/hash.js';
import { parseTransaction } from '../src/tx.js';
import { serializeSpend } from '../src/bond-spend.js';
import {
  publicationPayload, publicationOutput, publishesRound, publicationIsBeforeBeacon, findPublication,
  PUBLICATION_BYTES, PUBLICATION_KIND_ROUND,
} from '../src/publication.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0xaa);

const txWith = (outputs) => parseTransaction(serializeSpend({
  inputs: [{ txid: b32(0x22), vout: 0, sequence: 0xffffffff }],
  outputs: [{ value: 5000n, script: fromHex('0014' + '33'.repeat(20)) }, ...outputs],
  witnesses: [[new Uint8Array(64)]],
}));

test('the payload is "BLW", ROUND and the round id - 36 bytes', () => {
  const p = publicationPayload(RID);
  assert.equal(p.length, PUBLICATION_BYTES);
  assert.equal(toHex(p.slice(0, 3)), toHex(new TextEncoder().encode('BLW')));
  assert.equal(p[3], PUBLICATION_KIND_ROUND);
  assert.equal(toHex(p.slice(4)), toHex(RID));
  assert.throws(() => publicationPayload(new Uint8Array(31)), /32-byte round id/);

  const out = publicationOutput(RID);
  assert.equal(out.value, 0n, 'a publication is a commitment, not money');
  assert.equal(toHex(out.script), '6a24' + toHex(p));
});

test('a transaction carrying the output publishes that round and no other', () => {
  const tx = txWith([publicationOutput(RID)]);
  assert.equal(publishesRound(tx, RID), true);
  assert.equal(publishesRound(tx, b32(0xab)), false);
  assert.equal(publishesRound(txWith([]), RID), false);

  // a vote-shaped push that begins with the same bytes is not a publication:
  // the length is part of the form
  const longer = new Uint8Array(40); longer.set(publicationPayload(RID));
  assert.equal(publishesRound(txWith([{ value: 0n, script: Uint8Array.from([0x6a, 40, ...longer]) }]), RID),
    false);
});

test('a publication counts only strictly below the beacon block, and never without heights', () => {
  const tx = txWith([publicationOutput(RID)]);
  assert.deepEqual(publicationIsBeforeBeacon({ roundId: RID, tx, txHeight: 99, beaconHeight: 100 }),
    { ok: true, txHeight: 99, beaconHeight: 100 });

  for (const txHeight of [100, 101])
    assert.match(publicationIsBeforeBeacon({ roundId: RID, tx, txHeight, beaconHeight: 100 }).why,
      /at or after its beacon block 100/);
  assert.match(publicationIsBeforeBeacon({ roundId: RID, tx, beaconHeight: 100 }).why, /names no height/);
  assert.match(publicationIsBeforeBeacon({ roundId: RID, tx, txHeight: 99 }).why, /no beacon height/);
  assert.match(publicationIsBeforeBeacon({ roundId: b32(0xab), tx, txHeight: 99, beaconHeight: 100 }).why,
    /does not carry OP_RETURN "BLW" ROUND/);
  assert.match(publicationIsBeforeBeacon({ roundId: RID, txHeight: 99, beaconHeight: 100 }).why,
    /no publication transaction/);
});

test('a node finds the publication in its own chain view, at the lowest height it confirmed', () => {
  const rawWith = (outputs) => serializeSpend({
    inputs: [{ txid: b32(0x22), vout: 0, sequence: 0xffffffff }],
    outputs: [{ value: 5000n, script: fromHex('0014' + '33'.repeat(20)) }, ...outputs],
    witnesses: [[new Uint8Array(64)]],
  });
  const view = {
    firstHeight: 200,
    blocks: [
      { transactions: [rawWith([])] },
      { transactions: [new Uint8Array([1, 2, 3]), rawWith([publicationOutput(RID)])] },
      { transactions: [rawWith([publicationOutput(RID)])] },
    ],
  };
  const found = findPublication(view, RID);
  assert.equal(found.height, 201, 'not the lowest publication, or not the chain\'s height');
  assert.equal(publishesRound(found.tx, RID), true);
  assert.equal(findPublication(view, b32(0xab)), null);
  assert.equal(findPublication({ blocks: [] }, RID), null, 'a view with no first height named a height');
});
