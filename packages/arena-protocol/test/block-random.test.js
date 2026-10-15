// A RANDOM NUMBER FROM A RECENT BITCOIN BLOCK THAT EVERY NODE CAN REPRODUCE (kanban #366).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockRandomSeed, blockRandomInt, blockRandomStream, blockRandomReady, blockRandom, blockRandomStands, blockHashFromDisplay,
  BLOCK_RANDOM_DEPTH, BLOCK_RANDOM_N_MAX } from '../src/block-random.js';
import { toHex } from '../src/hash.js';

// testnet4 block 156648 (the beacon of B's successor founding, kanban #326) - any 32-byte hash would do; a real one reads better
const HASH = '000000000000000ab1e2b8a7c3f4e5d6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c';

test('the same block, height and label give the same numbers anywhere; another label, height or block gives others', () => {
  const a = blockRandom({ blockHashDisplay: HASH, height: 156648, label: 'round 1a2b', n: 6, count: 5 });
  const b = blockRandom({ blockHashDisplay: HASH.toUpperCase(), height: 156648, label: 'round 1a2b', n: 6, count: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.numbers.length, 5);
  assert.ok(a.numbers.every((x) => BigInt(x) >= 0n && BigInt(x) < 6n));
  console.log('  VECTOR:', JSON.stringify(a));
  // pinned: a change to the derivation is a change every node must make at once
  assert.equal(a.seed, toHex(blockRandomSeed({ blockHash: blockHashFromDisplay(HASH), height: 156648, label: 'round 1a2b' })));
  assert.notEqual(blockRandom({ blockHashDisplay: HASH, height: 156648, label: 'round 1a2c', n: 6 }).seed, a.seed, 'another label');
  assert.notEqual(blockRandom({ blockHashDisplay: HASH, height: 156649, label: 'round 1a2b', n: 6 }).seed, a.seed, 'another height');
  assert.notEqual(blockRandom({ blockHashDisplay: HASH.replace(/c$/, 'd'), height: 156648, label: 'round 1a2b', n: 6 }).seed, a.seed, 'another block');
  assert.deepEqual(blockRandomStream(fromSeed(a.seed), 6, 5).map(String), a.numbers, 'the stream is index 0..count-1');
  assert.throws(() => blockRandomSeed({ blockHash: new Uint8Array(31), height: 1, label: 'x' }), /32-byte hash/);
  assert.throws(() => blockRandomSeed({ blockHash: new Uint8Array(32), height: 1, label: '' }), /names what it is for/);
});
const fromSeed = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

test('every value of [0, n) is as likely: no modulo bias, the whole range reached, the widest n allowed', () => {
  const seed = blockRandomSeed({ blockHash: blockHashFromDisplay(HASH), height: 156648, label: 'uniform' });
  const counts = [0, 0, 0];
  const N = 30000;
  for (let i = 0; i < N; i++) counts[Number(blockRandomInt(seed, 3, i))]++;
  for (const c of counts) assert.ok(Math.abs(c - N / 3) < 5 * Math.sqrt(N * (1 / 3) * (2 / 3)), `counts ${counts} are not even`);
  assert.equal(blockRandomInt(seed, 1, 0), 0n);
  const big = blockRandomInt(seed, BLOCK_RANDOM_N_MAX, 0);
  assert.ok(big >= 0n && big < BLOCK_RANDOM_N_MAX);
  assert.throws(() => blockRandomInt(seed, 0), /n from 1/);
  assert.throws(() => blockRandomInt(seed, BLOCK_RANDOM_N_MAX + 1n), /n from 1/);
  console.log(`  UNIFORM: n=3 over ${N} draws -> ${counts.join(' / ')}`);
});

test('a block is used only once it is buried six deep; another chain\'s answer is refused', () => {
  assert.equal(BLOCK_RANDOM_DEPTH, 6);
  assert.deepEqual(blockRandomReady({ height: 100, tipHeight: 105 }), { ok: true, depth: 6 });
  const early = blockRandomReady({ height: 100, tipHeight: 104 });
  assert.equal(early.ok, false); assert.equal(early.ready, 105); assert.match(early.why, /5 deep and a block random number waits for 6: from tip 105/);
  assert.match(blockRandomReady({ height: 100, tipHeight: 99 }).why, /not mined yet/);
  const claimed = blockRandom({ blockHashDisplay: HASH, height: 156648, label: 'round 1a2b', n: 100, count: 3 });
  assert.deepEqual(blockRandomStands(claimed, { blockHashDisplay: HASH }), { ok: true });
  assert.match(blockRandomStands(claimed, { blockHashDisplay: HASH.replace(/c$/, 'e') }).why, /on this chain, and the answer names/);
  assert.match(blockRandomStands({ ...claimed, numbers: ['1', '2', '3'] }, { blockHashDisplay: HASH }).why, /not the ones this block gives/);
});
