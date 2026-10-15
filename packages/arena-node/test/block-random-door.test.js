// GET /block-random (kanban #366): a seat draws from its own chain, once the block is six deep - the protocol's numbers exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { blockRandom } from '../../arena-protocol/src/block-random.js';

test('the seat answers the block\'s numbers from its own chain, refuses a block too recent, and two seats agree', async () => {
  const hashes = new Map([[1000, '00000000000000000001aa'.padEnd(64, '7')], [1003, '00000000000000000001bb'.padEnd(64, '8')]]);
  const ballot = { tipHeight: async () => 1005, blockHashAt: async (h) => hashes.get(h) || null, votesAt: async () => [], censusAt: async () => null };
  const seats = [await serve(openStore(':memory:'), { port: 0, ballot }), await serve(openStore(':memory:'), { port: 0, ballot })];
  try {
    const ask = (s, q) => fetch(`http://127.0.0.1:${s.port}/block-random?${q}`);
    const answers = await Promise.all(seats.map(async (s) => (await ask(s, 'height=1000&label=round%20x&n=10&count=4')).json()));
    const want = blockRandom({ blockHashDisplay: hashes.get(1000), height: 1000, label: 'round x', n: 10, count: 4 });
    for (const a of answers) {
      assert.deepEqual({ height: a.height, blockHash: a.blockHash, label: a.label, n: a.n, seed: a.seed, numbers: a.numbers }, want);
      assert.equal(a.depth, 6);
    }
    const early = await ask(seats[0], 'height=1003&label=x&n=10');
    assert.equal(early.status, 409);
    assert.match(await early.text(), /3 deep and a block random number waits for 6: from tip 1008/);
    assert.equal((await ask(seats[0], 'height=abc&label=x&n=10')).status, 400);
    assert.equal((await ask(seats[0], 'height=1000&label=&n=10')).status, 400);
  } finally { for (const s of seats) await s.close(); }
});
