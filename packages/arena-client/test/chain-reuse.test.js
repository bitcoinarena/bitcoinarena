// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAGE OPENS ITS NEXT ROUND FROM THE CHAIN IT ALREADY PROVED (2026-09-18 16:45).
//
// Measured in two real browsers on the Daily: on PLAY again both tabs joined the second round and neither got a
// client. The page proves a chain over /headers from both signer nodes and wants both inside 10 s; in a tab drawing
// under a frame a second that read took 8746 ms and 8745 ms for 240 bytes, where curl on the same host has them in
// 0.52 s and 1.43 s. A round joined with no client publishes nothing, so the other tab is shown no truck at all.
//
// The headers do not change behind a page, so the round that follows is opened from what the last one proved. What is
// NOT reused is the bond: it is checked against the chain every time, and a bond the kept proof cannot reach makes
// this read the chain afresh rather than play under a chain that cannot carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/directory.js';

const b32 = (n) => new Uint8Array(32).fill(n);

/** A header provider that counts how often it is actually asked. */
const provider = (tag, answer) => Object.assign(async () => answer(), { tag });

test('a proved chain is not proved again, and a page with none still reads', async () => {
  let reads = 0;
  const headers = [
    provider('one', () => { reads++; throw new Error('this test never needs a real chain'); }),
    provider('two', () => { reads++; throw new Error('this test never needs a real chain'); }),
  ];
  const bonds = [Object.assign(async () => { throw new Error('no bond here'); }, { tag: 'bond' })];

  // WITH NOTHING KEPT, the providers are asked: that is a first join, and it must still read.
  const first = await discover({ headers, bonds, committee: [b32(4)], signedAdvert: new Uint8Array(0) });
  assert.equal(first.ok, false, 'a discover with no chain answered ok');
  assert.ok(reads >= 2, `a page with no proved chain asked ${reads} providers: it must read`);

  // WITH A PROOF IN HAND, they are not asked again - the failure moves past the chain, to the bond.
  const before = reads;
  const proved = { ok: true, headers: [{ height: 900000 }], work: 1n, agreed: 2, from: ['one', 'two'] };
  const second = await discover({ headers, bonds, committee: [b32(4)], signedAdvert: new Uint8Array(0), proved });
  assert.equal(second.ok, false, 'this fixture has no bond, so the call still fails - but not on the chain');
  assert.match(String(second.why), /bond/, `a kept chain was not used: ${second.why}`);
  assert.equal(reads, before + 2,
    `a kept proof still read the headers ${reads - before} times; it may read once more only for the bond fallback`);
});
