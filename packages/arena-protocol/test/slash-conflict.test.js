// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE THAT SIGNED FOR A ROUND ITS OWN OPERATOR PLAYED: withdrawn (§5A.13, RULED 2026-10-14). The rule kept beside it for reading
// old proofs answered `slashed: true` on bytes it never checked a signature over, and went with the ruling of 2026-11-02 (kanban #1035).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slashHoldsOnConflict } from '../src/slash.js';

test('since the 2026-10-14 ruling the offence is withdrawn: no proof slashes (§5A.13)', () => {
  const now = slashHoldsOnConflict({ proof: {}, entry: {}, signedByNode: {}, advert: {}, committee: [] });
  assert.equal(now.slashed, false);
  assert.match(now.why, /withdrawn: a player declares no operator/);
});
