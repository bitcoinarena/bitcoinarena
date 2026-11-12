// kanban #1489 refute of #1529 / #1713 (skeptic 2): the fix says the chain stands only while max(least, 2) sources agree on every
// block it holds, the most-work one included. That holds for a seat that forks or splits - not for the seat that IS the most-work
// source. Headers claim their own target (chainWork checks only that a hash meets the target written in it), so one seat answering
// the honest chain plus any number of free headers at the easiest target on top of the honest tip has more work than the honest
// chain; the three honest answers are then a prefix of it ("omission"), and the free tail - held by that one seat alone - is the
// agreed chain, agreed: 4, ok: true. Its timestamps and hashes are the seat's to choose, so it chooses the round's beacon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256 } from '../../arena-protocol/src/tx.js';
import { blockOf } from '../../arena-protocol/tools/bond.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { agreedChain, TIP_SPLIT_BLOCKS } from '../src/headers.js';

const T0 = 1_760_000_000;
function run(n, { previous = new Uint8Array(32), seed = 1, bits, time0 = T0, step = 600 } = {}) {
  const out = []; let prev = previous;
  for (let i = 0; i < n; i++) {
    const { header } = blockOf(hash256, [new Uint8Array(32).fill((seed + i) & 0xff)], { previous: prev, bits, time: time0 + i * step });
    out.push(header); prev = blockHashOf(header);
  }
  return out;
}
const provider = (headers, tag) => { const p = async () => headers; p.tag = tag; return p; };

// honest blocks are mined at a real (here: 256x harder) target; the liar's are free
const HARD = [0x1f, 0x7f, 0xff, 0xff];
const honest = run(40, { seed: 1, bits: HARD });
const liarTail = run(3 * TIP_SPLIT_BLOCKS, { previous: blockHashOf(honest[39]), seed: 150, time0: T0 + 40 * 600 + 7200, step: 7200 });
const liar = [...honest, ...liarTail];
const anchor = blockHashOf(honest[0]);

test('one seat with free headers on top of the honest tip does not become the agreed chain', async () => {
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, seen.why);
  // the fix's own rule: need = max(least, 2) sources agree on every block the chain holds
  assert.ok(seen.headers.length <= 40 + TIP_SPLIT_BLOCKS,
    `one seat alone extended the agreed chain from 40 to ${seen.headers.length} headers (agreed: ${seen.agreed}, from provider ${seen.from})`);
});

test('one seat does not get to choose the round\'s beacon with free headers', async () => {
  const seen = await agreedChain([provider(honest, 'a'), provider(liar, 'evil'), provider(honest, 'b'), provider(honest, 'c')], { least: 2, anchor });
  assert.equal(seen.ok, true, seen.why);
  // a committee time after every honest block: the honest chain has no beacon yet
  const contract = { committeeTimeMs: BigInt(T0 + 40 * 600 + 3600) * 1000n, censusConfirmations: 6 };
  assert.equal(beaconFromChain(contract, { headers: honest, firstHeight: 0 }).ok, false);
  const beacon = beaconFromChain(contract, { headers: seen.headers, firstHeight: 0 });
  assert.equal(beacon.ok, false,
    `the beacon came out of headers only one seat holds: height ${beacon.height} of ${seen.headers.length} (honest tip 39)`);
});
