#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA FAUCET (kanban #635): testnet4 coins for a new node's installer, from a bitcoind wallet of our own coins. The rules are
// src/faucet.js (an address once, an IP a few times a day, a daily cap). One request at a time, so two can never both pass the book.
//
//   POST /faucet { address, sats }  -> { ok, txid, sats } or { ok: false, why }
//   GET  /faucet                    -> { ok, balanceSats, maxSats, leftTodaySats }
//   POST /player { kind: welcome | topup, account, invoice } -> { ok, sats } or { ok: false, why } (kanban #926: a player's test sats over Lightning)
//   POST /opponent { round }  GET /opponent : a table with somebody at it (kanban #926), said by the page, read by tools/rps-opponent.mjs
//   GET  /player                    -> what was given, new accounts and returning apart (no account, no address)
//   POST /feedback { event? , text?, build?, game?, round?, player? } -> a report: posted to Arena Chat; a signed `event` (kind 27842) is also kept for review (kanban #1342)
//   GET  /feedback/mine  (Authorization: Nostr <base64 NIP-98 event>) -> the signed-in key's own reports and their states (kanban #1342)
//                                   FAUCET_FEEDBACK_DB (the store), FAUCET_FEEDBACK_MINE_URLS (the public URLs a sign-in may name, comma separated)
//   GET  /lnurlw/<k1>               -> LUD-03 withdrawRequest of an approved report's reward (kanban #1342); /lnurlw/<k1>/callback?k1=&pr= pays it once
//                                   FAUCET_BOUNTY_PAYER=<lnddir>|<rpc host:port> (the bounty wallet, its own), FAUCET_PUBLIC_BASE (the public /api/faucet URL),
//                                   FAUCET_BOUNTY_NETWORK (testnet4: phase 1 is testnet only)
//                                   FAUCET_LNCLI, FAUCET_PAYERS=<lnddir>|<rpc host:port>,... : the second pays when an invoice's gateway is on the first
//
// Each payment's txid is appended to FAUCET_PENDING, which the the test host's miner-C feeder (ops/pending-to-minerc.sh) lists for mining.
//   FAUCET_PORT  FAUCET_RPC_URL (with /wallet/<name>)  FAUCET_COOKIE  FAUCET_BOOK  FAUCET_PENDING  [FAUCET_FEE_RATE sat/vB, 2]
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { openFeedbackStore } from '../src/feedback-store.js';
import { refillDecide, feedbackDecide, faucetDecide, playerGrantDecide, playerGrantTotals, opponentWant, opponentWants, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS, DAY_MS } from '../src/faucet.js';

const env = process.env;
const port = Number(env.FAUCET_PORT || 18866);
// WHO GAVE FEEDBACK UNDER THEIR KEY, AND WHO HOLDS THE BADGE FOR IT (kanban #926 item 8)
const FOUNDING_FILE = env.FAUCET_FOUNDING_FILE || 'founding-feedback.jsonl', FOUNDING_STATE = env.FAUCET_FOUNDING_STATE || 'founding-state.json';
const feeRate = Number(env.FAUCET_FEE_RATE || 2);
const rpc = async (method, params = []) => {
  const auth = Buffer.from(readFileSync(env.FAUCET_COOKIE, 'utf8').trim()).toString('base64');
  const r = await fetch(env.FAUCET_RPC_URL, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'faucet', method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const REPORTS = [];   // this day's reports: their count and address, in memory
// THE REPORTS KEPT FOR REVIEW (kanban #1342): one SQLite file beside the book; none when FAUCET_FEEDBACK_DB is not set
const FEEDBACK = env.FAUCET_FEEDBACK_DB ? openFeedbackStore(env.FAUCET_FEEDBACK_DB) : null;
const MINE_URLS = String(env.FAUCET_FEEDBACK_MINE_URLS || 'https://testnet.bitcoinarena.io/api/faucet/feedback/mine').split(',').map((x) => x.trim()).filter(Boolean);
const readBook = () => { try { return JSON.parse(readFileSync(env.FAUCET_BOOK, 'utf8')); } catch { return { paid: [] }; } };
const saveBook = (b) => { writeFileSync(`${env.FAUCET_BOOK}.new`, JSON.stringify(b, null, 1)); renameSync(`${env.FAUCET_BOOK}.new`, env.FAUCET_BOOK); };
const balanceSats = async () => Math.round(Number((await rpc('getbalances')).mine.trusted) * 1e8);
// THE CALLER'S ADDRESS: the site's Worker names it (behind it x-forwarded-for is Cloudflare's), else the tunnel's header; no header, no limit by address
const ipOf = (req) => String(req.headers['x-arena-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

let queue = Promise.resolve();
const one = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

async function pay(ask) {
  const book = readBook();
  const d = faucetDecide(ask, book, { balanceSats: await balanceSats() });
  if (!d.ok) return d;
  const txid = await rpc('sendtoaddress', { address: ask.address, amount: (d.sats / 1e8).toFixed(8), replaceable: true, fee_rate: feeRate });
  book.paid.push({ address: ask.address, ip: ask.ip, sats: d.sats, atMs: Date.now(), txid });
  saveBook(book);
  appendFileSync(env.FAUCET_PENDING, `${txid}\n`);
  console.log(`${new Date().toISOString()} paid ${d.sats} sat to ${ask.address} (${ask.ip || 'no ip'}): ${txid}`);
  return { ok: true, txid, sats: d.sats };
}

const PAYERS = String(env.FAUCET_PAYERS || '').split(',').filter(Boolean).map((p) => { const [dir, rpcserver] = p.split('|'); return { dir, rpcserver }; });
const lncli = (payer, args, timeoutMs = 20000) => new Promise((res) => execFile(env.FAUCET_LNCLI, [`--lnddir=${payer.dir}`, '--network=testnet4', `--rpcserver=${payer.rpcserver}`, ...args],
  { timeout: timeoutMs }, (e, out, err) => res({ ok: !e, timedOut: !!(e && e.killed), out: String(out), err: String(err) })));

// THE BOUNTY WALLET (kanban #1342 section 3): its own payer, never the faucet's; the payout network one setting (testnet4 in phase 1)
const BOUNTY_PAYER = env.FAUCET_BOUNTY_PAYER ? (([dir, rpcserver]) => ({ dir, rpcserver }))(env.FAUCET_BOUNTY_PAYER.split('|')) : null;
const BOUNTY_NETWORK = env.FAUCET_BOUNTY_NETWORK || 'testnet4';
const PUBLIC_BASE = String(env.FAUCET_PUBLIC_BASE || 'https://testnet.bitcoinarena.io/api/faucet').replace(/\/$/, '');
const bountyDecode = async (invoice) => {
  if (!/^lntb[0-9a-z]{20,1500}$/.test(invoice)) return { ok: false };
  const r = await lncli(BOUNTY_PAYER, ['decodepayreq', invoice]);
  if (!r.ok) return { ok: false };
  const j = JSON.parse(r.out);
  return { ok: true, amountSats: Number(j.num_satoshis), paymentHash: j.payment_hash };
};
const bountyPay = async (invoice) => {
  const r = await lncli(BOUNTY_PAYER, ['payinvoice', '--force', '--timeout=60s', '--fee_limit=20', invoice], 75000);
  if (/Payment status: SUCCEEDED/.test(r.out)) { const h = /Payment hash: ([0-9a-f]{64})/.exec(r.out); return { ok: true, paymentHash: h ? h[1] : null }; }
  if (/Payment status: FAILED/.test(r.out) && !r.timedOut) return { ok: false, failed: true, why: (r.out.split('\n').find((l) => /reason/i.test(l)) || 'failed').trim().slice(0, 160) };
  return { ok: false, why: r.timedOut ? 'the payment timed out' : 'in flight' };
};
const bountyStatus = async (hash) => {
  const r = await lncli(BOUNTY_PAYER, ['listpayments', '--include_incomplete', '--max_payments=500', '--paginate_forwards=false'], 20000);
  if (!r.ok) return 'unknown';
  const p = (JSON.parse(r.out).payments || []).find((x) => x.payment_hash === hash);
  return !p ? 'failed' : p.status === 'SUCCEEDED' ? 'paid' : p.status === 'FAILED' ? 'failed' : 'unknown';
};
if (FEEDBACK && BOUNTY_PAYER) setInterval(() => FEEDBACK.settle({ status: bountyStatus }).catch(() => {}), 60000).unref();

/** A player's grant: read the invoice, decide, keep it in the book BEFORE paying (a crash pays nobody twice), and take it out again if no payer could pay. */
async function grant(ask) {
  if (!/^lntb[0-9a-z]{20,1500}$/.test(String(ask.invoice || ''))) return { ok: false, why: 'that is not a testnet invoice' };
  const read = await lncli(PAYERS[0], ['decodepayreq', ask.invoice]);
  if (!read.ok) return { ok: false, why: 'that invoice cannot be read' };
  const inv = JSON.parse(read.out);
  const book = readBook();
  book.players = book.players || [];
  const d = playerGrantDecide({ kind: ask.kind, account: ask.account, ip: ask.ip, invoiceSats: Number(inv.num_satoshis) }, book);
  if (!d.ok) return d;
  const row = { account: ask.account, kind: ask.kind, ip: ask.ip, sats: d.grant.invoiceSats, atMs: Date.now(), hash: inv.payment_hash };
  book.players.push(row);
  saveBook(book);
  const tried = [];
  for (const payer of PAYERS) {
    // A TIMEOUT IS NOT A REFUSAL: the federation's incoming contract holds the payment open until the client claims it (seen: "IN_FLIGHT", then Claimed)
    const paid = await lncli(payer, ['payinvoice', '--force', '--timeout=60s', '--fee_limit=20', ask.invoice], 15000);
    if (paid.timedOut || /Payment status: (SUCCEEDED|IN_FLIGHT)/.test(paid.out)) {
      console.log(`${new Date().toISOString()} player ${ask.kind} ${d.grant.invoiceSats} sat (${ask.ip || 'no ip'}): ${inv.payment_hash.slice(0, 16)}`);
      return { ok: true, sats: d.grant.sats };
    }
    tried.push((paid.err || paid.out).trim().slice(-160));
  }
  const after = readBook();
  after.players = (after.players || []).filter((p) => p.hash !== row.hash);
  saveBook(after);
  console.log(`${new Date().toISOString()} player ${ask.kind} not paid: ${tried.join(' | ')}`);
  return { ok: false, why: 'the faucet could not pay just now: try again in a minute' };
}

const WANTS = new Map();
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)?(testnet\.bitcoin-?arena\.io|bitcoin-arena-site\.pages\.dev)$/;
createServer((req, res) => {
  const origin = String(req.headers.origin || '');
  const cors = ORIGIN_OK.test(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
  const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
  // A TABLE WITH SOMEBODY AT IT (kanban #926): said by the page, read by the test opponent
  if (path === '/opponent' || path === '/faucet/opponent') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method === 'GET') return send(200, { ok: true, wants: opponentWants(WANTS) });
    if (req.method !== 'POST') return send(405, { ok: false, why: 'GET or POST' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 512) req.destroy(); });
    req.on('end', () => { try { const b = JSON.parse(raw || '{}'); send(200, opponentWant(WANTS, b.round, Date.now(), b.tapped === true)); } catch { send(400, { ok: false, why: 'not JSON' }); } });
    return undefined;
  }
  if (path === '/refill') {
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(raw || '{}'), want = readFileSync(env.FAUCET_REFILL_TOKEN_FILE, 'utf8').trim(), got = Buffer.from(String(b.token || ''));
        if (got.length !== want.length || !timingSafeEqual(got, Buffer.from(want))) return send(403, { ok: false, why: 'no' });
        if (!/^lntb[0-9a-z]{20,1500}$/.test(String(b.invoice || ''))) return send(200, { ok: false, why: 'that is not a testnet invoice' });
        const read = await lncli(PAYERS[0], ['decodepayreq', b.invoice]);
        if (!read.ok) return send(200, { ok: false, why: 'that invoice cannot be read' });
        const inv = JSON.parse(read.out), book = readBook(), d = refillDecide({ invoiceSats: Number(inv.num_satoshis) }, book);
        if (!d.ok) return send(200, d);
        book.refills = book.refills || []; book.refills.push({ sats: d.sats, atMs: Date.now(), hash: inv.payment_hash }); saveBook(book);
        for (const payer of PAYERS) {
          const paid = await lncli(payer, ['payinvoice', '--force', '--timeout=60s', '--fee_limit=20', b.invoice], 15000);
          if (paid.timedOut || /Payment status: (SUCCEEDED|IN_FLIGHT)/.test(paid.out)) { console.log(`${new Date().toISOString()} refill ${d.sats} sat: ${inv.payment_hash.slice(0, 16)}`); return send(200, { ok: true, sats: d.sats }); }
        }
        const after = readBook(); after.refills = (after.refills || []).filter((r) => r.hash !== inv.payment_hash); saveBook(after);
        send(200, { ok: false, why: 'could not pay just now' });
      } catch { send(400, { ok: false, why: 'not JSON' }); }
    });
    return undefined;
  }
  // A REWARD'S LNURL-WITHDRAW (kanban #1342, LUD-03): the request, then the callback that pays the wallet's invoice once - one at a time (one())
  { const m = /^\/lnurlw\/([0-9a-f]{64})(\/callback)?$/.exec(path);
    if (m) {
      if (!FEEDBACK || !BOUNTY_PAYER) return send(503, { status: 'ERROR', reason: 'rewards are not paid here' });
      if (!m[2]) return send(200, FEEDBACK.withdrawRequest(m[1], { base: PUBLIC_BASE }));
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.get('k1') !== m[1]) return send(200, { status: 'ERROR', reason: 'k1 does not match the link' });
      return one(() => FEEDBACK.claim(m[1], q.get('pr') || '', { decode: bountyDecode, pay: bountyPay })).then((r) => send(200, r), () => send(200, { status: 'ERROR', reason: 'try again in a minute' }));
    } }
  // "MY FEEDBACK" (kanban #1342): a NIP-98 sign-in by the reporter's key; the reports' reward links are bearer secrets, so never by pubkey alone
  if (path === '/feedback/mine') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '86400' }); return res.end(); }
    if (!FEEDBACK) return send(503, { ok: false, why: 'reports are not kept here' });
    let ev = null;
    try { const h = String(req.headers.authorization || ''); if (h.startsWith('Nostr ')) ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString('utf8')); } catch { ev = null; }
    if (!ev) return send(401, { ok: false, why: 'sign in with your key (NIP-98)' });
    let last = null;
    // EACH REPORT WITH ITS REWARD, IF ANY: its state and the link to claim it (lnurl + the stable /reward page)
    for (const url of MINE_URLS) { const m = FEEDBACK.mine(ev, { url, method: 'GET' });
      if (m.ok) { const byReport = new Map(FEEDBACK.rewards({ pubkey: m.pubkey }).map((w) => [w.report, w]));
        return send(200, { ...m, reports: m.reports.map((r) => { const w = byReport.get(r.id);
          return { ...r, reward: w ? { sats: w.amountSats, network: w.network, state: w.state, lnurl: w.state === 'paid' ? null : FEEDBACK.lnurlOf(w.k1, { base: PUBLIC_BASE }) } : null }; }) }); }
      last = m; }
    return send(401, { ok: false, why: last ? last.why : 'that sign-in does not stand' });
  }
  if (path === '/feedback') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    if (!env.FAUCET_CHAT_URL) return send(503, { ok: false, why: 'reports are off' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 24576) req.destroy(); });
    req.on('end', async () => {
      try {
        const b0 = JSON.parse(raw || '{}'), ip = req.headers['x-arena-ip'] || null;
        // A SIGNED REPORT (kanban #1342): its own words go to the chat, and it is kept for review - only if it stands
        let b = b0, kept = null;
        if (b0.event) {
          if (!FEEDBACK) return send(503, { ok: false, why: 'signed reports are not kept here' });
          const e = b0.event;
          const tagOf = (k) => { const t = Array.isArray(e.tags) ? e.tags.find((x) => Array.isArray(x) && x[0] === k) : null; return t ? String(t[1] ?? '') : ''; };
          let words = {}; try { words = JSON.parse(e.content); } catch { words = {}; }
          b = { ...b0, text: `${String(words.happened || '')}${words.expected ? `\nExpected: ${String(words.expected)}` : ''}`, build: tagOf('build'), game: tagOf('game'), round: tagOf('round') };
          const pre = feedbackDecide({ ...b, ip }, REPORTS);
          if (!pre.ok) return send(200, pre);
          kept = FEEDBACK.take(e);
          if (!kept.ok) return send(200, kept);
        }
        const d = feedbackDecide({ ...b, ip }, REPORTS);
        if (!d.ok) return send(200, d);
        const key = readFileSync(env.FAUCET_CHAT_TOKEN_FILE, 'utf8').trim();
        const r = await fetch(`${env.FAUCET_CHAT_URL}/api/channels/${env.FAUCET_CHAT_CHANNEL}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ text: d.text }), signal: AbortSignal.timeout(10000) });
        if (!r.ok) return send(502, { ok: false, why: 'the report could not be kept just now' });
        REPORTS.push({ ip, atMs: Date.now() });
        if (d.player) appendFileSync(FOUNDING_FILE, `${JSON.stringify({ player: d.player, atMs: Date.now() })}\n`);
        send(200, { ok: true, ...(kept ? { id: kept.id, kept: kept.kept } : {}) });
      } catch { send(400, { ok: false, why: 'not JSON' }); }
    });
    return undefined;
  }
  // HOLDS THIS KEY THE FOUNDING TESTER BADGE (kanban #926 item 8): the awards tools/founding-badges.mjs made, for the page's own line
  if (path === '/founding') {
    const key = String(new URL(req.url, 'http://x').searchParams.get('player') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return send(400, { ok: false, why: 'a player is 32 bytes of hex' });
    let held = {}; try { held = JSON.parse(readFileSync(FOUNDING_STATE, 'utf8')).awarded || {}; } catch { held = {}; }
    return send(200, { ok: true, founding: !!held[key], event: held[key] ? held[key].event : null });
  }
  if (path === '/player' || path === '/faucet/player') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    // THE TOTALS ARE PUBLIC (no account, no address): any node's dashboard reads them, from its own address
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ ok: true, ...playerGrantTotals(readBook()) })); }
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    if (!PAYERS.length) return send(503, { ok: false, why: 'the players\' faucet is off' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let ask;
      try { ask = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, why: 'not JSON' }); }
      one(() => grant({ kind: ask.kind, account: ask.account, invoice: ask.invoice, ip: ipOf(req) }))
        .then((r) => send(200, r), (e) => { console.log(`${new Date().toISOString()} player failed: ${e.message}`); send(500, { ok: false, why: 'the faucet could not pay just now' }); });
    });
    return undefined;
  }
  if (path !== '' && path !== '/faucet') return send(404, { ok: false, why: 'no such door' });
  if (req.method === 'GET') {
    return one(async () => {
      const day = Math.floor(Date.now() / DAY_MS);
      const given = readBook().paid.filter((p) => Math.floor(p.atMs / DAY_MS) === day).reduce((a, p) => a + p.sats, 0);
      return { ok: true, balanceSats: await balanceSats(), maxSats: FAUCET_MAX_SATS, leftTodaySats: Math.max(0, FAUCET_DAY_CAP_SATS - given) };
    }).then((b) => send(200, b), (e) => send(500, { ok: false, why: e.message }));
  }
  if (req.method !== 'POST') return send(405, { ok: false, why: 'GET or POST' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let ask;
    try { ask = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, why: 'not JSON' }); }
    one(() => pay({ address: ask.address, sats: ask.sats, ip: ipOf(req) }))
      .then((r) => send(200, r), (e) => { console.log(`${new Date().toISOString()} failed: ${e.message}`); send(500, { ok: false, why: `the faucet could not pay: ${e.message}` }); });
  });
}).listen(port, '127.0.0.1', () => console.log(`faucet on 127.0.0.1:${port}`));
