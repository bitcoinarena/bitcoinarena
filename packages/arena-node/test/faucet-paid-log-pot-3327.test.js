// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3327 (feedback #386): GET /feedback/season said usedSats 63,705 for Season 2 while the Season 2 rows of GET /feedback/paid-log summed
// 53,680. The pot counts every approved report (its claim link not yet claimed, or no link made yet), the log listed only rewards already paid:
// 10,025 sat of approved, unclaimed payouts were in the pot and missing from the table. The log now lists those too, each with state 'approved'
// (a paid one 'paid'), and /feedback/season splits usedSats into paidSats and owedSats - the log's sums per state match them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openFeedbackStore } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';

test('#3327 every approval the Season 2 pot counts is in the payout log, and the sums agree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paid-log-3327-'));
  const db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  openFeedbackStore(db).close(); openBountySeason(s2db).close?.();
  const k = new DatabaseSync(db), s = new DatabaseSync(s2db);
  const now = Date.now(), pk = 'f'.repeat(64);
  // [id, number, level, sats, reward state or null (no link yet), season of the approval or null (Season 1)]
  const rows = [['a'.repeat(64), 1, 'high', 5000, 'paid', null], ['b'.repeat(64), 2, 'low', 1200, 'paid', 2], ['c'.repeat(64), 3, 'medium', 2400, 'open', 2],
    ['d'.repeat(64), 4, 'low', 1200, null, 2], ['e'.repeat(64), 5, 'low', 150, 'void', 2]];
  for (const [id, n, sev, sats, w, season] of rows) {
    k.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, state, severity, number) VALUES (?, ?, 'bug', 0, ?, 'x', '', '{}', ?, ?, ?)`).run(id, pk, now, w === 'paid' ? 'paid' : 'accepted', sev, n);
    if (w) k.prepare(`INSERT INTO rewards (k1, report, pubkey, amount_sats, network, created_ms, state, paid_ms) VALUES (?, ?, ?, ?, 'mainnet', ?, ?, ?)`).run(`k${n}`, id, pk, sats, now, w, w === 'paid' ? now : null);
    if (season) s.prepare(`INSERT INTO approvals (report, pubkey, season, level, code_only, follow_up, base_sats, bonus_pct, sats, state, flags, at_ms) VALUES (?, ?, ?, ?, 0, 0, ?, 0, ?, 'approved', ?, ?)`)
      .run(id, pk, season, sev, sats, sats, JSON.stringify({ x: true }), now);
  }
  k.close(); s.close();
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: db, FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_START: new Date(now - 3600000).toISOString(),
      FAUCET_BOUNTY_POTS: '2:120000', FAUCET_BOOK: join(dir, 'book.json'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'),
      FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token') } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  try {
    let log = null;
    for (let i = 0; i < 80 && !log; i++) { try { log = await fetch(`http://127.0.0.1:${port}/feedback/paid-log`).then((r) => r.json()); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const pot = await fetch(`http://127.0.0.1:${port}/feedback/season`).then((r) => r.json());
    assert.equal(pot.season, 2);
    assert.equal(pot.usedSats, 1200 + 2400 + 1200 + 150, 'the pot counts every approved Season 2 report');
    const s2 = log.filter((x) => x.season === 'Season 2');
    assert.equal(s2.reduce((t, x) => t + x.sats, 0), pot.usedSats, 'the log\'s Season 2 rows sum to the pot\'s usedSats');
    assert.deepEqual(log.map((x) => [x.reason, x.season, x.sats, x.state]), [['Feedback #001 (high)', 'Season 1', 5000, 'paid'], ['Feedback #002 (low)', 'Season 2', 1200, 'paid'],
      ['Feedback #003 (medium)', 'Season 2', 2400, 'approved'], ['Feedback #004 (low)', 'Season 2', 1200, 'approved'], ['Feedback #005 (low)', 'Season 2', 150, 'approved']]);
    assert.equal(pot.paidSats, 1200, 'paid');
    assert.equal(pot.owedSats, 2400 + 1200 + 150, 'approved, not yet claimed');
    assert.equal(pot.paidSats + pot.owedSats, pot.usedSats);
    assert.equal(log.find((x) => x.state === 'approved').date, '', 'an unclaimed one has no paid time');
    assert.equal(JSON.stringify(log).includes('c'.repeat(64)), false, 'no report id in the public log');
  } finally { faucet.kill(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
});
