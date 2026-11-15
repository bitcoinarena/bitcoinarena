// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3-faucet-2 (base b5f391bbb): A DRAW ENTRY IS NAMED BY A TELEGRAM FIRST NAME, AND TWO KEYS' ENTRIES MERGE INTO ONE. The link bot
// (tools/bounty-link-bot.mjs telegramLoop) links a `/link BA-...` sender under `@<username>`, or - when the account has no username - under its
// first_name, which the sender types freely. S2.drawEntries names each member key's entry `<platform>:<username>` and returns them through a Set,
// and tools/bounty-draw.mjs dedups the list again. An attacker account with no username and first_name "@alice" (an honest member's username)
// gives the attacker's key the entry "telegram:@alice": the honest reporter's entry and the attacker's become ONE line on the published list -
// one person's place in the 50,000 sat draw disappears, and when "telegram:@alice" is drawn the attacker claims it under the same name.
// Safe: every member key with an approved report has its own entry; no entry text one key can choose equals another key's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

const K = (n) => n.toString(16).padStart(64, '0');
const rep = (n, pubkey) => ({ id: `e${n}`.padEnd(64, '0'), pubkey });

test('r3-faucet-2: an attacker whose Telegram first name is "@alice" does not merge into alice\'s draw entry', async () => {
  const s = openBountySeason();
  const verifiers = { telegram: async () => ({ member: true, why: 'member' }) };
  const alice = K(1), mallory = K(2);
  // alice: a real Telegram username; the bot links her as @alice (telegramLoop: `@${m.from.username}`)
  const ca = s.makeCode(alice).code;
  const la = await linkFromText(s, verifiers, { platform: 'telegram', userId: '1001', username: '@alice', text: `/link ${ca}` });
  assert.equal(la.ok, true);
  // mallory: no username, first_name "@alice" (telegramLoop: m.from.first_name)
  const cm = s.makeCode(mallory).code;
  const lm = await linkFromText(s, verifiers, { platform: 'telegram', userId: '2002', username: '@alice', text: `/link ${cm}` });
  assert.equal(lm.ok, true);
  for (const [n, k] of [[1, alice], [2, mallory]]) { const r = rep(n, k); const p = s.plan(r, { level: 'low' }); assert.equal(p.ok, true); s.commit(r, p); }
  const entries = s.drawEntries(2);
  assert.equal(entries.length, 2, `two member keys with approved reports, entries: ${JSON.stringify(entries)}`);
});
