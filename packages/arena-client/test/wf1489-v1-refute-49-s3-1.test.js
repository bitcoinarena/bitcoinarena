// kanban #1489 refute of #1529 / #1713 / #1908 (skeptic 3): #1529 says one forking seat no longer refuses the chain three honest
// seats agree on. #1713 (094b0a415) added a second condition to a tip split - the most-work chain may leave at most
// TIP_SPLIT_BLOCKS blocks out - and with it, an honest answer is now a "fork" whenever the MOST-WORK source runs more than
// TIP_SPLIT_BLOCKS past the split. So the one seat that outweighs the honest tip (here: forks below the last honest block and
// answers 13+ headers of its own, with only one honest block's work - on testnet4 one minimum-difficulty block) turns all three
// honest answers into forks: agreed 1 < 2, ok: false, "no chain" for every join whose 4 sources picked it - #1529's effect again.
// At 85f803d70 the same answers were a tip split: ok, the 39 headers every source shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { agreedChain, TIP_SPLIT_BLOCKS } from '../src/headers.js';

const T0 = 1_760_000_000;
function run(n, { previous = new Uint8Array(32), seed = 1, bits, time0 = T0, step = 600 } = {}) {
  const out = []; let prev = previous;
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill((seed + i) & 0xff), new Uint8Array(32).fill(i >> 8)], { previous: prev, bits, time: time0 + i * step });
    out.push(header); prev = blockHashOf(header);
  }
  return out;
}
const provider = (headers, tag) => { const p = async () => headers; p.tag = tag; return p; };

test('one seat that outweighs only the honest tip block does not refuse the chain three honest seats agree on', async () => {
  // every honest block at a real (256x harder) target; the liar replaces the last one with 260 headers at the easiest target
  const HARD = [0x1f, 0x7f, 0xff, 0xff];
  const honest = run(40, { seed: 1, bits: HARD });
  const liar = [...honest.slice(0, 39), ...run(260, { previous: blockHashOf(honest[38]), seed: 150, time0: T0 + 39 * 600 + 60 })];
  const anchor = blockHashOf(honest[0]);
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, `one seat refused the chain three honest seats agree on: ${seen.why}`);
  assert.ok(seen.headers.length >= 39, `cut to ${seen.headers.length}`);
  for (let i = 0; i < seen.headers.length; i++)
    assert.ok(i < 40 && blockHashOf(seen.headers[i]).every((b, k) => b === blockHashOf(honest[i])[k]), `block ${i} is the liar's`);
});

test('the same with a minimum-difficulty honest tip (testnet4): TIP_SPLIT_BLOCKS + 1 free headers are enough', async () => {
  const HARD = [0x1f, 0x7f, 0xff, 0xff];
  const honest = [...run(39, { seed: 1, bits: HARD })];
  honest.push(...run(1, { previous: blockHashOf(honest[38]), seed: 90, time0: T0 + 39 * 600 + 1200 }));   // easiest target, like the liar's
  const liar = [...honest.slice(0, 39), ...run(TIP_SPLIT_BLOCKS + 1, { previous: blockHashOf(honest[38]), seed: 150, time0: T0 + 39 * 600 + 60 })];
  const anchor = blockHashOf(honest[0]);
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, `one seat refused the chain three honest seats agree on: ${seen.why}`);
});
