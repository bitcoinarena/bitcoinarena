// kanban #1489 refute of #1529: one seat must not decide what three honest seats agree on. The fix sets a seat that forks DEEPER
// than a tip split aside - but a seat that forks only in its last TIP_SPLIT_BLOCKS blocks is taken as a "tip split" wherever that
// split sits, and cuts the agreed chain at the block before it. So one seat answering an honest prefix (anchor .. block 10) plus
// 12 headers of its own (free, easiest target) cuts the chain every join is played under from 40 headers to 11: no census, no bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { agreedChain, TIP_SPLIT_BLOCKS } from '../src/headers.js';

function run(n, { previous = new Uint8Array(32), seed = 1 } = {}) {
  const out = []; let prev = previous;
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill((seed + i) & 0xff)], { previous: prev });
    out.push(header); prev = blockHashOf(header);
  }
  return out;
}
const provider = (headers, tag) => { const p = async () => headers; p.tag = tag; return p; };

test('one seat with a short fake "tip split" does not cut the chain three honest seats agree on', async () => {
  const honest = run(40, { seed: 1 });
  const liar = [...honest.slice(0, 11), ...run(TIP_SPLIT_BLOCKS, { previous: blockHashOf(honest[10]), seed: 120 })];
  const anchor = blockHashOf(honest[0]);
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, seen.why);
  // a real tip split leaves at most TIP_SPLIT_BLOCKS blocks of the most-work chain out
  assert.ok(seen.headers.length >= 40 - TIP_SPLIT_BLOCKS, `one seat cut the agreed chain to ${seen.headers.length} of 40 headers`);
});
