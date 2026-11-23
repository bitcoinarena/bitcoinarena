// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2756, #1489 r7 faucet 3 (P7 money before certainty / P1): the Week 2 community bonus is read at approval and, by the rule (the owner 2026-11-14,
// kanban #2641: "tun ggf nochmal den Betrag reduzieren wenn der User nicht mehr in den angegeben socials ist"), read again before payout -
// S2.payable() stores the lower amount (payable_sats) when a community was left. Nothing reads it: the admin's `reward` action (createReward, and
// payToAddress after it) pays reports.amount_sats, the amount approved WITH the bonus. A reporter joins Telegram + Discord and follows X for the
// approval (+50 %), leaves all three, and the reward link and the address payout still pay the full +50 % - also after the admin's own "payable"
// check said less.
// Safe: once the payout check says the bonus is gone, the reward made for the report pays at most the payable amount.
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
import { FEEDBACK_KIND } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const PRIVATE = 'https://stage.example';
const ADMIN = 'admin-code-r7-3';

for (const early of [false, true]) test(`#1489-r7-faucet-3 a Week 2 bonus lost before payout is not paid: the reward pays at most the payable amount${early ? ' (kanban #2756: its open link, made before she left, is lowered)' : ''}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r7-faucet-3-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db'), s2db = join(dir, 'season2.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_BOUNTY_ORIGINS: PRIVATE,
      FAUCET_ADMIN_SHA256: createHash('sha256').update(ADMIN).digest('hex'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_START: new Date(Date.now() - 3600000).toISOString(),
      FAUCET_BOUNTY_TG_USERBOT: 'off', FAUCET_BOUNTY_NETWORK: 'mainnet' } });
  let err = ''; faucet.stderr.on('data', (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  const j = (p, o) => fetch(`${base}${p}`, o).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const act = (b) => j('/feedback/admin/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': ADMIN }, body: JSON.stringify(b) });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const eve = key(7);
    const ev = signed(eve, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The round page keeps the old stake after a reload and the order button stays grey for good' }));
    const sent = await j('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    // at approval: a member of Telegram and Discord and an X follower (links read live and fresh) -> +50 %
    { const s = openBountySeason(s2db);
      for (const [p, id] of [['telegram', '701'], ['discord', '702'], ['x', '703']]) { { const c = s.makeCode(eve.pubkey); assert.equal(s.redeem(c.code, { platform: p, userId: id, username: `eve-${p}` }).ok, true); } s.record(eve.pubkey, p, { member: true }); }   // kanban #2645: proven by code
      s.close(); }
    const a = await act({ action: 'approve', id: ev.id, severity: 'high', season2: true });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.ok(a.season2.bonusPct > 0, 'the approval carries the community bonus');   // (kanban #2756: the bonus rate is the season's, not a fixed 50)
    const approved = a.report.amountSats;   // 5,000 + 50 % = 7,500
    // (kanban #2756) the link made while she was still a member, not yet withdrawn
    if (early) { const w0 = await act({ action: 'reward', id: ev.id, payTo: 'link' }); assert.equal(w0.ok, true, JSON.stringify(w0)); assert.equal(w0.reward.amountSats, approved); }
    // then she leaves all three: the next live read says no member
    { const s = openBountySeason(s2db); for (const p of ['telegram', 'discord', 'x']) s.record(eve.pubkey, p, { member: false, why: 'left', cause: 'payout' }); s.close(); }
    const pay = await act({ action: 'payable', id: ev.id });
    assert.equal(pay.ok, true, JSON.stringify(pay));
    // the admin makes the reward (the withdraw link; with an address it is payToAddress for the same amount)
    const w = await act({ action: 'reward', id: ev.id, payTo: 'link' });
    assert.equal(w.ok, true, JSON.stringify(w));
    console.log('  MEASURED:', JSON.stringify({ approvedSats: approved, payableSats: pay.payableSats, payableWhy: pay.why, rewardSats: w.reward.amountSats }));
    assert.ok(pay.payableSats < approved, 'the payout check sees the bonus is gone');
    assert.ok(w.reward.amountSats <= pay.payableSats, `the reward pays ${w.reward.amountSats} sat though the payout check said ${pay.payableSats} (approved ${approved} with the +50 % bonus)`);
  } finally { faucet.kill(); chatServer.close(); if (err.trim()) console.log('  stderr:', err.slice(0, 400)); }
});
