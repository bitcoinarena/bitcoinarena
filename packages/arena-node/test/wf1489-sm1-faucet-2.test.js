// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 sm1-faucet-22 (state machine audit, SM-21 report x the Season 2 approval, two files): a Season 2 decision is written in two stores one
// after the other - s2Approve() commits the report's accepted state in feedback.db (FEEDBACK.approve) and only then the approval in season2.db
// (S2.commit); a rejection commits the report's move (FEEDBACK.move) and only then S2.voidApproval. When the second write fails (season2.db busy past
// its 5 s busy_timeout - the link bot process writes the same file - full, or the faucet killed between the two), the first stays: an ACCEPTED
// report with no Season 2 approval (the pot never counts its sats, the draw never sees it) or a REJECTED report whose approval stays APPROVED (the pot
// counts it as used and the rejected reporter is an entry of the season's draw). The admin's retry is refused by the report's new state, so the pair
// never comes together again.
// The real tools/faucet.mjs; season2.db is held by another connection (BEGIN EXCLUSIVE) for the 5 s busy_timeout while the admin acts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, openFeedbackStore } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, words) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: FEEDBACK_KIND, tags: [['t', 'bug']], content: JSON.stringify({ happened: words }) };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const PRIVATE = 'https://stage.example';
const ADMIN = 'admin-code-sm1-22';

test('#1489 sm1-faucet-22: a Season 2 approval and a rejection land in both stores or in neither', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm1-faucet-22-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_ORIGINS: PRIVATE,
      FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_START: new Date(Date.now() - 3600000).toISOString(),
      FAUCET_BOUNTY_TG_USERBOT: 'off', FAUCET_BOUNTY_NETWORK: 'mainnet', FAUCET_BOUNTY_S2_SWEEP_MS: '3600000' } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  const j = (p, o) => fetch(`${base}${p}`, o).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  const send = (e) => j('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: e }) });
  // another writer of season2.db (the link bot, a tool) holding it longer than the faucet's busy_timeout
  const held = async (fn) => { const L = new DatabaseSync(s2db); L.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE'); try { return await fn(); } finally { L.exec('ROLLBACK'); L.close(); } };
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ann = key(51), bob = key(52);
    const a = signed(ann, 'The lobby list loses the round I joined after a reload and shows the stake as free again for a minute.');
    const b = signed(bob, 'The withdraw dialog shows the balance from before the last round until the page is reloaded by hand.');
    assert.equal((await send(a)).ok, true); assert.equal((await send(b)).ok, true);
    // (1) an approval while season2.db is busy
    const approveBusy = await held(() => act({ action: 'approve', id: a.id, severity: 'low', season2: true }));
    const approveAgain = await act({ action: 'approve', id: a.id, severity: 'low', season2: true });
    // (2) bob approved normally, then rejected while season2.db is busy
    const bobOk = await act({ action: 'approve', id: b.id, severity: 'low', season2: true });
    assert.equal(bobOk.ok, true, JSON.stringify(bobOk));
    const rejectBusy = await held(() => act({ action: 'reject', id: b.id, reason: 'not reproducible on the newest version' }));
    const rejectAgain = await act({ action: 'reject', id: b.id, reason: 'not reproducible on the newest version' });
    faucet.kill(); await new Promise((r) => setTimeout(r, 300));
    const F = openFeedbackStore(db), S = openBountySeason(s2db, { startMs: Date.now() - 3600000 });
    const annReport = F.report(a.id).state, annApproval = S.approval(a.id);
    const bobReport = F.report(b.id).state, bobApproval = S.approval(b.id);
    const season = S.seasonNow(Date.now()), entriesKeys = S.keysOfSeason(season);
    console.log('  MEASURED sm1-faucet-22:', JSON.stringify({ approveBusy: [approveBusy.status, approveBusy.why], approveAgain: approveAgain.why, annReport, annApproval: annApproval && annApproval.state,
      rejectBusy: [rejectBusy.status, rejectBusy.why], rejectAgain: rejectAgain.why, bobReport, bobApproval: bobApproval && bobApproval.state, potUsed: S.pot(season).usedSats, bobInSeasonKeys: entriesKeys.includes(bob.pubkey) }));
    F.close(); S.close();
    // invariant: a report accepted by the Season 2 rules has its Season 2 approval; a rejected report has none that is approved
    if (annReport === 'accepted') assert.equal(annApproval && annApproval.state, 'approved', 'an accepted Season 2 report has no Season 2 approval: the pot never counts it');
    if (bobReport === 'rejected') assert.notEqual(bobApproval && bobApproval.state, 'approved', 'a rejected report keeps an approved Season 2 approval: the pot counts it and its key is in the season');
  } finally { try { faucet.kill(); } catch { /* gone */ } chatServer.close(); if (err.trim()) console.log('  stderr:', err.slice(0, 300)); }
});
