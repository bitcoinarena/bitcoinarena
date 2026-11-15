// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2789 (the owner 2026-11-15, stage only): the pot warning on the stage /bounty/ page and the stage Feedback form, per threshold with a simulated
// pot. 2.0 port: the faucet part only (the stage pages and their banner function are 1.9 only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('#2789 the faucet\'s season answer carries pendingNew (a number only)', () => {
  const f = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(f, /pendingNew: FEEDBACK\.countNew\(seasonEndMs\(p\.season - 1, S2_START_MS\) \?\? 0\)/);
});

test('#2789 the report store counts reports still new since a time', async () => {
  const { openFeedbackStore } = await import('../src/feedback-store.js');
  const st = openFeedbackStore();
  assert.equal(st.countNew(0), 0);
});
