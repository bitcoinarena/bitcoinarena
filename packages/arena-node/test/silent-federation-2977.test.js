// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2977 (feedback #325, owner 2026-11-18): a federation whose guardians went silent is not offered as OPEN on GET /federations.
// Measured live: e45f06ef heard last at session 446 from height 158975, tip 162042 - fed2-1 served it OPEN with load 0; 337ae01a, alive,
// was heard at session 12835 from 162048.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { silentFederation, SILENT_BLOCKS } from '../src/halts.js';

test('#2977: silent after SILENT_BLOCKS without a new session; a live or unknown federation is not', () => {
  assert.equal(SILENT_BLOCKS, 144);
  assert.equal(silentFederation({ session: 446, firstHeight: 158975, heard: true }, 162042), true, 'e45f06ef as measured');
  assert.equal(silentFederation({ session: 12835, firstHeight: 162048, heard: true }, 162050), false, '337ae01a as measured');
  assert.equal(silentFederation({ session: 9, firstHeight: 1000, heard: true }, 1144), false, 'exactly SILENT_BLOCKS: not yet');
  assert.equal(silentFederation({ session: 9, firstHeight: 1000, heard: true }, 1145), true);
  assert.equal(silentFederation(null, 162042), false, 'never heard by this seat: not judged here');
  assert.equal(silentFederation({ session: 0, firstHeight: 158975, heard: false }, 162042), false, 'not heard yet: not judged');
  assert.equal(silentFederation({ session: 446, firstHeight: 158975, heard: true }, NaN), false, 'no tip: nothing is hidden');
});
