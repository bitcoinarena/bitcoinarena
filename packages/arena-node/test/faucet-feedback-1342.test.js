// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1342 slice 1, through the faucet itself: tools/faucet.mjs run as a process with a store in a temp folder and a stand-in for Arena Chat.
// An unsigned report goes to the chat as before and is not kept; a signed one goes to the chat and is kept; a forged one goes nowhere;
// GET /feedback/mine answers the reporter's NIP-98 sign-in for the configured URL and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { FEEDBACK_KIND, HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const signed = (k, kind, tags, content = '') => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return e; };
const MINE = 'https://testnet.example/api/faucet/feedback/mine';
const PRIVATE = 'https://arena-fb-private.example';

test('#1342 the faucet keeps a signed report, still posts every report to the chat, and answers "My feedback" to its reporter only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'faucet-1342-'));
  const chat = [];
  const chatServer = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { chat.push(JSON.parse(b).text); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const post = async (body) => (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.0.0.1' }, body: JSON.stringify(body) })).json();
    const alice = key(1), bob = key(2);
    const report = signed(alice, FEEDBACK_KIND, [['t', 'bug'], ['game', 'rock-paper-scissors'], ['build', 'UI 577']], JSON.stringify({ happened: 'The reveal never came back', expected: 'the result' }));
    const unsigned = await post({ text: 'an old-style report, no key', build: 'UI 577' });
    const kept = await post({ event: report });
    const forged = await post({ event: { ...report, content: JSON.stringify({ happened: 'swapped words' }) } });
    const mine = async (ev) => { const r = await fetch(`${base}/feedback/mine`, { headers: ev ? { authorization: `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}` } : {} }); return { status: r.status, ...(await r.json()) }; };
    const own = await mine(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]));
    const bobs = await mine(signed(bob, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]));
    const wrongUrl = await mine(signed(alice, HTTP_AUTH_KIND, [['u', 'https://evil.example/feedback/mine'], ['method', 'GET']]));
    const none = await mine(null);
    const facts = { unsigned, kept, forged: forged.why, chatLines: chat.length, chatHasSignedWords: chat.some((t) => t.includes('The reveal never came back')),
      aliceSees: own.reports && own.reports.map((r) => [r.type, r.state, r.happened]), bobSees: bobs.reports && bobs.reports.length, wrongUrl: [wrongUrl.status, wrongUrl.why], none: [none.status, none.why] };
    console.log('  FACTS #1342 faucet:', JSON.stringify(facts));
    assert.deepEqual(unsigned, { ok: true });
    assert.deepEqual([kept.ok, kept.kept, kept.id], [true, true, report.id]);
    assert.ok(forged.why, 'a forged report was taken');
    assert.equal(chat.length, 2, 'the unsigned and the signed report reach the chat; the forged one does not');
    assert.ok(facts.chatHasSignedWords);
    assert.deepEqual(facts.aliceSees, [['bug', 'new', 'The reveal never came back']]);
    assert.equal(facts.bobSees, 0, 'another key sees none of hers');
    assert.equal(wrongUrl.status, 401);
    assert.equal(none.status, 401);
  } finally {
    faucet.kill(); chatServer.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('#1342 the faucet\'s LNURL-withdraw: the request for exactly the reward, one payment through the bounty wallet, the report paid, "My feedback" shows the link until then', async () => {
  const { chmodSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'faucet-lnurlw-1342-'));
  // A STAND-IN lncli: decodepayreq reads the amount from the invoice's text, payinvoice succeeds once per invoice and logs it
  const lncli = join(dir, 'lncli');
  writeFileSync(lncli, `#!/bin/bash
cmd=""; for a in "$@"; do case "$a" in decodepayreq|payinvoice|listpayments) cmd="$a";; esac; done
inv="\${@: -1}"
case "$cmd" in
  decodepayreq) sats=$(echo "$inv" | sed -E 's/^lntb([0-9]+)x.*/\\1/'); echo "{\\"num_satoshis\\":\\"$sats\\",\\"payment_hash\\":\\"$(echo -n "$inv" | sha256sum | cut -c1-64)\\"}";;
  payinvoice) echo "$inv" >> "${join(dir, 'paid.log')}"; echo "Payment hash: $(echo -n "$inv" | sha256sum | cut -c1-64)"; echo "Payment status: SUCCEEDED";;
  listpayments) echo '{"payments":[]}';;
esac
`);
  chmodSync(lncli, 0o755);
  writeFileSync(join(dir, 'token'), 'x');
  const chatServer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chatServer.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000), db = join(dir, 'feedback.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chatServer.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: db, FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_LNCLI: lncli, FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const alice = key(1);
    const ev = signed(alice, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'The withdraw spinner never stops' }));
    await (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    // the admin approves it and makes the link (slice 4's buttons), on the same file
    const { openFeedbackStore } = await import('../src/feedback-store.js');
    const admin = openFeedbackStore(db);
    admin.approve(ev.id, 2500, { played: () => true, by: 'admin' });
    const k1 = admin.createReward(ev.id).reward.k1;
    admin.close();
    const mineNow = async (origin = PRIVATE) => (await fetch(`${base}/feedback/mine`, { headers: { origin, authorization: `Nostr ${Buffer.from(JSON.stringify(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]))).toString('base64')}` } })).json();
    const before = await mineNow();
    const req = await (await fetch(`${base}/lnurlw/${k1}`)).json();
    const cb = (pr, k = k1) => fetch(`${base}/lnurlw/${k1}/callback?k1=${k}&pr=${pr}`).then((r) => r.json());
    const wrongK1 = await cb('lntb2500x1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ff'.repeat(32));
    const wrongAmount = await cb('lntb2400x1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const [one, two] = await Promise.all([cb('lntb2500x1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), cb('lntb2500x1ccccccccccccccccccccccccccccccc')]);
    const after = await mineNow();
    const publicView = await mineNow('https://testnet.bitcoinarena.io');
    const reqAfter = await (await fetch(`${base}/lnurlw/${k1}`)).json();
    let paidLines = []; try { paidLines = readFileSync(join(dir, 'paid.log'), 'utf8').trim().split('\n'); } catch { paidLines = []; }
    const facts = { before: before.reports.map((r) => [r.state, r.reward && r.reward.sats, r.reward && r.reward.lnurl && r.reward.lnurl.slice(0, 8)]), req: [req.tag, req.maxWithdrawable, req.callback],
      wrongK1: wrongK1.reason, wrongAmount: wrongAmount.reason, claims: [one.status, two.status], paidOnce: paidLines.length,
      after: after.reports.map((r) => [r.state, r.reward && r.reward.state, r.reward && r.reward.lnurl]), reqAfter: reqAfter.reason };
    console.log('  FACTS #1342 lnurlw:', JSON.stringify(facts));
    assert.deepEqual(facts.before, [['accepted', 2500, 'lnurl1dp']]);
    assert.deepEqual([req.tag, req.maxWithdrawable, req.callback], ['withdrawRequest', 2500000, `https://testnet.example/api/faucet/lnurlw/${k1}/callback`]);
    assert.match(facts.wrongK1, /k1 does not match/);
    assert.match(facts.wrongAmount, /exactly 2500 sat/);
    assert.deepEqual(facts.claims.sort(), ['ERROR', 'OK']);
    assert.equal(facts.paidOnce, 1, 'the bounty wallet paid more than once');
    assert.deepEqual(facts.after, [['paid', 'paid', null]], 'paid: the report and the reward, and no link left to claim');
    assert.deepEqual(publicView.reports.map((r) => [r.state, r.reward]), [['paid', null]], 'the public page is shown no reward (the owner\'s switch)');
    assert.match(facts.reqAfter, /claimed/);
  } finally { faucet.kill(); chatServer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('#1342 the review list behind the admin code: who played and who is ours, approval refused by the rules, the link made, the CSV', async () => {
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'faucet-admin-1342-'));
  const alice = key(1), bob = key(2), carol = key(3);
  const seat = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ rows: [{ player: alice.pubkey, rounds: 2 }, { player: carol.pubkey, rounds: 5 }] })); });
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => seat.listen(0, '127.0.0.1', r)); await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x'); writeFileSync(join(dir, 'ours.txt'), `${carol.pubkey}\n`);
  const CODE = 'the-owners-code', port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_ADMIN_SHA256: createHash('sha256').update(CODE).digest('hex'), FAUCET_FEEDBACK_EXCLUDED: join(dir, 'ours.txt'), FAUCET_SEASON_SEATS: `http://127.0.0.1:${seat.address().port}`,
      FAUCET_SEASON_GAMES: 'rock-paper-scissors', FAUCET_REWARD_RULES: JSON.stringify({ weeklyBudgetSats: 10000, mostSats: 5000 }), FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1`, FAUCET_PUBLIC_BASE: 'https://testnet.example/api/faucet', FAUCET_BOUNTY_ORIGINS: PRIVATE } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ids = {};
    for (const [name, k] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
      const ev = signed(k, FEEDBACK_KIND, [['t', 'bug'], ['game', 'rock-paper-scissors']], JSON.stringify({ happened: `${name}: the lobby froze` }));
      await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': `10.0.0.${ids[name] ? 9 : Object.keys(ids).length + 1}` }, body: JSON.stringify({ event: ev }) });
      ids[name] = ev.id;
    }
    const get = async (p, c = CODE) => { const r = await fetch(`${base}/feedback/admin/${p}`, { headers: c ? { 'x-arena-admin': c } : {} }); return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() }; };
    const act = async (b) => (await fetch(`${base}/feedback/admin/act`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': CODE }, body: JSON.stringify(b) })).json();
    const noCode = await get('list', null), wrongCode = await get('list', 'guess');
    const list = await get('list');
    const flags = Object.fromEntries(list.body.reports.map((r) => [r.happened.split(':')[0], { played: r.played, ours: r.ours }]));
    const bobApproval = await act({ id: ids.bob, action: 'approve', amountSats: 1000 });
    const carolApproval = await act({ id: ids.carol, action: 'approve', amountSats: 1000 });
    const aliceApproval = await act({ id: ids.alice, action: 'approve', amountSats: 2000, severity: 'medium' });
    const reward = await act({ id: ids.alice, action: 'reward' });
    const bobReject = await act({ id: ids.bob, action: 'reject', reason: 'no round finished yet: play one and send it again' });
    const detail = await get(`report/${ids.alice}`);
    const after = await get('list');
    const csv = await get('export.csv');
    const facts = { noCode: noCode.status, wrongCode: wrongCode.status, flags, bob: bobApproval.why, carol: carolApproval.why, alice: aliceApproval.ok, reward: reward.ok && reward.lnurl.slice(0, 8),
      bobRejected: bobReject.ok, moves: detail.body.moves.map((m) => `${m.from}>${m.to}`), budget: after.body.budget.weekApprovedSats, open: after.body.budget.openRewards, csvLines: csv.body.trim().split('\n').length,
      csvHasAlice: csv.body.includes(ids.alice) && csv.body.includes('"accepted"') && csv.body.includes('"2000"') };
    console.log('  FACTS #1342 admin:', JSON.stringify(facts));
    assert.deepEqual([noCode.status, wrongCode.status], [403, 403]);
    assert.deepEqual(flags, { alice: { played: true, ours: false }, bob: { played: false, ours: false }, carol: { played: true, ours: true } });
    assert.match(facts.bob, /not finished a round/);
    assert.match(facts.carol, /ours/);
    assert.equal(facts.alice, true);
    assert.equal(facts.reward, 'lnurl1dp');
    assert.equal(facts.bobRejected, true);
    assert.deepEqual(facts.moves, ['new>accepted', 'accepted>accepted']);
    assert.deepEqual([facts.budget, facts.open.n, facts.open.s], [2000, 1, 2000]);
    assert.equal(facts.csvLines, 4);
    assert.ok(facts.csvHasAlice);
  } finally { faucet.kill(); seat.close(); chat.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('#1342 the bounty is off until the owner turns it on: no private origin set, no approval for money, no link, no /lnurlw, no reward in My feedback', async () => {
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'faucet-off-1342-'));
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'token'), 'x');
  const CODE = 'the-owners-code', port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FEEDBACK_MINE_URLS: MINE, FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_ADMIN_SHA256: createHash('sha256').update(CODE).digest('hex'), FAUCET_BOUNTY_PAYER: `${dir}|127.0.0.1:1` } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/mine`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const alice = key(1);
    const ev = signed(alice, FEEDBACK_KIND, [['t', 'bug']], JSON.stringify({ happened: 'something broke while the bounty is off' }));
    const sent = await (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: ev }) })).json();
    const act = async (b) => { const r = await fetch(`${base}/feedback/admin/act`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-admin': CODE }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
    const approve = await act({ id: ev.id, action: 'approve', amountSats: 1000 });
    const reward = await act({ id: ev.id, action: 'reward' });
    const reject = await act({ id: ev.id, action: 'reject', reason: 'cannot reproduce, please add the steps' });
    const lnurlw = await fetch(`${base}/lnurlw/${'ab'.repeat(32)}`);
    const mine = await (await fetch(`${base}/feedback/mine`, { headers: { origin: 'https://arena-fb-private.example', authorization: `Nostr ${Buffer.from(JSON.stringify(signed(alice, HTTP_AUTH_KIND, [['u', MINE], ['method', 'GET']]))).toString('base64')}` } })).json();
    const facts = { sent: sent.kept, approve: [approve.status, approve.why], reward: reward.status, reject: reject.ok, lnurlw: [lnurlw.status, (await lnurlw.json()).reason], mine: mine.reports.map((r) => [r.state, r.reward, r.reason]) };
    console.log('  FACTS #1342 off:', JSON.stringify(facts));
    assert.equal(facts.sent, true, 'reports are still kept');
    assert.equal(approve.status, 403); assert.match(approve.why, /rewards are off/);
    assert.equal(reward.status, 403);
    assert.equal(facts.reject, true, 'a rejection with its reason still works');
    assert.deepEqual(facts.lnurlw, [503, 'rewards are off']);
    assert.deepEqual(facts.mine, [['rejected', null, 'cannot reproduce, please add the steps']]);
  } finally { faucet.kill(); chat.close(); rmSync(dir, { recursive: true, force: true }); }
});
