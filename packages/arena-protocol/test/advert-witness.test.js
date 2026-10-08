// THE ADVERTISEMENT RIDES IN PIECES, AND THE CENSUS STILL READS IT BACK.
//
// Measured on a real node (regtest, same standardness policy as testnet4 and mainnet): a bond whose
// witness carried the whole 266-byte signed body in ONE item was refused `bad-witness-nonstandard` -
// Bitcoin Core holds a TAPSCRIPT witness stack item to 80 bytes, not only a P2WSH one, and the spend here
// is `witness_v1_taproot`. Split into pieces of at most 80 the same transaction is `allowed=true`.
//
// No advertisement field was cut to get there and the signature keeps its own item: these tests hold both
// halves of that - every piece within the limit, and the body still recoverable from the pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { witnessItemsOf, witnessRunsOf } from '../src/tx.js';

const TAPSCRIPT_ITEM_LIMIT = 80;
const chunksOf = (body, size = TAPSCRIPT_ITEM_LIMIT) => {
  const out = [];
  for (let at = 0; at < body.length; at += size) out.push(body.subarray(at, Math.min(at + size, body.length)));
  return out;
};
const body = Uint8Array.from({ length: 266 }, (_, i) => (i * 7 + 3) & 0xff);
const sig = new Uint8Array(64).fill(9);
const script = new Uint8Array(38).fill(1);
const control = new Uint8Array(33).fill(2);
/** The stack the bond builds: signature, then the body's pieces, then script and control block. */
const bondStack = () => [sig, ...chunksOf(body), script, control];

test('every witness stack item of a chunked bond is within the 80-byte tapscript limit', () => {
  const stack = bondStack();
  for (const [i, item] of stack.entries())
    assert.ok(item.length <= TAPSCRIPT_ITEM_LIMIT,
      `item ${i} is ${item.length} bytes, over the ${TAPSCRIPT_ITEM_LIMIT} a node will relay`);
  // AND THE BODY IS STILL WHOLE: 266 bytes in four pieces, not a byte cut from the advertisement.
  const pieces = chunksOf(body);
  assert.equal(pieces.length, 4);
  assert.deepEqual(pieces.map((p) => p.length), [80, 80, 80, 26]);
  assert.equal(pieces.reduce((a, p) => a + p.length, 0), body.length);
});

test('the body is read back by joining consecutive items, and single-item bodies still are', () => {
  const runs = witnessRunsOf({ witnesses: [bondStack()] });
  const has = (want) => runs.some((r) => r.length === want.length && r.every((b, i) => b === want[i]));
  assert.ok(has(body), 'the joined pieces do not reproduce the body the bond signed');

  // EVERY BOND POSTED BEFORE THIS carried the body in one item, and is still found - single items are
  // yielded first and unchanged, so nothing that used to resolve stops resolving.
  const old = witnessRunsOf({ witnesses: [[sig, body, script, control]] });
  assert.ok(old.slice(0, 4).some((r) => r.length === body.length && r.every((b, i) => b === body[i])),
    'a one-item body is no longer among the first items offered');
  assert.deepEqual(witnessItemsOf({ witnesses: [[sig, body]] }).map((i) => i.length), [64, 266],
    'witnessItemsOf stopped reporting the raw items');
});

test('joining items that were never one body yields nothing that decodes as an advertisement', () => {
  // The runs are offered, not believed: census and chain both require the run's advertId to equal a
  // 32-byte commitment in the transaction's own outputs before anything is taken from it. Here the point
  // is only that joining is bounded and total - it never throws and never loses the singles.
  const stack = [new Uint8Array(10).fill(1), new Uint8Array(20).fill(2), new Uint8Array(30).fill(3)];
  const runs = witnessRunsOf({ witnesses: [stack] });
  assert.equal(runs.length, 3 + 3, 'three items should give three singles and three consecutive runs');
  assert.deepEqual(runs.slice(0, 3).map((r) => r.length), [10, 20, 30]);
  assert.deepEqual(runs.slice(3).map((r) => r.length).sort((a, b) => a - b), [30, 50, 60]);
});
