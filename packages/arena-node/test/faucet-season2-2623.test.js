// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2623: Season 2 in the faucet - a reporter's link code over a NIP-98 sign-in, the admin approval that computes the Season 2 amount (bonus
// from the stored reads, half for code-only) and records it in the season's own file, the public pot and open-issues list; Season 1's approval
// and the paid log answer as before.
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

test('#2623 the faucet: link code by sign-in, Season 2 approval with bonus and half rate, pot and open issues; Season 1 as before', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-s2-2623-'));
  writeFileSync(join(dir, 'token'), 'x');
  writeFileSync(join(dir, 'open.json'), JSON.stringify({ updated: '2026-11-13T00:00:00Z', areas: [{ area: 'Slashing', tickets: ['#1155'], title: 'secret words' }] }));
  // the chat, and the board's ticket #77 for a duplicate's link (kanban #2745): with comments and history the faucet must not keep
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { if (req.url === '/api/tasks/77') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 77, title: 'Known payout bug', description: 'The payout spins after round two.', comments: [{ body: 'INTERNAL COMMENT' }], events: [{ action: 'HISTORY-EVENT' }] })); } res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_ORIGINS: PRIVATE,
      FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_BASES: STAGE, FAUCET_OPEN_ISSUES: join(dir, 'open.json'), FAUCET_KANBAN_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_KANBAN_KEY_FILE: join(dir, 'token') } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  const j = (p, o) => fetch(`${base}${p}`, o).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const [ann, bob, cat] = [key(1), key(2), key(3)];
    const report = async (k, words) => { const ev = signed(k, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: words }));
      const r = await j('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) }); assert.equal(r.ok, true, JSON.stringify(r)); return ev.id; };
    const r1 = await report(ann, 'The payout page spins forever after the second round of next block on testnet4');
    const r2 = await report(bob, 'Reading the code, the settle door accepts a commit word twice for the same round id');
    const r3 = await report(cat, 'A Season 1 style approval: the amount is the admin\'s own, as it always was here');

    // A LINK CODE FOR A SIGNED-IN KEY; another address in the sign-in is refused
    const auth = (k, url) => ({ authorization: `Nostr ${Buffer.from(JSON.stringify(signed(k, HTTP_AUTH_KIND, [['u', url], ['method', 'POST']]))).toString('base64')}` });
    assert.equal((await j('/feedback/link', { method: 'POST' })).status, 401);
    assert.equal((await j('/feedback/link', { method: 'POST', headers: auth(ann, 'https://elsewhere.example/link') })).status, 401);
    const code = await j('/feedback/link', { method: 'POST', headers: auth(ann, `${STAGE}/link`) });
    assert.equal(code.ok, true); assert.match(code.code, /^BA-[A-Z2-9]{8}$/);
    // the bot redeems it and stores Telegram membership (this faucet has no live verifier: the stored read stands)
    { const s = openBountySeason(s2db); assert.equal(s.redeem(code.code, { platform: 'telegram', userId: '42', username: '@ann' }).ok, true);
      s.record(ann.pubkey, 'telegram', { member: true });
      // Week 2 (kanban #2641): a second community for the +25 %
      assert.equal(s.claimName(ann.pubkey, 'discord', { userId: '43', username: 'ann' }).ok, true); s.record(ann.pubkey, 'discord', { member: true }); s.close(); }
    const v = await j('/feedback/verify', { method: 'POST', headers: auth(ann, `${STAGE}/verify`) });
    assert.equal(v.ok, true); assert.equal(v.flags.telegram, true); assert.equal(v.links[0].userId, undefined, 'no platform id goes back');
    // WEEK 2'S SOCIAL SCREEN (kanban #2641): no names answers the stored links and the bonus; a platform this faucet has no reader for says so
    const soc = await j('/feedback/social', { method: 'POST', headers: { ...auth(ann, `${STAGE}/social`), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(soc.ok, true, JSON.stringify(soc)); assert.equal(soc.bonusPct, 20); assert.deepEqual(soc.flags, { telegram: true, discord: true, x: false, armada: false, nostr: false });
    assert.equal(soc.links.some((l) => l.userId), false, 'no platform id goes back');
    const soc2 = await j('/feedback/social', { method: 'POST', headers: { ...auth(ann, `${STAGE}/social`), 'content-type': 'application/json' }, body: JSON.stringify({ x: 'ann' }) });
    assert.equal(soc2.results.x.member, null); assert.match(soc2.results.x.why, /not on/);
    assert.equal((await j('/feedback/social', { method: 'POST', headers: auth(bob, `${STAGE}/verify`), body: '{}' })).status, 401, 'signed for another door');

    // SEASON 2 APPROVALS: high + Telegram + Discord (2 of 3, kanban #2641) = 6,000; code-only critical without links = 5,000. The admin's amount is not what counts
    const a1 = await act({ action: 'approve', id: r1, severity: 'high', season2: true, amountSats: 99 });
    assert.equal(a1.ok, true, JSON.stringify(a1)); assert.equal(a1.report.amountSats, 6000); assert.equal(a1.season2.bonusPct, 20);
    const a2 = await act({ action: 'approve', id: r2, severity: 'critical', season2: true, codeOnly: true });
    assert.equal(a2.ok, true, JSON.stringify(a2)); assert.equal(a2.report.amountSats, 5000); assert.equal(a2.season2.codeOnly, true);
    assert.equal((await act({ action: 'approve', id: r1, severity: 'high', season2: true })).ok, false, 'not twice');
    // SEASON 1'S PATH UNCHANGED: no season2 flag, the admin's amount
    const a3 = await act({ action: 'approve', id: r3, severity: 'low', amountSats: 1000 });
    assert.equal(a3.ok, true); assert.equal(a3.report.amountSats, 1000); assert.equal(a3.season2, undefined);
    const pay = await act({ action: 'payable', id: r1 });
    assert.equal(pay.payableSats, 6000);

    const season = await j('/feedback/season');
    assert.deepEqual({ s: season.season, used: season.usedSats, left: season.leftSats }, { s: 2, used: 11000, left: 89000 });
    const adm = await j('/feedback/admin/season', { headers: { 'x-arena-admin': ADMIN } });
    assert.equal(adm.approvals.length, 2);
    const entries = await act({ action: 'draw-entries', season: 2 });
    assert.deepEqual(entries.entries, ['telegram:@ann']);
    const open = await j('/feedback/open-issues');
    assert.deepEqual(open.areas, [{ area: 'Slashing', tickets: ['#1155'] }]);
    // A DUPLICATE OF TICKET #77 (kanban #2745): rejected with dupTicket, the ticket's text behind the report's own token; an unknown token is 404
    const r4 = await report(cat, 'The payout page spins forever, the same thing the team has on a ticket already.');
    const rej = await act({ action: 'reject', id: r4, reason: 'Thanks for the report. This is a duplicate of a known issue (ticket #77).', dupTicket: 77 });
    assert.equal(rej.ok, true, JSON.stringify(rej)); assert.deepEqual(rej.dupLink, { ok: true, report: r4, ticket: 77 });
    const { DatabaseSync } = await import('node:sqlite'); const kdb = new DatabaseSync(db, { readOnly: true });
    const tok = kdb.prepare('SELECT token FROM dup_links WHERE report = ?').get(r4).token; kdb.close();
    const page = await fetch(`${base}/feedback/dup/${tok}`);
    assert.equal(page.status, 200); assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text(); assert.match(html, /Ticket #77: Known payout bug/); assert.match(html, /spins after round two/);
    assert.equal(html.includes('INTERNAL COMMENT') || html.includes('HISTORY-EVENT'), false, 'no comments, no history');
    assert.equal((await fetch(`${base}/feedback/dup/${'0'.repeat(32)}`)).status, 404);
    assert.equal(JSON.stringify(await j('/feedback/admin/list', { headers: { 'x-arena-admin': ADMIN } })).includes(tok), false, 'the token is not in the admin list');
    const log = await fetch(`${base}/feedback/paid-log`).then((r) => r.json());
    assert.deepEqual(log, [], 'nothing was paid: approval only computes and records');
  } finally { faucet.kill(); chatServer.close(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
});
