// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2645 (2.0 part): an upsert's ON CONFLICT DO UPDATE overrides the OR IGNORE of the link_names triggers, so an account linked again to the
// same key under the same name threw "UNIQUE constraint failed: link_names" in redeem. A second code from the same account now links again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';

const K = (n) => n.toString(16).padStart(64, '0');

test('#2645 the same account linked again by a second code of the same key', () => {
  const s = openBountySeason();
  assert.equal(s.redeem(s.makeCode(K(1)).code, { platform: 'telegram', userId: '9', username: '@ann' }).ok, true);
  const again = s.redeem(s.makeCode(K(1)).code, { platform: 'telegram', userId: '9', username: '@ann' });
  assert.equal(again.ok, true, JSON.stringify(again));
  s.close();
});
