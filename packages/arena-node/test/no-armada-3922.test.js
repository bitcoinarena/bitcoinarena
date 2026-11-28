// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3922 (the owner 2026-11-28 ~17:20Z: "Entferne auch die Armada community überall"): Armada is no platform any more. Nothing links, reads,
// counts or offers it; a link row or an approval written before still loads (its armada field is read and ignored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openBountySeason, PLATFORMS, COMMUNITIES, bonusPct } from '../src/bounty-season.js';
import { socialCheck, resolversFromEnv } from '../src/bounty-social.js';
import { SOCIAL_PLATFORMS, socialBonus } from '../src/bounty-social-store.js';

const K = (n) => n.toString(16).padStart(64, '0');

test('#3922 no Armada platform: no link, no read, no bonus, no draw entry', async () => {
  assert.equal(PLATFORMS.includes('armada'), false); assert.equal(COMMUNITIES.includes('armada'), false); assert.equal(SOCIAL_PLATFORMS.includes('armada'), false);
  assert.equal(bonusPct({ x: true, telegram: true, armada: true }), 20); assert.equal(socialBonus({ x: true, discord: true, armada: true }), 20);
  const s = openBountySeason();
  assert.equal(s.redeem(s.makeCode(K(1)).code, { platform: 'armada', userId: 'a'.repeat(64) }).why, 'no such platform');
  assert.equal(s.claimName(K(1), 'armada', { userId: 'a'.repeat(64) }).why, 'no such platform');
  let asked = 0;
  const r = await socialCheck(s, K(1), { armada: 'npub1ann' }, { armada: async () => { asked++; return { userId: 'a'.repeat(64), member: true }; } });
  assert.equal(asked, 0, 'an armada name is never read'); assert.deepEqual(r.results, {}); assert.equal('armada' in r.flags, false);
  assert.equal('armada' in resolversFromEnv(s, {}, { armada: async () => ({}) }), false);
  s.close();
});

test('#3922 an old database with an armada link and an approval carrying armada: true still loads; the flag counts for nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-armada-3922-')), file = join(dir, 's2.db');
  const now = Date.now();
  openBountySeason(file).close();
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO links (pubkey, platform, user_id, username, linked_ms, member, checked_ms, proof) VALUES (?, 'armada', ?, 'npub1old', ?, 1, ?, 'code')").run(K(1), 'a'.repeat(64), now, now);
  db.prepare("INSERT INTO links (pubkey, platform, user_id, username, linked_ms, member, checked_ms, proof) VALUES (?, 'telegram', 't1', '@old', ?, 1, ?, 'code')").run(K(1), now, now);
  db.prepare(`INSERT INTO approvals (report, pubkey, season, level, code_only, follow_up, base_sats, bonus_pct, sats, state, flags, at_ms)
    VALUES (?, ?, 2, 'low', 0, 0, 1000, 20, 1200, 'approved', ?, ?)`).run('r'.padEnd(64, '0'), K(1), JSON.stringify({ x: true, telegram: true, armada: true }), now);
  db.close();
  const s = openBountySeason(file);
  const a = s.approval('r'.padEnd(64, '0'));
  assert.equal(a.flags.armada, true, 'the stored field still reads'); assert.equal(a.sats, 1200);
  const f = s.flagsOf(K(1), { nowMs: now });
  assert.equal(f.telegram, true); assert.equal('armada' in f, false, 'an armada link row gives no flag');
  assert.equal(bonusPct(f), 0, 'telegram alone: no community bonus');
  assert.deepEqual(s.drawEntries(2, { nowMs: now }).map((e) => e.name || e), ['telegram:@old'], 'the draw names the telegram account, never the armada one');
  const p = s.payable('r'.padEnd(64, '0'), { nowMs: now });
  assert.equal(p.ok, true); assert.equal(p.lost.includes('armada'), false);
  s.close();
});

test('#3922 no source loads the old Armada module and no page offers it', () => {
  const src = new URL('../src/', import.meta.url), tools = new URL('../tools/', import.meta.url);
  for (const [base, f] of [...readdirSync(src).map((f) => [src, f]), ...readdirSync(tools).map((f) => [tools, f])]) {
    if (!/\.(m?js)$/.test(f) || f === 'bounty-armada.js') continue;
    assert.doesNotMatch(readFileSync(new URL(f, base), 'utf8'), /bounty-armada\.js/, f);
  }
  assert.doesNotMatch(readFileSync(new URL('../pages/owner.html', import.meta.url), 'utf8'), /armada/i);
});
