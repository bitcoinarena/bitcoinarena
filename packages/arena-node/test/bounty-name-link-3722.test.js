// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3722 (the owner 2026-11-25: "Link code muss nicht sein, entfern das"): an account typed by name in the social screen and found live as a
// member (fresh read) counts like one proven by a posted link code - X makes the reporter human, each platform gives its community bonus. A handle on
// the bot list stays a bot whatever it links (#2958); a stale read counts nothing; the link code stays an optional way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBountySeason, bonusPct, CHECK_FRESH_MS } from '../src/bounty-season.js';
import { socialCheck } from '../src/bounty-social.js';

const K = (n) => n.toString(16).padStart(64, '0');
const members = {
  x: async (n) => ({ userId: 'x-' + n, username: n, member: true, why: 'follows' }),
  discord: async (n) => ({ userId: 'd-' + n, username: n, member: true, why: 'member' }),
  telegram: async (n) => ({ userId: 't-' + n, username: n, member: true, why: 'member' }),
  nostr: async (n) => ({ userId: n, member: true, why: 'follows' }),
};

test('#3722 a name-linked X follower is human with no link code, and each platform gives its bonus', async () => {
  const s = openBountySeason();
  const t0 = 1_800_000_000_000;
  const r = await socialCheck(s, K(1), { x: 'alice', discord: 'alice', telegram: 'alice', nostr: K(7) }, members, { nowMs: () => t0 });
  assert.equal(r.links.every((l) => l.proof === 'name'), true, 'linked by name only');
  assert.deepEqual(r.flags, { telegram: true, discord: true, x: true, armada: false, nostr: true });
  assert.equal(r.bonusPct, bonusPct(r.flags)); assert.equal(r.bonusPct, 60);
  assert.equal(r.results.x.needsCode, undefined, 'no code is asked for');
  const p = s.plan({ id: 'r1'.padEnd(64, '0'), pubkey: K(1) }, { level: 'high', nowMs: t0 });
  const bot = s.plan({ id: 'r2'.padEnd(64, '0'), pubkey: K(99) }, { level: 'high', nowMs: t0 });
  assert.ok(p.sats > bot.sats, 'human with bonus ' + p.sats + ' over a bot ' + bot.sats);
  // a stale read does not count
  assert.equal(s.flagsOf(K(1), { nowMs: t0 + CHECK_FRESH_MS + 1 }).x, false);
  // a not-member read does not count
  await s.verify(K(1), { x: async () => ({ member: false }) }, { nowMs: () => t0 });
  assert.equal(s.flagsOf(K(1), { nowMs: t0 }).x, false);
  s.close();
});

test('#3722 a name-linked X handle on the bot list stays a bot (#2958)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b3722-')), list = join(dir, 'bots.txt');
  writeFileSync(list, '# bots\n@BotHandle\n');
  const had = process.env.FAUCET_BOT_X_HANDLES; process.env.FAUCET_BOT_X_HANDLES = list;
  try {
    const s = openBountySeason();
    const r = await socialCheck(s, K(2), { x: 'bothandle', discord: 'bothandle', telegram: 'bothandle' }, members);
    assert.equal(r.flags.bot, true); assert.equal(r.flags.x, false); assert.equal(r.flags.discord, false); assert.equal(r.bonusPct, 0);
    s.close();
  } finally { if (had === undefined) delete process.env.FAUCET_BOT_X_HANDLES; else process.env.FAUCET_BOT_X_HANDLES = had; }
});
