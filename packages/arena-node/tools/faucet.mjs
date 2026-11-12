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
//                                   FAUCET_LNCLI, FAUCET_PAYERS=<lnddir>|<rpc host:port>,... : the second pays when an invoice's gateway is on the first
//
// Each payment's txid is appended to FAUCET_PENDING, which the the test host's miner-C feeder (ops/pending-to-minerc.sh) lists for mining.
//   FAUCET_PORT  FAUCET_RPC_URL (with /wallet/<name>)  FAUCET_COOKIE  FAUCET_BOOK  FAUCET_PENDING  [FAUCET_FEE_RATE sat/vB, 2]
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { PLAYER_GRANTS } from '../src/faucet.js';
const PLAYER_WELCOME_SATS = PLAYER_GRANTS.welcome.invoiceSats;
import { refillDecide, feedbackDecide, faucetDecide, playerGrantDecide, playerGrantTotals, ipKey, opponentWant, opponentWants, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS, DAY_MS } from '../src/faucet.js';

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
  if (j.error) throw Object.assign(new Error(j.error.message), { rpcRefused: true });   // bitcoind answered and refused (kanban #1572)
  return j.result;
};
const REPORTS = [];   // this day's reports: their count and address, in memory
const readBook = () => { try { return JSON.parse(readFileSync(env.FAUCET_BOOK, 'utf8')); } catch { return { paid: [] }; } };
const saveBook = (b) => { writeFileSync(`${env.FAUCET_BOOK}.new`, JSON.stringify(b, null, 1)); renameSync(`${env.FAUCET_BOOK}.new`, env.FAUCET_BOOK); };
const balanceSats = async () => Math.round(Number((await rpc('getbalances')).mine.trusted) * 1e8);
// THE CALLER'S ADDRESS: the site's Worker names it (behind it x-forwarded-for is Cloudflare's), else the tunnel's header; no header, no limit by address
// ONLY THE WORKER NAMES IT (audit 8, kanban #1434): x-arena-ip counts with the Worker's key (FAUCET_WORKER_KEY); any other caller - straight over
// the tunnel - is the address the tunnel itself added last to x-forwarded-for, whatever the caller wrote before it
const WORKER_KEY = String(env.FAUCET_WORKER_KEY || '');
const fromWorker = (req) => { const k = String(req.headers['x-arena-worker'] || ''); return !!WORKER_KEY && k.length === WORKER_KEY.length && timingSafeEqual(Buffer.from(k), Buffer.from(WORKER_KEY)); };
const ipOf = (req) => {
  if (!WORKER_KEY) return String(req.headers['x-arena-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
  if (fromWorker(req)) return String(req.headers['x-arena-ip'] || '').trim() || null;
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : (req.socket && req.socket.remoteAddress) || null;
};

let queue = Promise.resolve();
const one = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
// a welcome answered again to the same caller (its address, an IPv6 /64) within this long: its first answer may never have reached the page
const WELCOME_REISSUE_MS = 15 * 60 * 1000;

// THE ADDRESS IS BOOKED BEFORE THE SEND (state audit 2026-11-12, kanban #1572): pay() sent first and booked after, so a sendtoaddress that bitcoind
// committed but answered after the 30 s RPC timeout (a big wallet, a busy node) - or a crash between the send and saveBook - left coins sent to an
// address with no row, and the installer's retry of the same address was paid again. The row is now written first (`pending`, no txid), as the
// players' grant does. It is taken out again only when bitcoind refused the send, or the wallet shows no send to that address; any other failure
// keeps it (the address is never paid twice; a row without its txid is the worst case).
async function walletSentTo(address) {
  // the wallet's own record: a txid when it sent to the address, 'none' when it holds no such send, null when it cannot say
  try {
    const txs = await rpc('listtransactions', ['*', 1000, 0, true]);
    if (!Array.isArray(txs)) return null;
    const t = txs.find((x) => x && x.category === 'send' && x.address === address);
    return t ? String(t.txid) : 'none';
  } catch { return null; }
}
async function pay(ask) {
  const book = readBook();
  const d = faucetDecide(ask, book, { balanceSats: await balanceSats() });
  if (!d.ok) return d;
  // THE BOOK AS IT IS NOW (kanban #1573): the copy read before the awaits was saved whole, and a refill booked by POST /refill (outside the queue),
  // the payment sweep's decisions and the refill timer's removals made meanwhile were undone - a paid refill no longer counted toward its day cap.
  // Every write goes onto a freshly read book in one synchronous step (read, change, save), as the sweep and the grant's later writes do.
  // THE ROW BEFORE THE SEND (kanban #1572): booked `pending` first, its txid set once the send answers
  const row = { address: ask.address, ip: ask.ip, sats: d.sats, atMs: Date.now(), txid: null, pending: true };
  { const now = readBook(); now.paid = now.paid || []; now.paid.push(row); saveBook(now); }
  const settle = (txid) => {   // only this row changes, in a book read again
    const b = readBook(); const r = (b.paid || []).find((p) => p.address === ask.address && p.pending);
    if (r) { r.txid = txid; delete r.pending; saveBook(b); }
    appendFileSync(env.FAUCET_PENDING, `${txid}\n`);
  };
  let txid;
  try {
    txid = await rpc('sendtoaddress', { address: ask.address, amount: (d.sats / 1e8).toFixed(8), replaceable: true, fee_rate: feeRate });
  } catch (e) {
    const sent = e && e.rpcRefused ? 'none' : await walletSentTo(ask.address);
    if (sent === 'none') { const b = readBook(); b.paid = (b.paid || []).filter((p) => !(p.address === ask.address && p.pending)); saveBook(b); throw e; }
    if (sent) { settle(sent); console.log(`${new Date().toISOString()} paid ${d.sats} sat to ${ask.address} (${ask.ip || 'no ip'}), found after "${e.message}": ${sent}`); return { ok: true, txid: sent, sats: d.sats }; }
    console.log(`${new Date().toISOString()} send of ${d.sats} sat to ${ask.address} unsure ("${e && e.message}"): the address stays booked`);
    throw e;
  }
  settle(txid);
  console.log(`${new Date().toISOString()} paid ${d.sats} sat to ${ask.address} (${ask.ip || 'no ip'}): ${txid}`);
  return { ok: true, txid, sats: d.sats };
}

const PAYERS = String(env.FAUCET_PAYERS || '').split(',').filter(Boolean).map((p) => { const [dir, rpcserver] = p.split('|'); return { dir, rpcserver }; });
const lncli = (payer, args, timeoutMs = 20000) => new Promise((res) => execFile(env.FAUCET_LNCLI, [`--lnddir=${payer.dir}`, '--network=testnet4', `--rpcserver=${payer.rpcserver}`, ...args],
  { timeout: timeoutMs }, (e, out, err) => res({ ok: !e, timedOut: !!(e && e.killed), out: String(out), err: String(err) })));

/** A player's grant: read the invoice, decide, keep it in the book BEFORE paying (a crash pays nobody twice), and take it out again if no payer could pay. */
/** Each payer's own node key, read once (lncli getinfo); a payer whose node is the invoice's destination goes last. */
const PAYER_KEYS = new Map();
async function payersFor(destination) {
  for (const payer of PAYERS) {
    if (PAYER_KEYS.has(payer)) continue;
    const r = await lncli(payer, ['getinfo']);
    let key = null; try { key = JSON.parse(r.out).identity_pubkey || null; } catch { key = null; }
    if (key) PAYER_KEYS.set(payer, key);
  }
  const own = (p) => !!destination && PAYER_KEYS.get(p) === destination;
  return [...PAYERS.filter((p) => !own(p)), ...PAYERS.filter(own)];
}

/** After a payinvoice that timed out: 'sent' once the payment SUCCEEDED or has an HTLC in flight, 'no' once it FAILED or none went out in time. */
const PAY_SETTLE_MS = Number(env.FAUCET_PAY_SETTLE_MS || 45000), PAY_WAIT_MS = Number(env.FAUCET_PAY_WAIT_MS || 15000), PAY_POLL_MS = Number(env.FAUCET_PAY_POLL_MS || 3000);   // the tests' to shorten
async function paymentSent(payer, hash) {
  const until = Date.now() + PAY_SETTLE_MS;
  while (Date.now() < until) {
    const r = await lncli(payer, ['listpayments', '--include_incomplete', '--max_payments', '30']);
    let p = null; try { p = (JSON.parse(r.out).payments || []).find((x) => x.payment_hash === hash) || null; } catch { p = null; }
    if (p && p.status === 'SUCCEEDED') return 'sent';
    if (p && p.status === 'FAILED') return 'no';
    if (p && (p.htlcs || []).some((h) => h.status === 'IN_FLIGHT' || h.status === 'SUCCEEDED')) return 'sent';
    await new Promise((ok) => setTimeout(ok, PAY_POLL_MS));
  }
  return 'no';
}

// A PAYMENT'S FINAL WORD (audit 6, kanban #1421): the grant's verdict was taken while the payment could still change - IN_FLIGHT read as paid (it
// may fail downstream: a welcome booked that never arrived), a timeout as unpaid (a late attempt may succeed: paid, the row gone, a second welcome
// possible). The grant now books an unsure verdict as such - a row `pending` with its payers, or a removed row kept in `unsure` - and this sweep reads
// each payer's own record of the payment until it is SUCCEEDED or FAILED, and sets the book to it.
// BY THE PAYMENT'S HASH (audit 6 re-check N2, kanban #1426): listpayments shows the newest 200 only, so a payment that fell out of it read as "no record"
// and its row stayed pending for good. trackpayment answers one hash: its status, or "not initiated" (this payer never paid it: NONE); no answer in
// time is still in flight
async function paymentFinal(payer, hash) {
  if (!payer) return null;
  const r = await lncli(payer, ['trackpayment', hash], 10000);
  const text = `${r.out || ''}\n${r.err || ''}`;
  if (/isn't initiated|not initiated|not found|unknown payment/i.test(text)) return 'NONE';
  // LNCLI'S OWN WORDS (audit 7, kanban #1430): without --json lncli 0.21 prints a table and "Payment status: SUCCEEDED, preimage: ..." (the refill timer
  // reads the same line) - the JSON match found nothing live, so a settled welcome read as no answer; the payment's line, the last one printed, decides
  const said = [...text.matchAll(/Payment status:\s*([A-Z_]+)/g)].map((m) => m[1]);
  const last = said[said.length - 1] || null;
  if (last === 'SUCCEEDED' || last === 'FAILED') return last;
  return r.timedOut || last ? 'IN_FLIGHT' : null;
}
const UNSURE_KEEP_MS = 24 * 3600 * 1000;
// OUT OF THE PLAYERS' QUEUE, AND ONLY ITS OWN CHANGES (audit 6 re-check N3/N4, kanban #1426): in the queue its lncli reads held welcomes past the page's
// 45 s again, and saving the book it had read before its awaits dropped refill rows written meanwhile. The reads run first; the book is read again
// and only this sweep's decisions, by payment hash, are applied to it in one synchronous step
const notPaid = (states) => states.length > 0 && states.every((x) => x === 'FAILED' || x === 'NONE');
async function sweepPayments(nowMs = Date.now()) {
  const seen = readBook();
  const keep = new Set(), drop = new Set(), rebook = new Map(), forget = new Set();
  for (const r of (seen.players || []).filter((x) => x.pending)) {
    const states = await Promise.all((r.payers || []).map((i) => paymentFinal(PAYERS[i], r.hash).catch(() => null)));
    if (states.includes('SUCCEEDED')) keep.add(r.hash);
    else if (notPaid(states)) drop.add(r.hash);
  }
  for (const u of seen.unsure || []) {
    const states = await Promise.all((u.payers || []).map((i) => paymentFinal(PAYERS[i], u.hash).catch(() => null)));
    if (states.includes('SUCCEEDED')) rebook.set(u.hash, u);
    else if (notPaid(states) || (!states.includes('IN_FLIGHT') && nowMs - Number(u.removedMs || 0) > UNSURE_KEEP_MS)) forget.add(u.hash);
  }
  if (!keep.size && !drop.size && !rebook.size && !forget.size) return false;
  const book = readBook();
  book.players = book.players || []; book.unsure = book.unsure || [];
  for (const r of book.players) if (r.pending && keep.has(r.hash)) { delete r.pending; delete r.payers; console.log(`${new Date().toISOString()} player ${r.kind} ${r.hash.slice(0, 16)}: SUCCEEDED, kept`); }
  book.players = book.players.filter((r) => { const gone = r.pending && drop.has(r.hash); if (gone) console.log(`${new Date().toISOString()} player ${r.kind} ${r.hash.slice(0, 16)}: not paid by any payer, the row removed (the welcome can be asked again)`); return !gone; });
  for (const [h, u] of rebook) { const { payers, removedMs, ...row } = u; if (!book.players.some((x) => x.hash === h)) { book.players.push(row); console.log(`${new Date().toISOString()} player ${row.kind} ${h.slice(0, 16)}: paid after all - booked again`); } }
  book.unsure = book.unsure.filter((u) => !rebook.has(u.hash) && !forget.has(u.hash));
  saveBook(book);
  return true;
}
let sweeping = false;
if (PAYERS.length) setInterval(() => { if (sweeping) return; sweeping = true; sweepPayments().catch(() => {}).finally(() => { sweeping = false; }); }, Number(env.FAUCET_SWEEP_MS || 120000)).unref();

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
  const tried = [], askedPayers = [];
  // A PAYER IS NOT ASKED TO PAY ITS OWN NODE'S INVOICE (kanban #1381): payer a is gateway a's lnd - "self-payments not allowed" cost a call before payer b
  for (const payer of await payersFor(inv.destination)) {
    // A TIMEOUT IS NOT A REFUSAL, AND NOT A PAYMENT EITHER (kanban #1381, Daniel 2026-11-09 "scheitere daran die test sats zu bekommen": payer b's
    // channel to node a was down, payinvoice was still looking for a route at 15 s, the page was told "500 sat" and the payment FAILED with NO_ROUTE
    // after): the payment's own state is read - an HTLC on its way (the federation's incoming contract holds it until the client claims) or SUCCEEDED
    // is paid; FAILED, or no part sent within PAY_SETTLE_MS, is not, and the next payer is asked
    const paid = await lncli(payer, ['payinvoice', '--force', '--timeout=60s', '--fee_limit=20', ask.invoice], PAY_WAIT_MS);
    const state = /Payment status: (SUCCEEDED|IN_FLIGHT)/.test(paid.out) ? 'sent' : paid.timedOut ? await paymentSent(payer, inv.payment_hash) : 'no';
    askedPayers.push(PAYERS.indexOf(payer));
    // NOT FINAL YET (kanban #1421): booked as pending with the payers asked; the sweep reads their final word
    if (state === 'sent' && !/Payment status: SUCCEEDED/.test(paid.out)) {
      const b2 = readBook(); const mine = (b2.players || []).find((x) => x.hash === row.hash);
      if (mine) { mine.pending = true; mine.payers = [...askedPayers]; saveBook(b2); }
    }
    if (state === 'sent') {
      console.log(`${new Date().toISOString()} player ${ask.kind} ${d.grant.invoiceSats} sat (${ask.ip || 'no ip'}): ${inv.payment_hash.slice(0, 16)}`);
      return { ok: true, sats: d.grant.sats };
    }
    tried.push((paid.err || paid.out).trim().slice(-160));
  }
  const after = readBook();
  after.players = (after.players || []).filter((p) => p.hash !== row.hash);
  // a payer that timed out may still pay it (kanban #1421): kept in `unsure` for the sweep, booked again if any payer says SUCCEEDED
  after.unsure = [...(after.unsure || []), { ...row, payers: askedPayers, removedMs: Date.now() }].slice(-500);
  saveBook(after);
  console.log(`${new Date().toISOString()} player ${ask.kind} not paid: ${tried.join(' | ')}`);
  return { ok: false, why: 'the faucet could not pay just now: try again in a minute' };
}

// THE WELCOME AS READY E-CASH (kanban #1381, Daniel 2026-11-09: "Das Ziel ist unter 3s fuer die 500"): an invoice, a Lightning payment
// through a gateway and its claim are three federation steps (12-15 s for a new wallet); a note made ahead of time (tools/faucet-ecash.mjs
// keep) is one reissue in the player's wallet. A page that names its federation gets one when the pool holds one; else it asks by invoice.
const ECASH_POOL = env.FAUCET_ECASH_POOL || null;
function takeEcash(federation, msat) {
  if (!ECASH_POOL || !/^[0-9a-f]{64}$/.test(String(federation || ''))) return null;
  const shelf = pathJoin(ECASH_POOL, federation);
  let names = []; try { names = readdirSync(shelf).filter((f) => f.startsWith(`${msat}-`) && f.endsWith('.json')).sort(); } catch { return null; }
  mkdirSync(pathJoin(shelf, 'taken'), { recursive: true, mode: 0o700 });
  for (const f of names) {
    const to = pathJoin(shelf, 'taken', f);
    try { renameSync(pathJoin(shelf, f), to); } catch { continue; }   // another take had it
    try { const n = JSON.parse(readFileSync(to, 'utf8')); if (String(n.msat) === String(msat) && n.ecash) return { ecash: String(n.ecash), file: to }; } catch { /* a broken file: the next */ }
  }
  return null;
}
function grantEcash(ask) {
  const book = readBook();
  book.players = book.players || [];
  // THE SAME NOTE AGAIN (audit 6, kanban #1419): a welcome taken for a page that had already given up was booked, its note gone, and the account could
  // never have its welcome. An account's e-cash welcome is answered again - the same note - to the same caller (its address) within WELCOME_REISSUE_MS
  if (ask.kind === 'welcome') {
    const had = book.players.find((x) => x.account === ask.account && x.kind === 'welcome' && x.ecash && x.noteFile);
    if (had && ipKey(had.ip) && ipKey(had.ip) === ipKey(ask.ip) && Date.now() - Number(had.atMs) < WELCOME_REISSUE_MS) {
      try { const n = JSON.parse(readFileSync(had.noteFile, 'utf8')); if (n.ecash) { console.log(`${new Date().toISOString()} player welcome answered again (${ask.ip || 'no ip'}): ${String(had.hash || '').slice(0, 16)}`); return { ok: true, sats: had.sats, ecash: String(n.ecash), again: true }; } } catch { /* the note file is gone: refused below as before */ }
    }
  }
  const d = playerGrantDecide({ kind: ask.kind, account: ask.account, ip: ask.ip, invoiceSats: PLAYER_WELCOME_SATS }, book);
  if (!d.ok) return d;
  const got = takeEcash(ask.ecash, d.grant.invoiceSats * 1000);
  if (!got) return null;
  const hash = createHash('sha256').update(got.ecash).digest('hex');
  book.players.push({ account: ask.account, kind: ask.kind, ip: ask.ip, sats: d.grant.invoiceSats, atMs: Date.now(), hash, ecash: true, noteFile: got.file });
  saveBook(book);
  console.log(`${new Date().toISOString()} player ${ask.kind} ${d.grant.invoiceSats} sat as e-cash (${ask.ip || 'no ip'}): ${hash.slice(0, 16)}`);
  return { ok: true, sats: d.grant.sats, ecash: got.ecash };
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
    req.on('end', () => { try { const b = JSON.parse(raw || '{}'); send(200, opponentWant(WANTS, b.round, Date.now(), b.tapped === true, ipKey(ipOf(req)) || 'none')); /* one caller, at most two tables (kanban #1535) */ } catch { send(400, { ok: false, why: 'not JSON' }); } });
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
          if (paid.timedOut || /Payment status: (SUCCEEDED|IN_FLIGHT)/.test(paid.out)) {
            // A PAYMENT THAT FAILED AFTER ITS ANSWER IS NOT A TOP-UP (kanban #1391, measured 2026-11-09: 13 refills of the test opponent, 39,000 sat, were
            // counted when lncli ran past 15 s - every one then FAILED, INCORRECT_PAYMENT_DETAILS or NO_ROUTE, no sat moved - and the day's cap said "the
            // top-ups of today are used up" while the bot's wallet held 0, so it entered no round): once lnd knows, a failed one leaves the day's count
            if (!/Payment status: SUCCEEDED/.test(paid.out)) setTimeout(async () => {
              const t = await lncli(payer, ['trackpayment', inv.payment_hash], 20000);
              if (/Payment status: FAILED/.test(t.out)) {
                const later = readBook(); later.refills = (later.refills || []).filter((r) => r.hash !== inv.payment_hash); saveBook(later);
                console.log(`${new Date().toISOString()} refill ${d.sats} sat: ${inv.payment_hash.slice(0, 16)} failed after its answer - not counted`);
              }
            }, 120000);
            console.log(`${new Date().toISOString()} refill ${d.sats} sat: ${inv.payment_hash.slice(0, 16)}`); return send(200, { ok: true, sats: d.sats }); }
        }
        const after = readBook(); after.refills = (after.refills || []).filter((r) => r.hash !== inv.payment_hash); saveBook(after);
        send(200, { ok: false, why: 'could not pay just now' });
      } catch { send(400, { ok: false, why: 'not JSON' }); }
    });
    return undefined;
  }
  if (path === '/feedback') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    if (!env.FAUCET_CHAT_URL) return send(503, { ok: false, why: 'reports are off' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(raw || '{}'), ip = ipOf(req), d = feedbackDecide({ ...b, ip }, REPORTS);
        if (!d.ok) return send(200, d);
        const key = readFileSync(env.FAUCET_CHAT_TOKEN_FILE, 'utf8').trim();
        const r = await fetch(`${env.FAUCET_CHAT_URL}/api/channels/${env.FAUCET_CHAT_CHANNEL}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ text: d.text }), signal: AbortSignal.timeout(10000) });
        if (!r.ok) return send(502, { ok: false, why: 'the report could not be kept just now' });
        REPORTS.push({ ip, atMs: Date.now() });
        if (d.player) appendFileSync(FOUNDING_FILE, `${JSON.stringify({ player: d.player, atMs: Date.now() })}\n`);
        send(200, { ok: true });
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
      const who = { kind: ask.kind, account: ask.account, ip: ipOf(req) };
      // A PAGE THAT STOPPED WAITING TAKES NOTHING (audit 6, kanban #1419): a request whose connection closed while it was queued is dropped here
      one(async () => (req.socket.destroyed ? { ok: false, why: 'the page stopped waiting: ask again' } : null)
        || (ask.kind === 'welcome' && ask.ecash && grantEcash({ ...who, ecash: String(ask.ecash).toLowerCase() }))
        || (ask.invoice ? grant({ ...who, invoice: ask.invoice }) : { ok: false, noEcash: true, why: 'no e-cash is ready: ask with an invoice' }))
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
