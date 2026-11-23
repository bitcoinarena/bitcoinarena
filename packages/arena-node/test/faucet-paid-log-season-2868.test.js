// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2868 (feedback #091/#092): GET /feedback/paid-log named every row 'Season 1', so the bounty page's "Paid so far in Season 1" summed the
// Season 2 payouts in too. Each row now carries its own season: a report with a Season 2 book approval is Season N of that approval, any other
// Season 1. The report's id stays out of the public log. And (feedback #090) Season 2 pays the full level only for a played round by a verified X.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openFeedbackStore } from '../src/feedback-store.js';
import { openBountySeason, seasonPayout, BOT_PCT } from '../src/bounty-season.js';

test('#2868 the paid log names each payout\'s own season, and no report id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paid-log-2868-'));
  const db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  openFeedbackStore(db).close(); openBountySeason(s2db).close?.();
  const k = new DatabaseSync(db), s = new DatabaseSync(s2db);
  const day = (d) => Date.parse(`2026-11-${d}T12:00:00Z`);
  const rows = [['a'.repeat(64), 1, 'high', 5000, day(12), null], ['b'.repeat(64), 2, 'low', 1000, day(15), null], ['c'.repeat(64), 3, 'medium', 300, day(15), 2]];
  for (const [id, n, sev, sats, paid, season] of rows) {
    k.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, state, severity, number) VALUES (?, ?, 'bug', 0, ?, 'x', '', '{}', 'paid', ?, ?)`).run(id, 'f'.repeat(64), paid, sev, n);
    k.prepare(`INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms, state, paid_ms) VALUES (?, ?, ?, ?, 'mainnet', ?, 'paid', ?)`).run(`k${n}`, id, 'f'.repeat(64), sats, paid, paid);
    if (season) s.prepare(`INSERT INTO approvals (report, pubkey, season, level, code_only, follow_up, base_sats, bonus_pct, sats, state, at_ms) VALUES (?, ?, ?, ?, 1, 0, ?, 0, ?, 'approved', ?)`).run(id, 'f'.repeat(64), season, sev, sats, sats, paid);
  }
  k.close(); s.close();
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: db, FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOOK: join(dir, 'book.json'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'),
      FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token') } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  try {
    let log = null;
    for (let i = 0; i < 80 && !log; i++) { try { log = await fetch(`http://127.0.0.1:${port}/feedback/paid-log`).then((r) => r.json()); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.deepEqual(log.map((x) => [x.reason, x.season, x.sats]), [['Feedback #001 (high)', 'Season 1', 5000], ['Feedback #002 (low)', 'Season 1', 1000], ['Feedback #003 (medium)', 'Season 2', 300]]);
    assert.equal(JSON.stringify(log).includes('a'.repeat(64)), false, 'no report id in the public log');
    assert.equal(log.reduce((t, x) => t + (x.season === 'Season 1' ? x.sats : 0), 0), 6000, 'the page\'s Season 1 sum');
  } finally { faucet.kill(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
});

test('#2868 (feedback #090) Season 2: the full level for a verified X account (#2904: a played round no longer needed)', () => {
  assert.equal(seasonPayout({ level: 'high', played: true, flags: { x: true } }).baseSats, 5000);
  assert.equal(seasonPayout({ level: 'high', played: false, flags: { x: true } }).baseSats, 5000);
  assert.equal(seasonPayout({ level: 'high', played: true, flags: {} }).baseSats, Math.floor(5000 * BOT_PCT / 100));
});
