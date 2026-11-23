// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r21 faucet 2 (P1 self-declared): the Founding Tester badge (tools/founding-badges.mjs) goes to a key that "finished a round and gave
// feedback"; the feedback half is FOUNDING_FILE, which faucet.mjs appends with d.player of POST /feedback. For an UNSIGNED report that key is
// b0.player as sent (feedbackDecide), no signature, so a stranger names any player's key (or every key on the season board) as having given feedback.
// Safe: an unsigned report never carries a player key into the founding list (only a key that signed the report is that player).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackDecide } from '../src/faucet.js';

test('#1489-r21-faucet-2 an unsigned report does not name someone else\'s key as a founding tester', () => {
  const victims = Array.from({ length: 5 }, (_, i) => String(i + 1).repeat(64).slice(0, 64));
  const log = [], named = [];
  for (const [i, player] of victims.entries()) {
    const d = feedbackDecide({ text: 'nice game', ip: `203.0.${i}.7`, player, signed: false }, log);
    log.push({ ip: `203.0.${i}.7`, atMs: Date.now(), signed: false });
    if (d.ok && d.player) named.push(d.player);
  }
  console.log('  MEASURED:', JSON.stringify({ posted: victims.length, namedAsFeedbackGivers: named.length }));
  assert.equal(named.length, 0, `${named.length} unsigned reports put a key of the sender's choosing into the founding list`);
});
