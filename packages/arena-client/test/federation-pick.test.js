// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH FEDERATION, BY LOAD (§23A.3): a first deposit goes where least sits against the most cover; a
// returning player is offered Move above 90 % when another OPEN federation is below 50 %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickFederation, moveOffer } from '../src/federations.js';

const f = (federation, status, load, height = 100) => ({ federation, status, load, height });

test('a first deposit goes to the OPEN federation with the lowest load, ties to the newest record; unknown and closed ones never', () => {
  assert.equal(pickFederation([f('a', 'OPEN', 0.7), f('b', 'OPEN', 0.2), f('c', 'DRAINING', 0.0), f('d', 'CRITICAL', 0.1)]).federation, 'b');
  assert.equal(pickFederation([f('a', 'OPEN', 0.3, 100), f('b', 'OPEN', 0.3, 120)]).federation, 'b', 'a tie goes to the newest record');
  assert.equal(pickFederation([f('a', 'OPEN', null), f('b', 'OPEN', 0.95)]).federation, 'b', 'a load the record does not say comes last');
  assert.equal(pickFederation([f('a', 'OPEN', 0.1), f('b', 'OPEN', 0.4)], { known: (x) => x !== 'a' }).federation, 'b', 'not on the known-good list');
  assert.equal(pickFederation([f('c', 'DRAINING', 0)]), null);
});

test('Move is offered above 90 % when another OPEN federation is below 50 %, and only then', () => {
  assert.deepEqual(moveOffer(f('a', 'OPEN', 0.95), [f('b', 'OPEN', 0.4), f('c', 'OPEN', 0.2)]), { from: 'a', to: 'c', fromLoad: 0.95, toLoad: 0.2 });
  assert.equal(moveOffer(f('a', 'OPEN', 0.9), [f('b', 'OPEN', 0.1)]), null, 'at 90 % exactly: no offer');
  assert.equal(moveOffer(f('a', 'OPEN', 0.95), [f('b', 'OPEN', 0.5)]), null, 'none below 50 %');
  assert.equal(moveOffer(f('a', 'DRAINING', 0.95), [f('b', 'OPEN', 0.1)]), null, 'a draining federation moves by itself, it is not offered');
  assert.equal(moveOffer(f('a', 'OPEN', 4.33), [f('b', 'DRAINING', 0.1)]), null, 'only to an OPEN one');
});
