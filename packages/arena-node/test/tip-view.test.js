// THE WINDOW CHAIN FOLLOWS THE TIP (src/tip-view.js; testnet4 2026-09-30, series round fbd8294e agreed, posted and
// never final): a fake bitcoind whose chain grows and reorgs, and the view main.js hands `round.chainView`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tipHeaderView } from '../src/tip-view.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// A chain of 80-byte headers, each naming the one below it; `fork` changes a block's nonce from a height on.
function chain() {
  const hs = [];
  const add = (salt = 0) => {
    const h = new Uint8Array(80);
    if (hs.length) h.set(blockHashOf(hs[hs.length - 1]), 4);
    new DataView(h.buffer).setUint32(76, hs.length * 7 + salt, true);
    hs.push(h);
  };
  let calls = 0;
  const call = async (m, p) => {
    calls++;
    if (m === 'getblockcount') return hs.length - 1;
    if (m === 'getblockhash') return `${p[0]}`;
    if (m === 'getblockheader') return toHex(hs[Number(p[0])]);
    throw new Error(m);
  };
  return { hs, add, call, calls: () => calls, fork: (from) => { hs.length = from; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
// Let any read in flight end, move the clock one everyMs, ask (a read starts), let it end, and answer inside the same
// everyMs (no second read starts).
async function readNow(get, clock) {
  for (let i = 0; i < 50; i++) await settle();
  clock.t += 1000; get();
  for (let i = 0; i < 50; i++) await settle();
  return get();
}

test('the view grows with the tip, reads only the new blocks, and reads again past a reorg', async () => {
  const c = chain();
  for (let i = 0; i < 40; i++) c.add();
  const clock = { t: 0 };
  const get = tipHeaderView({ call: c.call, back: 20, everyMs: 1000, reorgDepth: 3, now: () => clock.t });
  assert.equal(get().pending, true, 'nothing is answered before the first read');
  let v = await readNow(get, clock);
  assert.equal(v.firstHeight, 19);
  assert.equal(v.firstHeight + v.blocks.length - 1, 39, 'to the tip');
  const before = c.calls();
  for (let i = 0; i < 5; i++) c.add();
  v = await readNow(get, clock);
  assert.equal(v.firstHeight + v.blocks.length - 1, 44, 'the new tip');
  assert.equal(c.calls() - before, 1 + 5 * 2, 'the count, then two calls for each new block only');
  const same = await readNow(get, clock);
  assert.equal(same, v, 'no new block, the same view (its readers index it once)');
  // A REORG: the last two blocks replaced, and one more on top
  c.fork(43); c.add(1); c.add(1); c.add(1);
  v = await readNow(get, clock);
  assert.equal(v.firstHeight + v.blocks.length - 1, 45);
  for (let i = 1; i < v.blocks.length; i++)
    assert.equal(toHex(v.blocks[i].header.subarray(4, 36)), toHex(blockHashOf(v.blocks[i - 1].header)), `block ${v.firstHeight + i} links`);
  assert.equal(toHex(v.blocks[v.blocks.length - 1].header), toHex(c.hs[45]), 'the new branch is held');
});

test('one read in flight, at most one per everyMs', async () => {
  const c = chain();
  for (let i = 0; i < 10; i++) c.add();
  const clock = { t: 0 };
  const get = tipHeaderView({ call: c.call, back: 5, everyMs: 30000, now: () => clock.t });
  get(); get(); get();
  for (let i = 0; i < 50; i++) await settle();
  const once = c.calls();
  assert.equal(once, 1 + 6 * 2, 'three asks, one read');
  c.add();
  clock.t += 29999; get();
  for (let i = 0; i < 50; i++) await settle();
  assert.equal(c.calls(), once, 'not again inside everyMs');
  clock.t += 1; get();
  for (let i = 0; i < 50; i++) await settle();
  assert.equal(c.calls(), once + 1 + 2);
});
