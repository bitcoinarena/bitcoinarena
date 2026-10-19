// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL RESERVES' SPLIT (§27A.9.1): a paid round's mandatory 4 / 2 / 2 / 2 %, an item's 40 % nodes and
// 20 % reserves with the player's developers' share of 40/30/20/10/0 %, the reserve output - and today's versions untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundSplit, itemSplitReserves, reserveOutputsExpected, ITEM_DEV_SHARES_RESERVES } from '../src/reserves.js';
import { RESERVES_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { itemPriceFor, ITEM_DEV_SHARES } from '../src/items.js';

const sat = (n) => BigInt(n) * 1000n;
const sum = (o) => Object.values(o).reduce((t, x) => t + x, 0n);

test('a 100 sat paid round: nodes 4,000 · protocol devs 2,000 · game devs 2,000 · reserves 2,000 · net 90,000 msat', () => {
  assert.deepEqual(roundSplit(sat(100)), { nodesMsat: 4000n, protocolDevsMsat: 2000n, gameDevsMsat: 2000n, reservesMsat: 2000n, netMsat: 90000n });
});

test('1,000 sat and 333 sat: the parts sum exactly to the gross, the floors\' remainder in the net stake', () => {
  const k = roundSplit(sat(1000));
  assert.deepEqual(k, { nodesMsat: 40000n, protocolDevsMsat: 20000n, gameDevsMsat: 20000n, reservesMsat: 20000n, netMsat: 900000n });
  const odd = roundSplit(sat(333));
  assert.deepEqual(odd, { nodesMsat: 13320n, protocolDevsMsat: 6660n, gameDevsMsat: 6660n, reservesMsat: 6660n, netMsat: 299700n });
  const tiny = roundSplit(333n);   // 333 msat: every share floors, the net keeps the rest
  assert.deepEqual(tiny, { nodesMsat: 13n, protocolDevsMsat: 6n, gameDevsMsat: 6n, reservesMsat: 6n, netMsat: 302n });
  for (const x of [k, odd, tiny]) assert.equal(sum(x), [sat(1000), sat(333), 333n][[k, odd, tiny].indexOf(x)]);
});

test('a 500 sat item: at 40 % the price is 500 sat (nodes 200, reserves 100, devs 100 + 100); at 0 % 300 sat', () => {
  assert.deepEqual(itemSplitReserves({ listMsat: sat(500), devsPct: 40 }),
    { priceMsat: sat(500), nodesMsat: sat(200), reservesMsat: sat(100), protocolDevsMsat: sat(100), gameDevsMsat: sat(100) });
  assert.deepEqual(itemSplitReserves({ listMsat: sat(500), devsPct: 0 }),
    { priceMsat: sat(300), nodesMsat: sat(200), reservesMsat: sat(100), protocolDevsMsat: 0n, gameDevsMsat: 0n });
  assert.equal(itemSplitReserves({ listMsat: sat(500) }).priceMsat, sat(500), 'the default share is 40 %');
  assert.deepEqual(ITEM_DEV_SHARES_RESERVES, [40, 30, 20, 10, 0]);
  for (const p of ITEM_DEV_SHARES_RESERVES) { const s = itemSplitReserves({ listMsat: sat(777), devsPct: p }); assert.equal(s.nodesMsat + s.reservesMsat + s.protocolDevsMsat + s.gameDevsMsat, s.priceMsat); }
});

test('refused by name: a lowered developers\' share of a round, a 50 % item share', () => {
  assert.throws(() => roundSplit(sat(100), { devsBps: 200 }), /developers' 4 % is mandatory/);
  assert.throws(() => roundSplit(sat(100), { devsBps: 0 }), /mandatory/);
  assert.throws(() => itemSplitReserves({ listMsat: sat(500), devsPct: 50 }), /one of 40, 30, 20, 10, 0 %, not 50 %/);
});

test('the reserve output: 2 % of an entry, 20 % of an item, in its own federation; a free round pays none', () => {
  const fed = new Uint8Array(32).fill(3);
  assert.deepEqual(reserveOutputsExpected({ kind: 'entry', federationId: fed, grossMsat: sat(100) }), [{ federationId: fed, amountMsat: 2000n, to: 'reserves' }]);
  assert.deepEqual(reserveOutputsExpected({ kind: 'item', federationId: fed, listMsat: sat(500), devsPct: 20 }), [{ federationId: fed, amountMsat: sat(100), to: 'reserves' }]);
  assert.deepEqual(reserveOutputsExpected({ kind: 'entry', federationId: fed, grossMsat: sat(100), free: true }), []);
});

test('today\'s versions untouched: the reserves version is not spoken yet, \'s 50-0 % item share stands', () => {
  assert.equal(RESERVES_VERSION, 11);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(RESERVES_VERSION), 'spoken since slice 3');
  assert.deepEqual(ITEM_DEV_SHARES, [50, 40, 30, 20, 10, 0]);
  assert.equal(itemPriceFor(500n, 50), 500n);
  assert.equal(itemPriceFor(500n, 0), 250n);
});
