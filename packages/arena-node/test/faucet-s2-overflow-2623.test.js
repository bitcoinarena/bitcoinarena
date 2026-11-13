// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2623 (Daniel 2026-11-13 ~17:55Z: "Season 2 läuft ab Sonntag ... wenn das Budget voll ist, auf Season 2 gehen mit den gültigen regeln"):
// before its start a Season 2 approval is refused; a Season 1 approval past the weekly budget does not fail - the report waits for Season 2, with a
// note on its ticket, and once Season 2 runs it is approved by the Season 2 rules on its own. A report that fits stays Season 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, HTTP_AUTH_KIND } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const STAGE = 'https://stage.example/api/faucet/feedback';
const PRIVATE = 'https://stage.example';
const ADMIN = 'admin-code-2623';

test('#2623 overflow: past the Season 1 budget a report waits for Season 2 and is approved by its rules once Season 2 starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-s2-overflow-2623-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  const startMs = Date.now() + 6000;
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_ORIGINS: PRIVATE,
      FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_BASES: STAGE,
      FAUCET_REWARD_RULES: JSON.stringify({ weeklyBudgetSats: 3000 }), FAUCET_BOUNTY_S2_START: new Date(startMs).toISOString(), FAUCET_BOUNTY_S2_SWEEP_MS: '500' } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  const j = (p, o) => fetch(`${base}${p}`, o).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  const reportOf = (id) => j(`/feedback/admin/report/${id}`, { headers: { 'x-arena-admin': ADMIN } });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const report = async (k, words) => { const ev = signed(k, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: words }));
      const r = await j('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) }); assert.equal(r.ok, true, JSON.stringify(r)); return ev.id; };
    const r1 = await report(key(1), 'The first report of the week fits the Season 1 budget and is approved as always here');
    const r2 = await report(key(2), 'The second report would take the week past the Season 1 budget, so it moves to Season 2');
    const r3 = await report(key(3), 'A report the admin approves for Season 2 by hand before Season 2 has started at all');

    const before = await act({ action: 'approve', id: r3, severity: 'low', season2: true });
    assert.equal(before.ok, false); assert.match(before.why, /Week 2 starts \d{4}-\d{2}-\d{2}/);
    const a1 = await act({ action: 'approve', id: r1, severity: 'medium', amountSats: 2000 });
    assert.equal(a1.ok, true); assert.equal(a1.report.amountSats, 2000); assert.equal(a1.season2, undefined, 'it fits: Season 1');
    const a2 = await act({ action: 'approve', id: r2, severity: 'medium', amountSats: 2000 });
    assert.equal(a2.ok, true, JSON.stringify(a2)); assert.equal(a2.movedToSeason2, true);
    assert.equal(a2.season2.state, 'waiting');
    const r2now = await reportOf(r2);
    assert.equal(r2now.report.state, 'new', 'not approved under Season 1');
    assert.ok(r2now.moves.some((m) => /Week 2/.test(m.note || '')), 'the ticket says it moved to Season 2');

    for (let i = 0; i < 40 && Date.now() < startMs + 3000; i++) { const r = await reportOf(r2); if (r.report.state === 'accepted') break; await new Promise((x) => setTimeout(x, 300)); }
    const after = await reportOf(r2);
    assert.equal(after.report.state, 'accepted', 'approved on its own once Season 2 runs');
    assert.equal(after.report.amountSats, 2000, 'by the Season 2 rules: medium, no bonus');
    assert.equal(after.report.season2.approval.state, 'approved');
    assert.equal(after.report.season2.approval.season, 2);
    const late = await act({ action: 'approve', id: r3, severity: 'low', season2: true });
    assert.equal(late.ok, true, JSON.stringify(late));
  } finally { faucet.kill(); chatServer.close(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
});
