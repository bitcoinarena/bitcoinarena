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
//                                   FAUCET_BOUNTY_NETWORK (mainnet since 2026-11-11, Daniel: "echte lightning payments auf mainnet als bounties"; testnet4 before)
//   /feedback/admin/list | /report/<id> | /act | /export.csv  (x-arena-admin: the admin code) -> the review list (kanban #1342 section 4)
//                                   FAUCET_ADMIN_SHA256 (the code's hash, never the code), FAUCET_REWARD_RULES (JSON), FAUCET_FEEDBACK_EXCLUDED (a file of
//                                   our keys, hex, one per line), FAUCET_SEASON_SEATS / FAUCET_SEASON_GAMES (where "finished a round" is read)
//                                   FAUCET_LNCLI, FAUCET_PAYERS=<lnddir>|<rpc host:port>,... : the second pays when an invoice's gateway is on the first
//
// Each payment's txid is appended to FAUCET_PENDING, which the the test host's miner-C feeder (ops/pending-to-minerc.sh) lists for mining.
//   FAUCET_PORT  FAUCET_RPC_URL (with /wallet/<name>)  FAUCET_COOKIE  FAUCET_BOOK  FAUCET_PENDING  [FAUCET_FEE_RATE sat/vB, 2]
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { openFeedbackStore, networkPlayers, imageKind, SHOT_MOST, SHOT_UNCLAIMED_MS, REWARD_LEVELS, NODE_BOUNTY_BASE_SATS, lnAddressWorks, lnAddressUrl, lnAddressInvoice } from '../src/feedback-store.js';
const LN_ASKS = new Map();   // ip /64 -> times it asked GET /feedback/lnaddress (kanban #1342, #1537)
const LN_ASKS_ALL = [], LN_ASKS_MINUTE = 120;   // every check of the last minute, all callers (kanban #1537)
// ONE GLOBAL WINDOW FOR EVERY DOOR THAT FETCHES A CALLER'S ADDRESS (kanban #1714, refute of #1537): the cap held only GET /feedback/lnaddress, and
// POST /feedback (addressCheckFor, a report's bounty address) fetched caller-named hosts with no bound across callers - a /48 is 65,536 /64s of 50
// checks a day each. Both doors now take a slot here first: true = the check may run (and is counted), false = the minute is full, nothing fetched.
function addressCheckSlot(now = Date.now()) {
  while (LN_ASKS_ALL.length && now - LN_ASKS_ALL[0] >= 60000) LN_ASKS_ALL.shift();
  if (LN_ASKS_ALL.length >= LN_ASKS_MINUTE) return false;
  LN_ASKS_ALL.push(now); return true;
}
// A REPORT'S BOUNTY ADDRESS IS CHECKED ON A BUDGET (kanban #1511): POST /feedback fetched the address's URL before the report was counted, and a report
// whose address failed was never counted - so one caller made the faucet fetch any HTTPS URL it named (an LNURL can name an internal host), without
// limit. Each check is now counted against the caller's ipKey (an IPv6 /64 as one) before it is made, whether the address works or not, at most
// FEEDBACK_PER_IP_PER_DAY a day, and one caller has one check running at a time.
const ADDR_CHECKS = new Map();   // ipKey -> { day, n, busy }
async function addressCheckFor(ip, address) {
  const k = ipKey(ip) || String(ip || ''), day = Math.floor(Date.now() / DAY_MS);
  let c = ADDR_CHECKS.get(k);
  if (!c || c.day !== day) { c = { day, n: 0, busy: false }; ADDR_CHECKS.set(k, c); if (ADDR_CHECKS.size > 5000) for (const [x, v] of ADDR_CHECKS) { if (ADDR_CHECKS.size <= 5000) break; if (!v.busy && x !== k) ADDR_CHECKS.delete(x); } }
  // text that is no address, or names no public host, fetches nothing: answered here, no budget and no slot used (kanban #1873, #1905)
  const u = lnAddressUrl(address); if (!u.ok) return u;
  if (c.busy) return { ok: false, why: 'another address from you is still being checked' };
  if (c.n >= FEEDBACK_PER_IP_PER_DAY) return { ok: false, why: 'this address checked all it can today' };
  // the global minute (kanban #1714) still bounds every fetch of a caller's address, both doors together. A FULL MINUTE NEVER REFUSES A REPORT
  // (kanban #1873, #1905): other callers' checks (GET /feedback/lnaddress takes slots from any Origin) kept the minute full and every honest report
  // naming a bounty address was refused "try again in a minute", for as long as they liked. Now the report is kept with its address unchecked -
  // nothing is fetched for it here, and the address is asked again at payout (lnAddressInvoice), so a reward is still never paid to one that fails.
  if (!addressCheckSlot()) return { ok: true, unchecked: true };
  c.n += 1; c.busy = true;
  try { return await lnAddressWorks(address); } finally { c.busy = false; }
}
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, statfsSync } from 'node:fs';
import { PLAYER_GRANTS } from '../src/faucet.js';
const PLAYER_WELCOME_SATS = PLAYER_GRANTS.welcome.invoiceSats;
import { join as pathJoin } from 'node:path';
import { ipKey } from '../src/faucet.js';
import { refillDecide, feedbackDecide, FEEDBACK_PER_IP_PER_DAY, faucetDecide, playerGrantDecide, playerGrantTotals, opponentWant, opponentWants, FAUCET_MAX_SATS, FAUCET_DAY_CAP_SATS, DAY_MS } from '../src/faucet.js';

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
// THE SCREENSHOTS (Daniel 2026-11-07): a folder beside the store, one file per image under its SHA-256
const SHOTS = env.FAUCET_FEEDBACK_SHOTS || (env.FAUCET_FEEDBACK_DB ? `${env.FAUCET_FEEDBACK_DB}.shots` : null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shotFile = (h) => { if (!SHOTS || !/^[0-9a-f]{64}$/.test(h)) return null; for (const ext of ['png', 'jpg', 'webp']) { const f = pathJoin(SHOTS, `${h}.${ext}`); if (existsSync(f)) return f; } return null; };
const SHOT_UPLOADS = [];   // { ip, atMs } of today
const SHOTS_PER_IP_PER_DAY = 10;
// THE DISK IS NOT THE UPLOADER'S (audit 5, kanban #1405): an address counts by ipKey (an IPv6 /64 is one), all uploads of a day together write at
// most SHOT_DAY_BYTES, and none is written while the disk holds less than SHOT_FREE_FLOOR_BYTES free
const SHOT_DAY_BYTES = Number(env.FAUCET_SHOT_DAY_BYTES || 300e6);
const SHOT_FREE_FLOOR_BYTES = Number(env.FAUCET_SHOT_FREE_FLOOR_BYTES || 20e9);
const freeBytes = (dir) => { try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };
if (SHOTS && FEEDBACK) setInterval(() => { try { const used = FEEDBACK.shotsInUse(); for (const f of readdirSync(SHOTS)) { const h = f.split('.')[0];
  if (!used.has(h) && Date.now() - statSync(pathJoin(SHOTS, f)).mtimeMs > SHOT_UNCLAIMED_MS) unlinkSync(pathJoin(SHOTS, f)); } } catch { /* next hour */ } }, 3600000).unref();
const MINE_URLS = String(env.FAUCET_FEEDBACK_MINE_URLS || 'https://bitcoinarena.io/api/faucet/feedback/mine').split(',').map((x) => x.trim()).filter(Boolean);
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
// THE ADMIN'S OWN QUEUE (audit 6, kanban #1419): an approve reads the seats (played rounds, the node checklist) for half a minute and more; in the
// players' queue that held every welcome behind it past the page's 45 s
let adminQueue = Promise.resolve();
const oneAdmin = (fn) => { const run = adminQueue.then(fn, fn); adminQueue = run.catch(() => {}); return run; };
// a welcome answered again to the same caller (its address, an IPv6 /64) within this long: its first answer may never have reached the page
const WELCOME_REISSUE_MS = 15 * 60 * 1000;

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
// EACH PAYER ON ITS OWN NETWORK (kanban #1450): the faucet's payers are testnet4; the bounty payer is on FAUCET_BOUNTY_NETWORK, with its own lncli if one is named
const lncli = (payer, args, timeoutMs = 20000) => new Promise((res) => execFile(payer.lncli || env.FAUCET_LNCLI, [`--lnddir=${payer.dir}`, `--network=${payer.network || 'testnet4'}`, `--rpcserver=${payer.rpcserver}`, ...args],
  { timeout: timeoutMs }, (e, out, err) => res({ ok: !e, timedOut: !!(e && e.killed), out: String(out), err: String(err) })));

// THE BOUNTY WALLET (kanban #1342 section 3): its own payer, never the faucet's; the payout network one setting (testnet4 in phase 1)
const BOUNTY_NETWORK = env.FAUCET_BOUNTY_NETWORK || 'testnet4';
const BOUNTY_PAYER = env.FAUCET_BOUNTY_PAYER ? (([dir, rpcserver]) => ({ dir, rpcserver, network: BOUNTY_NETWORK, lncli: env.FAUCET_BOUNTY_LNCLI || null }))(env.FAUCET_BOUNTY_PAYER.split('|')) : null;
// A BOUNTY INVOICE OF THE PAYOUT NETWORK (kanban #1450): lnbc on mainnet, lntb on testnet4; another network's invoice is refused before lnd is asked
export const BOUNTY_INVOICE = { mainnet: /^lnbc[0-9a-z]{20,1500}$/, testnet4: /^lntb[0-9a-z]{20,1500}$/ };
const bountyInvoiceOk = (invoice) => (BOUNTY_INVOICE[BOUNTY_NETWORK] || BOUNTY_INVOICE.testnet4).test(String(invoice || ''));
// the routing fee a reward may cost: real sats on mainnet need a route that may cost more than a testnet one (20 sat before); 1 % of the reward, at least 20 sat
const BOUNTY_FEE_LIMIT_PCT = Number(env.FAUCET_BOUNTY_FEE_LIMIT_PCT || 1);
// THE BOUNTY IS OFF UNTIL THE OWNER SAYS SO (Daniel 2026-11-07: "ausmachen bis ich es sage und nur auf einer privaten URL aktivieren"): every money path
// answers only while FAUCET_BOUNTY_ORIGINS names the private page's origin(s), and a report's reward is shown only to a request from one of them
const BOUNTY_ORIGINS = String(env.FAUCET_BOUNTY_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
const bountyOn = () => BOUNTY_ORIGINS.length > 0;
const PUBLIC_BASE = String(env.FAUCET_PUBLIC_BASE || 'https://bitcoinarena.io/api/faucet').replace(/\/$/, '');
const bountyDecode = async (invoice) => {
  if (!bountyInvoiceOk(invoice)) return { ok: false };
  const r = await lncli(BOUNTY_PAYER, ['decodepayreq', invoice]);
  if (!r.ok) return { ok: false };
  const j = JSON.parse(r.out);
  return { ok: true, amountSats: Number(j.num_satoshis), paymentHash: j.payment_hash };
};
const bountyPay = async (invoice, amountSats = 0) => {
  const feeLimit = Math.max(20, Math.ceil(Number(amountSats || 0) * BOUNTY_FEE_LIMIT_PCT / 100));
  const r = await lncli(BOUNTY_PAYER, ['payinvoice', '--force', '--timeout=60s', `--fee_limit=${feeLimit}`, invoice], 75000);
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
// THE ADMIN (kanban #1342 section 4): the owner's code, held to its hash as the explorer holds it (#1092); the rules, our keys, who played
const ADMIN_SHA = String(env.FAUCET_ADMIN_SHA256 || '').trim().toLowerCase();
const isAdmin = (req) => { const code = String(req.headers['x-arena-admin'] || '').trim(); if (!/^[0-9a-f]{64}$/.test(ADMIN_SHA) || !code) return false;
  return timingSafeEqual(Buffer.from(createHash('sha256').update(code).digest('hex')), Buffer.from(ADMIN_SHA)); };
const RULES = (() => { try { return JSON.parse(env.FAUCET_REWARD_RULES || '{}'); } catch { return {}; } })();
const ourKeys = () => { try { return new Set(readFileSync(env.FAUCET_FEEDBACK_EXCLUDED, 'utf8').split(/\s+/).map((x) => x.toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x))); } catch { return new Set(); } };
// THE SEATS A NODE CHECK ASKS (kanban #1342): every seat the season seats list (GET /network-games - a seat does not list itself, so they are merged, and each is one too)
const NODE_CHECKS = new Map();
const NODE_CHECK_ASKS = new Map(); const NODE_CHECKS_PER_HOUR = 10; let NODE_CHECK_BUSY = false;   // audit 5 #1402
const fetchJson1342 = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
async function nodeCheckNow(node, npub) {
  const bases = String(env.FAUCET_SEASON_SEATS || '').split(',').filter(Boolean).map((u) => u.replace(/\/+$/, ''));
  const lists = await Promise.all(bases.map((b) => fetchJson1342(`${b}/network-games`).then((j) => (j.seats || []).map((x) => x.seat), () => [])));
  const seats = [...new Set([...bases, ...lists.flat()])];
  let excluded = new Set(); try { excluded = ourKeys(); } catch { excluded = new Set(); }
  // the hosts the team's own nodes answer at (kanban #1342: team nodes are never paid)
  // THE TEAM'S OWN SEATS BY THEIR NODE KEYS (audit 7, kanban #1428: our-keys.txt held none of them, and the Mac seats' addresses were no team host):
  // every seat this faucet is configured with, and every listed seat at a team host, is the team's - its /roles node key is excluded
  const teamHosts = String(env.FAUCET_TEAM_HOSTS || 'beelink.tail1723e2.ts.net,127.0.0.1,localhost,192.168.1.18,100.85.86.106,100.99.158.103,192.168.1.68,tn4.bitcoin-arena.io').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const ours = [...new Set([...bases, ...seats.filter((u) => teamHosts.includes(hostOf(u)))])];
  const keys = await Promise.all(ours.map((u) => fetchJson1342(`${u}/roles`).then((j) => String((j && j.node) || '').toLowerCase(), () => '')));
  for (const k of keys) if (/^[0-9a-f]{64}$/.test(k)) excluded.add(k);
  return nodeBountyCheck({ node, npub, seats, fetchJson: fetchJson1342, excluded, teamHosts });
}
const PLAYED = networkPlayers({ seats: String(env.FAUCET_SEASON_SEATS || '').split(',').filter(Boolean), games: String(env.FAUCET_SEASON_GAMES || 'rock-paper-scissors,nextblock,btc-updown').split(',').filter(Boolean) });
PLAYED.fresh().catch(() => 0);   // kanban #1484: the list is read at start, so the admin page never waits for it
if (FEEDBACK && BOUNTY_PAYER) setInterval(() => FEEDBACK.settle({ status: bountyStatus }).catch(() => {}), 60000).unref();

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
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)?(testnet(-stage)?\.bitcoin-?arena\.io|bitcoin-arena-site\.pages\.dev)$/;   // testnet-stage: the bounty's stage (kanban #1342)
createServer((req, res) => {
  const origin = String(req.headers.origin || '');
  // THE TWO DOORS A NODE'S OWN OWNER PAGE WRITES TO (kanban #1342 node feedback): signed, rate-limited reports and their screenshots, from any origin;
  // every other door only from the Arena's own hosts
  const writePath = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
  const anyOrigin = (writePath === '/feedback' || writePath === '/feedback/screenshot') && origin;
  const cors = ORIGIN_OK.test(origin) || anyOrigin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
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
  // THE REVIEW LIST (kanban #1342 section 4): the admin code on every ask; reads and one action at a time
  if (path.startsWith('/feedback/admin/')) {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-arena-admin', 'access-control-max-age': '86400' }); return res.end(); }
    if (!FEEDBACK) return send(503, { ok: false, why: 'reports are not kept here' });
    if (!isAdmin(req)) return send(403, { ok: false, why: 'not the admin code' });
    const q = new URL(req.url, 'http://x').searchParams;
    const withReward = (r, ours) => { const w = FEEDBACK.rewards({ pubkey: r.pubkey }).find((x) => x.report === r.id);
      return { ...r, lnAddress: FEEDBACK.addressOf(r.id), ours: ours.has(r.pubkey), played: PLAYED.played(r.pubkey), rounds: PLAYED.history ? PLAYED.history(r.pubkey) : null, nodeBounty: FEEDBACK.nodeBountyFor(r), reward: w ? { ...w, lnurl: w.state === 'paid' ? null : FEEDBACK.lnurlOf(w.k1, { base: PUBLIC_BASE }), page: `${PUBLIC_BASE}/lnurlw/${w.k1}` } : null }; };
    if (path === '/feedback/admin/list' && req.method === 'GET') {
      PLAYED.fresh().catch(() => 0).then(() => { const ours = ourKeys();
        send(200, { ok: true, reports: FEEDBACK.list({ state: q.get('state'), type: q.get('type'), game: q.get('game'), pubkey: q.get('pubkey'), source: q.get('source') }).map((r) => withReward(r, ours)), budget: { ...FEEDBACK.budget({ rules: RULES }), network: BOUNTY_NETWORK },   // the payout network, for the admin's wording (kanban #1450)
          // THE SATS EACH LEVEL PAYS (Daniel 2026-11-10: "Da muss er auch die sats automatisch ausfüllen die wir definiert haben"): the review form fills them in
          levels: [...REWARD_LEVELS.map((l) => ({ level: l.level, sats: l.sats })), { level: 'node', sats: NODE_BOUNTY_BASE_SATS }] }); });
      return undefined;
    }
    // A NODE REPORT'S BOUNTY CHECKLIST (kanban #1342): the node and the reporter's key read live from the seats, for the review list (admin code, any origin)
    { const m = /^\/feedback\/admin\/node-check\/([0-9a-f]{64})$/.exec(path);
      if (m && req.method === 'GET') {
        const r = FEEDBACK.report(m[1]);
        if (!r || r.source !== 'node' || !r.node) return send(200, { ok: false, why: 'not a node report naming its node' });
        const k = `${r.node}:${r.pubkey}`, kept = NODE_CHECKS.get(k);
        if (kept && Date.now() - kept.at < 600000) return send(200, { ...kept.answer, keptMs: Date.now() - kept.at });
        return nodeCheckNow(r.node, r.pubkey).then((answer) => { NODE_CHECKS.set(k, { at: Date.now(), answer }); send(200, answer); }, (e) => send(502, { ok: false, why: String(e.message || e).slice(0, 160) }));
      } }
    { const m = /^\/feedback\/admin\/report\/([0-9a-f]{64})$/.exec(path);
      if (m && req.method === 'GET') {
        const r = FEEDBACK.report(m[1]); if (!r) return send(404, { ok: false, why: 'no such report' });
        PLAYED.fresh().catch(() => 0).then(() => { const ours = ourKeys();
          send(200, { ok: true, report: withReward(r, ours), moves: FEEDBACK.moves(r.id), earlier: FEEDBACK.list({ pubkey: r.pubkey }).filter((x) => x.id !== r.id) }); });
        return undefined;
      } }
    { const m = /^\/feedback\/admin\/screenshot\/([0-9a-f]{64})$/.exec(path);
      if (m && req.method === 'GET') { const f = shotFile(m[1]); if (!f) return send(404, { ok: false, why: 'no such screenshot' });
        res.writeHead(200, { 'content-type': f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'cache-control': 'private, no-store', ...cors });
        return res.end(readFileSync(f)); } }
    if (path === '/feedback/admin/export.csv' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="arena-feedback.csv"', 'cache-control': 'no-store', ...cors });
      return res.end(FEEDBACK.csv());
    }
    if (path === '/feedback/admin/act' && req.method === 'POST') {
      let raw = ''; req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', () => oneAdmin(async () => {
        let b; try { b = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, why: 'not JSON' }); }
        const by = 'admin';
        if ((b.action === 'approve' || b.action === 'reward') && !bountyOn()) return send(403, { ok: false, why: 'rewards are off until the owner turns them on: reject, duplicate and notes still work' });
        if (b.action === 'approve') {
          await PLAYED.fresh().catch(() => 0);
          // A NODE BOUNTY ONLY ON ITS CHECKLIST (kanban #1342): the node's census, 1 day online in the last 7, committees and signed rounds, outside the team - read now
          // (the owner key is no condition since Daniel 2026-11-10: "npub muss nicht sein"; the answer's `owner` tells the reviewer)
          if (String(b.severity || '').toLowerCase() === 'node') {
            const r = FEEDBACK.report(b.id);
            if (!r || !r.node) return send(200, { ok: false, why: 'a node bounty is for a node report naming its node' });
            const chk = await nodeCheckNow(r.node, r.pubkey).catch((e) => ({ ok: false, why: e.message }));
            // NOT TO A KEY THE NODE SAYS IS NOT ITS OWNER (audit 7, kanban #1429): with no owner named the npub stays no condition (Daniel 2026-11-10)
            if (chk.ok && chk.owner && chk.owner.other) return send(200, { ok: false, why: 'the node names another owner: its bounty goes to that owner\'s report', checks: chk.checks, owner: chk.owner });
            if (!chk.ok || !chk.passes) return send(200, { ok: false, why: `the node checklist does not pass: ${(chk.checks || []).filter((c) => !c.ok).map((c) => `${c.label} (${c.says})`).join('; ') || chk.why}`, checks: chk.checks || null });
          }
          // A CRITICAL BUG ABOVE THE BANDS IS THE OWNER'S OWN CALL: critical: true lifts mostSats to the amount for this one approval
          const rules = b.critical === true ? { ...RULES, mostSats: Math.max(Number(b.amountSats) || 0, RULES.mostSats || 0) } : RULES;
          return send(200, FEEDBACK.approve(b.id, b.amountSats, { played: PLAYED.played, excluded: ourKeys(), rules, severity: b.severity || null, by }));
        }
        if (b.action === 'reject') return send(200, FEEDBACK.move(b.id, 'rejected', { reason: b.reason, by }));
        if (b.action === 'duplicate') return send(200, FEEDBACK.move(b.id, 'duplicate', { duplicateOf: b.of, by }));
        if (b.action === 'reward') { const w = FEEDBACK.createReward(b.id, { network: BOUNTY_NETWORK, comment: b.comment ?? null, by });
          if (!w.ok) return send(200, w);
          const lnurl = FEEDBACK.lnurlOf(w.reward.k1, { base: PUBLIC_BASE });
          // STRAIGHT TO THE REPORT'S LIGHTNING ADDRESS, WITH THE COMMENT (kanban #1474): when it names one and the admin did not ask for the link only; the
          // withdraw link stays the fallback (a wallet that gives no invoice, a failed route) and is answered too
          if (b.payTo === 'link' || !FEEDBACK.addressOf(b.id) || w.reward.state !== 'open') return send(200, { ...w, lnurl, address: FEEDBACK.addressOf(b.id) });
          if (!BOUNTY_PAYER || !bountyOn()) return send(200, { ...w, lnurl, paid: { ok: false, why: 'rewards are off' } });
          return one(() => FEEDBACK.payToAddress(w.reward.k1, { invoiceFor: (a, sats, c) => lnAddressInvoice(a, sats, c), decode: bountyDecode, pay: bountyPay }))
            .then((paid) => send(200, { ...w, reward: paid.reward || w.reward, lnurl: paid.ok ? null : lnurl, paid }), (e) => send(200, { ...w, lnurl, paid: { ok: false, why: e.message } })); }
        if (b.action === 'note') return send(200, FEEDBACK.note(b.id, { ticket: b.ticket, severity: b.severity, by }));
        return send(400, { ok: false, why: 'an action is approve, reject, duplicate, reward or note' });
      }).catch(() => send(500, { ok: false, why: 'try again' })));
      return undefined;
    }
    return send(404, { ok: false, why: 'no such admin door' });
  }
  // A REWARD'S LNURL-WITHDRAW (kanban #1342, LUD-03): the request, then the callback that pays the wallet's invoice once - one at a time (one())
  { const m = /^\/lnurlw\/([0-9a-f]{64})(\/callback)?$/.exec(path);
    if (m) {
      if (!FEEDBACK || !BOUNTY_PAYER || !bountyOn()) return send(503, { status: 'ERROR', reason: 'rewards are off' });
      if (!m[2]) return send(200, FEEDBACK.withdrawRequest(m[1], { base: PUBLIC_BASE }));
      const q = new URL(req.url, 'http://x').searchParams;
      if (q.get('k1') !== m[1]) return send(200, { status: 'ERROR', reason: 'k1 does not match the link' });
      return one(() => FEEDBACK.claim(m[1], q.get('pr') || '', { decode: bountyDecode, pay: bountyPay })).then((r) => send(200, r), () => send(200, { status: 'ERROR', reason: 'try again in a minute' }));
    } }
  // A SCREENSHOT FOR A REPORT (Daniel 2026-11-07): the raw image, before the report is signed; answers its SHA-256, which the report then names
  if (path === '/feedback/screenshot') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    if (!FEEDBACK || !SHOTS) return send(503, { ok: false, why: 'screenshots are not kept here' });
    const ip = ipKey(ipOf(req)), day = Math.floor(Date.now() / DAY_MS);
    while (SHOT_UPLOADS.length && Math.floor(SHOT_UPLOADS[0].atMs / DAY_MS) !== day) SHOT_UPLOADS.shift();
    if (ip && SHOT_UPLOADS.filter((x) => x.ip === ip).length >= SHOTS_PER_IP_PER_DAY) return send(429, { ok: false, why: 'this address sent all the screenshots it can today' });
    if (SHOT_UPLOADS.reduce((n, x) => n + (x.bytes || 0), 0) >= SHOT_DAY_BYTES) return send(429, { ok: false, why: 'the faucet took all the screenshots it keeps today: send the report without one, or try tomorrow' });
    { const free = freeBytes(SHOTS); if (free !== null && free < SHOT_FREE_FLOOR_BYTES) return send(507, { ok: false, why: 'the faucet has no room for screenshots just now: send the report without one' }); }
    const parts = []; let size = 0, over = false;
    // TOO BIG: read on and keep nothing, answered 413 at its end; cut only past four times the cap
    req.on('data', (c) => { size += c.length; if (size > SHOT_MOST) { over = true; parts.length = 0; if (size > 4 * SHOT_MOST) req.destroy(); return; } parts.push(c); });
    req.on('end', () => {
      if (over) return send(413, { ok: false, why: `a screenshot is at most ${SHOT_MOST / 1e6} MB` });
      const bytes = Buffer.concat(parts), kind = imageKind(bytes);
      if (!kind) return send(415, { ok: false, why: 'a screenshot is a PNG, JPEG or WebP image' });
      const h = createHash('sha256').update(bytes).digest('hex');
      const fresh = !shotFile(h);
      if (fresh) writeFileSync(pathJoin(SHOTS, `${h}.${kind}`), bytes);
      SHOT_UPLOADS.push({ ip, atMs: Date.now(), bytes: fresh ? bytes.length : 0 });
      return send(200, { ok: true, sha256: h });
    });
    return undefined;
  }
  // "MY FEEDBACK" (kanban #1342): a NIP-98 sign-in by the reporter's key; the reports' reward links are bearer secrets, so never by pubkey alone
  // THE NODE BOUNTY'S CHECKLIST (kanban #1342, Daniel 2026-11-08): read live from the seats' public doors for a node and the reporter's key - public,
  // the same answer the form fills in and the admin approves on; kept 10 min per pair (one read asks every seat for 7 days, ~30 s)
  if (path === '/feedback/node-check' && req.method === 'GET') {
    // as every reward detail: only toward the private page's origin while the bounty is off in public (Daniel 2026-11-07)
    if (!(bountyOn() && BOUNTY_ORIGINS.includes(String(req.headers.origin || '')))) return send(200, { ok: true, on: false });
    const q = new URL(req.url, 'http://x').searchParams;
    const node = String(q.get('node') || '').toLowerCase(), npub = String(q.get('npub') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(node) || (npub && !/^[0-9a-f]{64}$/.test(npub))) return send(400, { ok: false, why: 'GET /feedback/node-check?node=<64 hex>[&npub=<64 hex>]' });
    const k = `${node}:${npub}`, kept = NODE_CHECKS.get(k);
    if (kept && Date.now() - kept.at < 600000) return send(200, { ...kept.answer, keptMs: Date.now() - kept.at });
    // A FRESH CHECK ASKS EVERY SEAT (~136 requests), so (audit 5 #1402): one at a time over all callers, and at most NODE_CHECKS_PER_HOUR per address
    // (an IPv6 address counted per /64) - random npubs missed the cache and multiplied the load onto every seat
    const ip = String(ipOf(req) || '');
    const who = ipKey(ip) || ip;   // an IPv6 address by its /64, :: written out (kanban #1405)
    const mine = (NODE_CHECK_ASKS.get(who) || []).filter((t) => t > Date.now() - 3600000);
    if (mine.length >= NODE_CHECKS_PER_HOUR) return send(429, { ok: false, why: `at most ${NODE_CHECKS_PER_HOUR} node checks an hour from one address: try again later` });
    if (NODE_CHECK_BUSY) return send(429, { ok: false, why: 'a node check is running: try again in a minute' });
    mine.push(Date.now()); NODE_CHECK_ASKS.set(who, mine); if (NODE_CHECK_ASKS.size > 5000) NODE_CHECK_ASKS.delete(NODE_CHECK_ASKS.keys().next().value);
    NODE_CHECK_BUSY = true;
    return nodeCheckNow(node, npub).then((answer) => { NODE_CHECKS.set(k, { at: Date.now(), answer }); if (NODE_CHECKS.size > 200) NODE_CHECKS.delete(NODE_CHECKS.keys().next().value); send(200, answer); },
      (e) => send(502, { ok: false, why: `the seats could not be read: ${String(e.message || e).slice(0, 120)}` })).finally(() => { NODE_CHECK_BUSY = false; });
  }
  // THE REWARD TABLE (kanban #1342, Daniel 2026-11-08): the levels the form shows are the ones approve pays from - one source; public, no amounts
  // are promised while the bounty is off (the page shows the table only in its bounty build)
  // THE BOUNTY ADDRESS CHECKED WHILE IT IS TYPED (Daniel 2026-11-10: "er sagt mir nicht das test@test.de keine valid lightning addresse ist"): the same
  // check a report's address gets at Send (lnAddressWorks), asked by the dialog - only from the page's own origin, at most 30 an IP in 10 minutes
  if (path === '/feedback/lnaddress' && req.method === 'GET') {
    if (!BOUNTY_ORIGINS.includes(String(req.headers.origin || ''))) return send(200, { ok: false, why: 'not asked from the page' });
    // kanban #1537: counted by the caller's /64 (ipKey, as every other faucet limit) - one IPv6 line held 2^64 addresses of 30 checks each, and
    // each check fetches a URL the caller names; and at most LN_ASKS_MINUTE checks a minute from everyone together, so the faucet is never an
    // unlimited fetcher
    const ip = String(ipKey(ipOf(req)) || ipOf(req) || ''), now = Date.now();   // an IPv6 caller by its /64 (kanban #1511, #1537)
    const seen = (LN_ASKS.get(ip) || []).filter((t) => now - t < 600000); if (seen.length >= 30) return send(200, { ok: false, why: 'too many checks - it is checked again at Send' });
    // NO GLOBAL SLOT FOR WHAT FETCHES NOTHING (kanban #1873, #1905): text that is no address (or names no public host) counts toward the caller's own
    // 30 but is answered before the shared minute - a stranger's 'nothing' took a slot and, from a few dozen addresses, kept the minute full
    const asked = String(new URL(req.url, 'http://x').searchParams.get('a') || '').slice(0, 200), u = lnAddressUrl(asked);
    const counted = () => { seen.push(now); LN_ASKS.delete(ip); LN_ASKS.set(ip, seen); if (LN_ASKS.size > 5000) LN_ASKS.delete(LN_ASKS.keys().next().value); };
    if (!u.ok) { counted(); return send(200, { ok: false, why: u.why }); }
    // the global minute shared with POST /feedback's address checks (kanban #1714)
    if (!addressCheckSlot(now)) return send(200, { ok: false, why: 'too many checks - it is checked again at Send' });
    counted();
    lnAddressWorks(asked).then((w) => send(200, { ok: !!w.ok, why: w.ok ? null : w.why }), (e) => send(200, { ok: false, why: String((e && e.message) || e).slice(0, 120) }));
    return;
  }
  if (path === '/feedback/rewards' && req.method === 'GET') {
    // the amounts only toward the private page's origin (Daniel 2026-11-07: "Den bounty Funktion ausmachen bis ich es sage und nur auf einer privaten URL aktivieren")
    if (!(bountyOn() && BOUNTY_ORIGINS.includes(String(req.headers.origin || '')))) return send(200, { ok: true, on: false });
    // AND HOW FAR THIS WEEK'S BUDGET IS (Daniel 2026-11-10: "das wird im Fenster angezeigt wie weit wir schon sind"): approved this week of the weekly budget
    let budget = null; try { const b = FEEDBACK ? FEEDBACK.budget({ rules: RULES }) : null; budget = b ? { weekApprovedSats: b.weekApprovedSats, weeklyBudgetSats: b.weeklyBudgetSats } : null; } catch { budget = null; }
    return send(200, { ok: true, on: true, network: BOUNTY_NETWORK, levels: REWARD_LEVELS, nodeBaseSats: NODE_BOUNTY_BASE_SATS, perKeyPerWeek: RULES.perKeyPerWeek, budget,
      rule: 'A person reviews every report. Only the first report of a bug is paid. Nothing is paid for game results.' });
  }
  if (path === '/feedback/mine') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '86400' }); return res.end(); }
    if (!FEEDBACK) return send(503, { ok: false, why: 'reports are not kept here' });
    let ev = null;
    try { const h = String(req.headers.authorization || ''); if (h.startsWith('Nostr ')) ev = JSON.parse(Buffer.from(h.slice(6), 'base64').toString('utf8')); } catch { ev = null; }
    if (!ev) return send(401, { ok: false, why: 'sign in with your key (NIP-98)' });
    let last = null;
    // EACH REPORT WITH ITS REWARD, IF ANY: its state and the link to claim it (lnurl + the stable /reward page)
    for (const url of MINE_URLS) { const m = FEEDBACK.mine(ev, { url, method: 'GET' });
      // REWARDS ONLY TOWARD THE PRIVATE PAGE (the owner's switch): anywhere else the reports come with their states and no reward
      if (m.ok && !(bountyOn() && BOUNTY_ORIGINS.includes(String(req.headers.origin || '')))) return send(200, { ...m, reports: m.reports.map((r) => ({ ...r, amountSats: null, reward: null })) });
      if (m.ok) { const byReport = new Map(FEEDBACK.rewards({ pubkey: m.pubkey }).map((w) => [w.report, w]));
        return send(200, { ...m, reports: m.reports.map((r) => { const w = byReport.get(r.id);
          return { ...r, reward: w ? { sats: w.amountSats, network: w.network, state: w.state, comment: w.comment, address: w.address, paidMs: w.paidMs, lnurl: w.state === 'paid' ? null : FEEDBACK.lnurlOf(w.k1, { base: PUBLIC_BASE }) } : null }; }) }); }   // comment, address: kanban #1474
      last = m; }
    return send(401, { ok: false, why: last ? last.why : 'that sign-in does not stand' });
  }
  if (path === '/feedback') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
    if (req.method !== 'POST') return send(405, { ok: false, why: 'POST' });
    if (!env.FAUCET_CHAT_URL) return send(503, { ok: false, why: 'reports are off' });
    let raw = '';
    req.setEncoding('utf8');
    // THE CLIENT'S DEBUG WITH A REPORT (kanban #1391): a signed report carries up to 60,000 characters of the page's state, so a post is read to 96 KB
    req.on('data', (c) => { raw += c; if (raw.length > 98304) req.destroy(); });
    req.on('end', async () => {
      try {
        const b0 = JSON.parse(raw || '{}'), ip = ipOf(req);
        // every address check below goes through the caller's budget (kanban #1511): this name stands for addressCheckFor(ip, ...) here
        const lnAddressWorks = (a) => addressCheckFor(ip, a);
        // A SIGNED REPORT (kanban #1342): its own words go to the chat, and it is kept for review - only if it stands
        let b = b0, kept = null, counted = false;
        if (b0.event) {
          if (!FEEDBACK) return send(503, { ok: false, why: 'signed reports are not kept here' });
          const e = b0.event;
          const tagOf = (k) => { const t = Array.isArray(e.tags) ? e.tags.find((x) => Array.isArray(x) && x[0] === k) : null; return t ? String(t[1] ?? '') : ''; };
          let words = {}; try { words = JSON.parse(e.content); } catch { words = {}; }
          // and where a bounty for it is paid, if the reporter named it (kanban #1363): the signed content's lnAddress
          b = { ...b0, text: `${String(words.happened || '')}${words.expected ? `\nExpected: ${String(words.expected)}` : ''}${words.lnAddress ? `\nBounty address: ${String(words.lnAddress).slice(0, 200)}` : ''}`, build: tagOf('build'), game: tagOf('game'), round: tagOf('round') };
          const pre = feedbackDecide({ ...b, ip }, REPORTS);
          if (!pre.ok) return send(200, pre);
          // THE BOUNTY ADDRESS MUST WORK (Daniel 2026-11-10, #1342): asked before the report is kept, so a reward is never made for an address nothing pays to
          if (words.lnAddress) { const w = await lnAddressWorks(words.lnAddress); if (!w.ok) return send(200, { ok: false, why: `That Lightning address does not work: ${w.why}. Check it, or leave it empty.` }); }
          kept = FEEDBACK.take(e, { hasShot: (h) => !!shotFile(h) });
          if (!kept.ok) return send(200, kept);
          // COUNTED WHEN KEPT (audit 6, kanban #1424): it was counted only after the chat post went out - with the chat down every signed report was
          // kept and none counted, so the limits never tripped
          if (kept.kept) { REPORTS.push({ ip, atMs: Date.now() }); counted = true; }
        }
        // counted once (audit 6 re-check N9, kanban #1426): a signed report kept above is in REPORTS already, so the address's 50th report was
        // kept and numbered here and then refused as its own 51st
        const d = feedbackDecide({ ...b, ip }, counted ? REPORTS.slice(0, -1) : REPORTS);
        if (!d.ok) return send(200, d);
        // AN UNSIGNED REPORT'S BOUNTY ADDRESS TOO (#1342, measured on testnet-stage: a report from a tab with no identity named an address nothing pays to and
        // was taken): its "Bounty address:" line must work as well
        if (!b0.event) { const m = /\nBounty address: (\S+)/.exec(String(b0.text || '')); if (m) { const w = await lnAddressWorks(m[1]); if (!w.ok) return send(200, { ok: false, why: `That Lightning address does not work: ${w.why}. Check it, or leave it empty.` }); } }
        const key = readFileSync(env.FAUCET_CHAT_TOKEN_FILE, 'utf8').trim();
        const r = await fetch(`${env.FAUCET_CHAT_URL}/api/channels/${env.FAUCET_CHAT_CHANNEL}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ text: (kept && kept.label ? `${kept.label} · ` : '') + d.text }), signal: AbortSignal.timeout(10000) });
        if (!r.ok) return send(502, { ok: false, why: 'the report could not be kept just now' });
        if (!counted) REPORTS.push({ ip, atMs: Date.now() });
        if (d.player) appendFileSync(FOUNDING_FILE, `${JSON.stringify({ player: d.player, atMs: Date.now() })}\n`);
        send(200, { ok: true, ...(kept ? { id: kept.id, kept: kept.kept, number: kept.number ?? null, label: kept.label || null } : {}) });   // its number (kanban #1413)
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
