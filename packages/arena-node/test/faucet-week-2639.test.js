// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2639 (Daniel 2026-11-13: "Nenn season in week um"; 20:37:31Z "Alles was nun reinkommt ist automatisch week 2"): a report received at or
// after FAUCET_BOUNTY_S1_END is never approved in Week 1 - it waits for Week 2 with the note "received after Week 1 ended: Week 2 rules"; one received
// before stays Week 1. The texts the admin reads say Week, and /feedback/admin/season names the cutoff. The admin page's week filter: a report is in
// Week 2 when the season file lists it (waiting included) or it came after the cutoff and is still new.
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
import { readFileSync } from 'node:fs';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const STAGE = 'https://stage.example/api/faucet/feedback';
const PRIVATE = 'https://stage.example';
const ADMIN = 'admin-code-2623';

test('#2639 after the Week 1 cutoff a report waits for Week 2, whatever the Week 1 budget; before it, Week 1 as now; texts say Week', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-week-2639-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  const startMs = Date.now() + 3600000;
  const env = (endMs) => ({ ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_ORIGINS: PRIVATE,
    FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_BASES: STAGE,
    FAUCET_REWARD_RULES: JSON.stringify({ weeklyBudgetSats: 100000 }), FAUCET_BOUNTY_S2_START: new Date(startMs).toISOString(), FAUCET_BOUNTY_S1_END: new Date(endMs).toISOString() });
  const base = `http://127.0.0.1:${port}`;
  const j = (p, o) => fetch(`${base}${p}`, o).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  const reportOf = (id) => j(`/feedback/admin/report/${id}`, { headers: { 'x-arena-admin': ADMIN } });
  const up = async () => { for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/paid-log`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } };
  const report = async (k, words) => { const ev = signed(k, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: words }));
    const r = await j('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) }); assert.equal(r.ok, true, JSON.stringify(r)); return ev.id; };
  let faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore', env: env(Date.now() + 3600000) });
  try {
    await up();
    const before = await report(key(1), 'This report came in while Week 1 was still running, so it is approved in Week 1 as always');
    faucet.kill(); await new Promise((r) => setTimeout(r, 300));
    const cutoff = Date.now();
    faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore', env: env(cutoff) });
    await up();
    await new Promise((r) => setTimeout(r, 20));
    const after = await report(key(2), 'This report came in after the Week 1 cutoff, so it belongs to Week 2 whatever the budget says');

    const a1 = await act({ action: 'approve', id: before, severity: 'low', amountSats: 1000 });
    assert.equal(a1.ok, true); assert.equal(a1.report.amountSats, 1000); assert.equal(a1.movedToSeason2, undefined, 'before the cutoff: Week 1');
    const a2 = await act({ action: 'approve', id: after, severity: 'low', amountSats: 1000 });
    assert.equal(a2.ok, true, JSON.stringify(a2)); assert.equal(a2.movedToSeason2, true, 'after the cutoff: never Week 1, budget or not');
    assert.equal(a2.season2.state, 'waiting');
    const r2 = await reportOf(after);
    assert.equal(r2.report.state, 'new');
    assert.ok(r2.moves.some((m) => /received after Week 1 ended: Week 2 rules/.test(m.note || '')), JSON.stringify(r2.moves));
    const early = await act({ action: 'approve', id: after, severity: 'low', season2: true });
    assert.match(early.why, /^Week 2 starts \d{4}-\d{2}-\d{2}$/);
    assert.doesNotMatch(JSON.stringify([a2, early, r2.moves]).replace(/movedToSeason2/g, ""), /Season/, 'the admin reads Week, not Season');
    const season = await j('/feedback/admin/season', { headers: { 'x-arena-admin': ADMIN } });
    assert.equal(season.s1EndMs, cutoff);
  } finally { faucet.kill(); chatServer.close(); }
});

test('#2639 the admin page\'s week of a report: Week 2 when the season file lists it (waiting too) or it came after the cutoff and is new', () => {
  const page = readFileSync(new URL('../../../src/website/www/feedback-admin/index.html', import.meta.url), 'utf8');
  const m = /\/\* WEEK-OF \*\/([\s\S]*?)\/\* \/WEEK-OF \*\//.exec(page);
  assert.ok(m, 'the page holds its weekOf');
  const weekOf = new Function(`${m[1]}; return weekOf;`)();
  const listed = new Set(['a', 'b']);
  assert.equal(weekOf({ id: 'a', state: 'new', receivedMs: 1 }, listed, 100), 2, 'waiting in the season file');
  assert.equal(weekOf({ id: 'b', state: 'accepted', receivedMs: 1 }, listed, 100), 2, 'approved in Week 2');
  assert.equal(weekOf({ id: 'c', state: 'new', receivedMs: 100 }, listed, 100), 2, 'after the cutoff and still new');
  assert.equal(weekOf({ id: 'd', state: 'paid', receivedMs: 200 }, listed, 100), 1, 'paid in Week 1 stays Week 1');
  assert.equal(weekOf({ id: 'e', state: 'new', receivedMs: 99 }, listed, 100), 1);
  assert.equal(weekOf({ id: 'f', state: 'new', receivedMs: 500 }, listed, null), 1, 'no cutoff known');
  assert.match(page, /id="f-week"/); assert.match(page, /id="f-showweek"/);
  assert.match(page, /arena\.feedback\.admin\.showweek/);
  assert.doesNotMatch(page.replace(/feedback\/admin\/season|\bseason2\b|\.season\b|s1EndMs/g, ''), /Season/, 'no Season left in the admin text');
  const worker = readFileSync(new URL('../../../src/website/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /admin\\\/\(list\|act\|export\\\.csv\|season\|/, 'the Worker passes /feedback/admin/season on');
});
