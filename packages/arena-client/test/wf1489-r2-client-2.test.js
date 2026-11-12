// kanban #1489 round 2: the join's chain is read from 4 seats picked at random (join.js headerSources -> directory.js reach ->
// agreedChain, least 2, no second pick). One of them answering the real chain cut 13 blocks below the tip plus 13 headers of its own
// (mined at the easiest target it claims itself - free) must not refuse the chain the three honest seats agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { agreedChain } from '../src/headers.js';

function run(n, { previous = new Uint8Array(32), seed = 1 } = {}) {
  const out = []; let prev = previous;
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill((seed + i) & 0xff)], { previous: prev });
    out.push(header); prev = blockHashOf(header);
  }
  return out;
}
const provider = (headers, tag) => { const p = async () => headers; p.tag = tag; return p; };

test('one forking seat out of four does not refuse the chain three honest seats agree on', async () => {
  const honest = run(40, { seed: 1 });
  // the liar: honest blocks 0..26, then 12 of its own (one block less work than the honest 40, stray 12+1 deep below the tip)
  const liar = [...honest.slice(0, 26), ...run(13, { previous: blockHashOf(honest[25]), seed: 120 })];
  const anchor = blockHashOf(honest[0]);
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.headers.length, 40);
});
