// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT OPENING A ROUND NAMES THE OPEN FEDERATION WITH THE LOWEST LOAD (§23A.3, kanban #324 step 2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openingFederation } from '../src/opening-federation.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32), D = 'dd'.repeat(32);
test('the lowest-load OPEN federation the opener serves is named; a higher-load one is not chosen', () => {
  const listed = [{ federation: A, status: 'OPEN', load: 4.3333, height: 9 }, { federation: B, status: 'OPEN', load: 0.0002, height: 5 },
    { federation: C, status: 'DRAINING', load: 0, height: 9 }, { federation: D, status: 'OPEN', load: 0, height: 9 }];
  const got = openingFederation({ listed, serves: [A, B, C], own: A });
  assert.equal(got.federationId, B, 'B at 0.0002, not A at 4.33');
  assert.notEqual(got.federationId, A);
  assert.equal(got.load, 0.0002);
  // D is lower but not served by this opener; C is lower but DRAINING
  assert.equal(openingFederation({ listed, serves: [A, B, C], own: A }).federationId, B);
  // only A served: A, whatever its load
  assert.equal(openingFederation({ listed, serves: [A], own: A }).federationId, A);
  // a record naming no load counts as the highest; a tie goes to the newest record
  assert.equal(openingFederation({ listed: [{ federation: A, status: 'OPEN' }, { federation: B, status: 'OPEN', load: 9 }], serves: [A, B], own: A }).federationId, B);
  assert.equal(openingFederation({ listed: [{ federation: A, status: 'OPEN', load: 1, height: 3 }, { federation: B, status: 'OPEN', load: 1, height: 4 }], serves: [A, B], own: A }).federationId, B);
  // nothing listed: its own
  assert.deepEqual(openingFederation({ listed: [], serves: [A, B], own: A }).federationId, A);
});
