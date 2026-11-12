// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a45 refute 23, skeptic 3 (merge damage / second copy of kanban #1863 / #2250 / #2310): the
// #2310 fix (b22b58453) changed vestedShares in arena-protocol/src/donation.js only. The BUILT page
// bundle the player's page loads (src/arena-ui/arena-client.js = packages/arena-client/dist) was last
// rebuilt at #2250 (3eb49e555) and still carries the old vestedShares: no give-back for an all-vesting
// set and the "first share that can absorb it" rule. fetchDonationSet's target.network (what the page
// pays by splitTwoSets) is that stale copy, so (a) skeptic 2's all-vesting set still sums to 10100 in
// the page and its donation is refused, and (b) a small all-vesting set the page splits differently
// from the protocol (and the nodes' GET target) - the page pays other amounts than the seats expect.
// kanban #2356: the fix rebuilds the bundle (tools/bundle.js, copied to src/arena-ui) and pins its hash; this test and
// bundle-fresh.test.js keep a protocol-only change to vestedShares from shipping without the page getting it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { vestedShares as protoVested, donationSetStands, VESTING_DAY_BLOCKS } from '../../arena-protocol/src/donation.js';

const loadPage = (file) => {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace('toHex: toHex, fromHex: fromHex };\n})();', 'toHex: toHex, fromHex: fromHex, vestedShares: vestedShares, splitTwoSets: splitTwoSets };\n})();');
  const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, URL, Uint8Array, BigInt, Promise, atob, btoa, queueMicrotask, structuredClone, performance, AbortController, AbortSignal });
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.runInContext(src + '\n;globalThis.ARENACLIENT = ARENACLIENT;', ctx);
  assert.equal(typeof ctx.ARENACLIENT.vestedShares, 'function', 'vestedShares exposed from the bundle');
  return ctx.ARENACLIENT;
};
const shares = (out) => Array.from(out, (r) => r.shareBps);
// a real compressed point per n (the 1.9.17 merge: a recipient key must be a secp256k1 point, kanban #1489 v1-refute-3)
const key = (n) => secp256k1.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? (n + 1) & 0xff : i === 30 ? ((n + 1) >> 8) & 0xff : 0)), true);

const BIG = [];
let n = 1;
for (let i = 0; i < 200; i++) BIG.push({ recipientPk: key(n++), shareBps: 1, label: `s${i}`, vesting: { targetBps: 0, startHeight: 0, days: 2 } });
for (let i = 0; i < 100; i++) BIG.push({ recipientPk: key(n++), shareBps: 97, label: `g${i}`, vesting: { targetBps: 99, startHeight: 0, days: 2 } });
for (let i = 0; i < 2; i++) BIG.push({ recipientPk: key(n++), shareBps: 50, label: `k${i}`, vesting: { targetBps: 50, startHeight: 0, days: 2 } });

const SMALL = [
  { recipientPk: key(1), shareBps: 9994, label: 'grows', vesting: { targetBps: 10000, startHeight: 0, days: 2 } },
  { recipientPk: key(2), shareBps: 3, label: 'a', vesting: { targetBps: 0, startHeight: 0, days: 2 } },
  { recipientPk: key(3), shareBps: 3, label: 'b', vesting: { targetBps: 0, startHeight: 0, days: 2 } },
];

for (const file of ['../../../src/arena-ui/arena-client.js', '../dist/arena-client.js']) {
  test(`${file}: skeptic 2's all-vesting set sums to 10000 in the page and its donation is split`, () => {
    const page = loadPage(file);
    assert.equal(donationSetStands(BIG).ok, true);
    const out = page.vestedShares(BIG, VESTING_DAY_BLOCKS);
    const sum = shares(out).reduce((t, x) => t + x, 0);
    assert.equal(sum, 10000, `page bundle day 1 sums to ${sum}`);
    const two = page.splitTwoSets({ donationMsat: 1000000n, networkSet: out, gameSet: [{ recipientPk: key(9999), shareBps: 10000, label: 'g' }] });
    assert.equal(two.owed, true, `page splitTwoSets refused: ${two.why}`);
  });

  test(`${file}: the page's vested shares are the protocol's (the nodes' target) at every height`, () => {
    const page = loadPage(file);
    assert.equal(donationSetStands(SMALL).ok, true, donationSetStands(SMALL).why);
    for (const set of [SMALL, BIG]) for (let day = 0; day <= 3; day++) {
      const h = day * VESTING_DAY_BLOCKS;
      assert.deepEqual(shares(page.vestedShares(set, h)), shares(protoVested(set, h)), `day ${day} (${set.length} entries)`);
    }
  });
}
