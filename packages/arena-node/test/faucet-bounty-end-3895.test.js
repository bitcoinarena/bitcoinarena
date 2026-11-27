// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3895 (the owner 2026-11-27: the bug bounty ends Sunday 29 Nov 2026, end of day UTC): FAUCET_BOUNTY_END is the end time. A report received
// after it is never approved for money and gets no reward link; a report received before it is approved under the old rules; the form's answer
// after the end says noReward; GET /feedback/season names the end. No end set: nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openFeedbackStore } from '../src/feedback-store.js';
import { openBountySeason, receivedAfterBountyEnd, bountyEndMsOf } from '../src/bounty-season.js';

test('#3895 the end time: after it, not at it; no end, no change', () => {
  const end = bountyEndMsOf('2026-11-29T23:59:59Z');
  assert.equal(end, Date.parse('2026-11-29T23:59:59Z'));
  assert.equal(receivedAfterBountyEnd(end, end), false, 'received at the end second: still the old rules');
  assert.equal(receivedAfterBountyEnd(end - 1, end), false);
  assert.equal(receivedAfterBountyEnd(end + 1, end), true);
  assert.equal(receivedAfterBountyEnd(end + 1, null), false, 'no end set');
  assert.equal(bountyEndMsOf(''), null); assert.equal(bountyEndMsOf('not a time'), null); assert.equal(bountyEndMsOf(undefined), null);
});

const ADMIN = 'admin-code-3895';
async function withFaucet(endIso, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-end-3895-'));
  const db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  openFeedbackStore(db).close(); openBountySeason(s2db).close?.();
  const now = Date.now(), endMs = endIso ? Date.parse(endIso) : now - 3600000;   // no end: the same received times
  const before = 'a'.repeat(64), after = 'b'.repeat(64);
  const k = new DatabaseSync(db);
  for (const [id, n, at, pk] of [[before, 1, endMs - 60000, 'c'.repeat(64)], [after, 2, endMs + 1000, 'd'.repeat(64)]])
    k.prepare(`INSERT INTO reports (id, pubkey, type, signed_at, received_ms, happened, expected, event, state, number) VALUES (?, ?, 'bug', 0, ?, 'x', '', '{}', 'new', ?)`).run(id, pk, at, n);
  k.close();
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: db, FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_START: new Date(now - 30 * 86400000).toISOString(),
      FAUCET_BOUNTY_ORIGINS: 'https://testnet.bitcoinarena.io', FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'),
      FAUCET_BOOK: join(dir, 'book.json'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_SWEEP_MS: '3600000',
      FAUCET_CHAT_URL: 'http://127.0.0.1:9', FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'), ...(endIso ? { FAUCET_BOUNTY_END: endIso } : {}) } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  const j = (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o).then((r) => r.json());
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 80; i++) { try { await j('/feedback/season'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await fn({ j, act, before, after, endMs });
  } finally { faucet.kill(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
}

test('#3895 a report received after the end is not approved for money and gets no reward link; one received before is approved', async () => {
  const endIso = new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z');   // the end an hour ago
  await withFaucet(endIso, async ({ j, act, before, after, endMs }) => {
    const late = await act({ action: 'approve', id: after, severity: 'high', season2: true });
    assert.equal(late.ok, false, JSON.stringify(late)); assert.equal(late.bountyEnded, true);
    const late1 = await act({ action: 'approve', id: after, amountSats: 1000 });   // the old Season 1 path too
    assert.equal(late1.ok, false); assert.equal(late1.bountyEnded, true);
    const lateW = await act({ action: 'reward', id: after });
    assert.equal(lateW.ok, false); assert.equal(lateW.bountyEnded, true);
    const early = await act({ action: 'approve', id: before, severity: 'high', season2: true });
    assert.equal(early.ok, true, `received before the end: the old rules - ${JSON.stringify(early)}`);
    assert.equal(early.report.amountSats, 750, 'the old rule (no X: 15 % of 5,000)');
    const rej = await act({ action: 'reject', id: after, reason: 'test' });
    assert.equal(rej.ok, true, 'reject still works on a late report');
    const s = await j('/feedback/season');
    assert.equal(s.bountyEndMs, endMs); assert.equal(s.bountyEnded, true);
  });
});

test('#3895 no end set: a late report is approved as before', async () => {
  await withFaucet(null, async ({ j, act, after }) => {
    const a = await act({ action: 'approve', id: after, severity: 'high', season2: true });
    assert.equal(a.ok, true, JSON.stringify(a));
    const s = await j('/feedback/season'); assert.equal(s.bountyEndMs, null); assert.equal(s.bountyEnded, false);
  });
});
