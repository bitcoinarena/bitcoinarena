#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * ONE MARKET-MAKER BOT, A SCRIPT, NO BROWSER (kanban #581, 2026-10-22: "es darf kein Chrome sein sondern nur ein Script pro
 * Instanz was den Bot macht. Soll die API verwenden"). One process is one bot: its own wallet (the page's wasm lock client, its
 * notes kept in BOT_DIR/wallet.json across restarts), its own price source, and the seats' own doors - the same API a player's page
 * uses. Every LOOP_S it reads the open Bitcoin Up or Down windows, takes the fair chance of Up from the price to beat and the last
 * BTC/USD price (book-bot.js fairUp), and quotes a ladder of buys on both sides below it (quoteLadder); each rung it has not placed
 * yet in that window becomes an order: the stake and fee locks on the federation, the shares dealt to the signer nodes, and an entry
 * with its pick, its limit price and the BOT MARK (contracts.js BOT_MARKER: the leaderboard and its payouts leave bots out) handed
 * to the round's seats. DRY=1 reads and prices only - nothing is paid.
 *
 *   NODES=<seat urls> INVITE_FILE=<federation invite> WASM_PKG=<dir with blwp_lock_client.js> BOOK_BOT=<book-bot.js of the Up/Down
 *   app> BOT_DIR=<this bot's folder> [BOT_NAME=m1] [PRICE=coinbase|kraken] [LEVELS=2] [STEP_CENTS=2] [EDGE_CENTS=1] [SHARES=100]
 *   [MAX_ORDERS=4 per window] [TAKES=0 per window] [TAKE_CENTS=2] [TAKE_SHARES=SHARES] [TAKE_BASE=0.3] [TAKE_AHEAD_S=45] [SPREAD_S=600] [LOOP_S=120] [AHEAD_S=120] [GATEWAY=<url>] [LNCLI= PAYER_DIR= PAYER_RPC= for deposits] [SPOOL_DIR=<shared folder>] [TARGET_MSAT=2000000] [PEER_WAIT_S=60] [DRY=1]
 *   node tools/market-bot.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey, playerFor, feeBpsForRound } from '../../arena-client/src/join.js';
import { addressBook } from './signer-addresses.mjs';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { markBot, entryKeys } from './mark-bot.mjs';   // kanban #2035: every live entry marked bot in the explorer
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';
import { TICK, sellId } from '../../arena-protocol/src/order-book.js';
import { lockEntry } from './entry-locks.mjs';
import { saveLock, lookOwed, collectOwed } from '../../arena-client/src/page-lock.js';

const env = process.env;
for (const k of ['NODES', 'BOOK_BOT', 'BOT_DIR', ...(env.DRY ? [] : ['INVITE_FILE', 'WASM_PKG'])]) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
const NAME = env.BOT_NAME || 'bot', DIR = env.BOT_DIR, DRY = !!env.DRY;
const nodes = env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const LEVELS = Number(env.LEVELS || 2), STEP = Number(env.STEP_CENTS || 2), EDGE = Number(env.EDGE_CENTS || 1), SHARES = Number(env.SHARES || 100);
const MAX_ORDERS = Number(env.MAX_ORDERS || 4), LOOP_MS = Number(env.LOOP_S || 120) * 1000, AHEAD_MS = Number(env.AHEAD_S || 120) * 1000;
// THE TAKER (kanban #586, 2026-10-23: "if it's clear that up is winning more bots click up ... There must be always action"):
// TAKES taker buys a window at most, each of TAKE_SHARES on the side the fair chance favours, its limit TAKE_CENTS above that
// side's fair value - past the makers' bids, which rest EDGE_CENTS inside it, so it crosses the other side's resting bids and
// the batch trades. A bot takes in a pass with chance TAKE_BASE + (1 - TAKE_BASE) x |2 fair - 1|: some action always, nearly
// every bot when the window is decided. Unset or 0, the bot only quotes, as before.
const ONLY_SIDE = String(env.ONLY_SIDE || '').toLowerCase();
const TAKES = Number(env.TAKES || 0), TAKE_CENTS = Number(env.TAKE_CENTS || 2), TAKE_SHARES = Number(env.TAKE_SHARES || SHARES);
const TAKE_BASE = Number(env.TAKE_BASE || 0.3);
// THE SELLER (kanban #588, 2026-10-23: "wir brauchen bid und asks"): a bot sells shares it holds when the window has moved
// SELL_CENTS against or for its buy - its side's fair value that far under (cut the loss) or over (take the profit) the limit it
// bought at - with chance SELL_BASE a pass, all its unoffered shares of the entry at the fair value less 1¢: asks on the book from
// held shares, as Polymarket's Sell. SELLS=0 (the default): the bot never sells.
// AT MOST PER_PASS ORDERS A PASS (kanban #586, measured 2026-10-23 16:35Z: twenty bots placed 12 orders and 24 takes in one minute
// as a window opened - ~72 locks at once, federation A's seven guardians at 100-155 % CPU each and the test host at load 23 for two
// minutes): the rest of a pass's ladder waits for the next pass, so the orders spread over the window. Unset: no limit, as before.
const PER_PASS = Number(env.PER_PASS || 0) || Infinity;
const SELLS = Number(env.SELLS || 0), SELL_CENTS = Number(env.SELL_CENTS || 8), SELL_BASE = Number(env.SELL_BASE || 0.5);
// TAKES OVER THE WHOLE WINDOW (kanban #586, the owner: "There must be always action"; measured 2026-10-23 10:00-11:00Z: every bot
// spent its takes early - minutes 0-2, 13 and 14 and several in between had no take, and makers and takers alike stopped
// AHEAD_S before the close, just when the outcome is clearest): a bot's k-th take is due at its own point inside the k-th of
// TAKES equal slices of the window, so twenty bots take all window long; takes run until TAKE_AHEAD_S before the close
const TAKE_AHEAD_MS = Number(env.TAKE_AHEAD_S || 45) * 1000;
const OPEN_AHEAD_MS = TAKES > 0 ? Math.min(AHEAD_MS, TAKE_AHEAD_MS) : AHEAD_MS;
const unitOf = (text) => Number(BigInt('0x' + toHex(sha256(new TextEncoder().encode(text))).slice(0, 12))) / 2 ** 48;
// SPREAD OVER THE WINDOW (kanban #576, measured 2026-10-23 09:30-09:34Z: every bot ordered in a window's first minutes, while the last
// window settled - federation A's 7 guardians went from ~1 to 3.5 cores, the test host to load 28-56): each bot starts each window at its
// own offset, from its name and the window, somewhere in the first SPREAD_S - so the federation's work, and the trading, last the window
const SPREAD_MS = Number(env.SPREAD_S || 600) * 1000;
const offsetIn = (windowStartMs) => SPREAD_MS > 0 ? Number(BigInt('0x' + toHex(sha256(new TextEncoder().encode(`${NAME}:${windowStartMs}`))).slice(0, 12)) % BigInt(SPREAD_MS)) : 0;
const WINDOW_MS = 900000, GAME = env.GAME || 'btc-updown-15m';
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const say = (o) => console.log(J({ at: new Date().toISOString(), bot: NAME, ...o }));
const rand = (n) => new Uint8Array(randomBytes(n));
// the address of the last fetch that failed outright, for the pass failure line (kanban #804)
let lastFailedFetch = null;
{ const inner = globalThis.fetch; globalThis.fetch = async (u, init) => { try { return await inner(u, init); } catch (e) { lastFailedFetch = String(u && u.url ? u.url : u).slice(0, 160); throw e; } }; }
const getJson = async (u, ms = 8000) => { const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r.json(); };
// THE APP'S OWN PRICING (its page/book-bot.js, as the app published it): its `arena-sdk/...` imports read from this tree's arena-sdk
// through its export map - the app lives outside this tree, where `arena-sdk` names no package
async function importApp(file) {
  const sdk = new URL('../../arena-sdk/', import.meta.url);
  const map = JSON.parse(readFileSync(new URL('package.json', sdk), 'utf8')).exports;
  const src = readFileSync(file, 'utf8').replace(/from\s+'arena-sdk\/([^']+)'/g, (m, sub) => {
    if (!map[`./${sub}`]) throw new Error(`arena-sdk exports no ${sub}`);
    return `from '${new URL(map[`./${sub}`], sdk).href}'`;
  });
  const copy = join(tmpdir(), `arena-book-bot-${process.pid}.mjs`);
  writeFileSync(copy, src);
  return import(copy);
}
const { fairUp, quoteLadder, stakeFor } = await importApp(env.BOOK_BOT);

// ---- WHAT THIS BOT PLACED, KEPT ACROSS RESTARTS: per window, the rungs ("outcome:priceCents") already ordered ----
const placedFile = join(DIR, 'placed.json');
const placed = existsSync(placedFile) ? JSON.parse(readFileSync(placedFile, 'utf8')) : {};
const keepPlaced = () => { const t = `${placedFile}.tmp`; writeFileSync(t, JSON.stringify(placed)); renameSync(t, placedFile); };
// ---- WHAT THE BOT KEEPS PER ORDER (slice 5, collecting): the page's own lock record (page-lock.js saveLock, in a file-backed
// storage - the refund of a lock no seat took reads it) and the order itself (round, order number, when its window ends) ----
const kvFile = join(DIR, 'storage.json');
const kv = existsSync(kvFile) ? JSON.parse(readFileSync(kvFile, 'utf8')) : {};
const writeKv = () => { const t = `${kvFile}.tmp`; writeFileSync(t, JSON.stringify(kv), { mode: 0o600 }); renameSync(t, kvFile); };
const storage = { getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); writeKv(); },
  removeItem: (k) => { delete kv[k]; writeKv(); } };
const ordersFile = join(DIR, 'orders.json');
const orders = existsSync(ordersFile) ? JSON.parse(readFileSync(ordersFile, 'utf8')) : [];
const keepOrders = () => { const t = `${ordersFile}.tmp`; writeFileSync(t, JSON.stringify(orders)); renameSync(t, ordersFile); };

// ---- PRICES: the bot's own source; the price to beat is the 1-minute close before the window opened (Coinbase's candles) ----
const SOURCES = {
  coinbase: async () => Number((await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount),
  kraken: async () => Number(Object.values((await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).result)[0].c[0]),
};
const lastPrice = SOURCES[env.PRICE || 'coinbase'];
if (!lastPrice) throw new Error(`no price source ${env.PRICE}`);
const beats = new Map();   // window start -> its price to beat (it never changes once the window started)
async function beatOf(startMs) {
  if (beats.has(startMs)) return beats.get(startMs);
  if (beats.size > 8) beats.clear();
  const iso = (t) => new Date(t).toISOString();
  const c = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(startMs - 180000)}&end=${iso(startMs)}`);
  const before = Array.isArray(c) ? c.filter((x) => x[0] * 1000 < startMs).sort((a, b) => b[0] - a[0])[0] : null;
  if (!before) throw new Error(`no 1-minute candle before ${iso(startMs)}`);
  if (startMs < Date.now()) beats.set(startMs, before[4]);
  return before[4];
}

// ---- THE OPEN WINDOWS: the rounds of the market the seats list, entry open, closing far enough ahead to pay into ----
// THE WALLET'S FEDERATION: only its rounds are traded (each window has a round per federation; a lock pays into one)
let walletFed = null;   // set by wallet()
// THE LISTING KEPT UNTIL THE NEXT QUARTER HOUR, at most 5 min (kanban #586): a window's rounds do not change while it runs, so a bot
// passing every minute asks the seats no more often than one passing every five - the time filters below are read again each pass
let listed = null;   // { at, rows }
async function openWindows() {
  const now = Date.now();
  if (!DRY) await wallet();
  const quarter = Math.floor(now / WINDOW_MS);
  for (const n of [...(listed && Math.floor(listed.at / WINDOW_MS) === quarter && now - listed.at < 300000 ? [null] : []), ...nodes]) {
    try {
      // `next=2`: at most two upcoming rounds of each series - not every round the seat holds (measured 2026-10-22 23:00Z: ten bots
      // asking the whole listing, ~1,500 rounds, every minute put the test host at load 26); the same query from every bot is cached at the seat
      const all = n === null ? listed.rows : ((await getJson(`${n}/rounds?next=2&ahead=${WINDOW_MS * 2}`, 15000)).rounds || []);
      // AN EMPTY ANSWER IS ONE SEAT'S, NOT THE MARKET'S (kanban #602, measured 2026-10-24 00:00-00:12Z: the 7 test host seats listed no
      // round - the day's series unfunded there - and every bot said "no open window" while the 7 second-host seats listed the open window):
      // the next seat is asked, and only a listing with rounds is kept
      if (!all.length) { if (n !== null) say({ step: 'rounds', seat: n, why: 'listed no round' }); continue; }
      if (n !== null) listed = { at: now, rows: all };
      const rows = all
        // open until its entry closes or its window ends, whichever is first (measured 2026-10-23 07:47Z: the 07:30 window's round,
        // its entry close still ahead, refused every order two minutes past 07:45 - "the round is closed")
        .filter((r) => r.game && r.game.name === GAME && r.entryOpen && r.windowStartMs
          && Math.min(Number(r.entryCloseMs), Number(r.windowStartMs) + WINDOW_MS) - now > OPEN_AHEAD_MS)
        .filter((r) => !walletFed || !r.federation || String(r.federation.id || r.federation).toLowerCase().startsWith(walletFed.slice(0, 16)))
        // NOT A ROUND DRAWN TOO SHORT TO BE SEATED (2026-10-27: today's v24 rounds drew 3 nodes - their census predates the seats'
        // adverts naming v24 - and every pass stopped at "that round has no signer nodes yet", so no order reached the v23 round)
        .filter((r) => !(r.committee && r.committee.drawnCount && Number(r.committee.drawnCount.game) < 5))
        // NOT A BACKUP ROUND (kanban #804, measured 2026-10-30 08:39Z, federation B: each order on the 08:30 window's backup round
        // 28a49f3e was paid and locked, then refused by every seat - "this window is played on its primary grid, whose committee is
        // drawn (the backup rule, §5A.5)" - its stake left in the lock until the refund)
        .filter((r) => !r.backup || r.played);
      // A SEATED ROUND OVER ONE THAT NEVER WILL BE (2026-10-27 22:04Z: the bots quoted the day's v23 rounds - drawn 9, onto stopped nodes,
      // never seated - and never reached the seated v24 emergency round of the same window): once any round of a window is seated, only those
      const seated = rows.filter((r) => r.committee && r.committee.seated && r.committee.seated.game);
      if (seated.length) return seated.sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs));
      if (rows.length) return rows.sort((a, b) => Number(a.entryCloseMs) - Number(b.entryCloseMs));
    } catch (e) { say({ step: 'rounds', seat: n, why: e.message }); }
  }
  return [];
}

// ---- THE WALLET: one lock client, its notes in BOT_DIR/wallet.json (written whole on every change, never half) ----
let lc = null, LockClientCls = null, inviteText = null;
// EVERY FEDERATION CALL HAS A TIME LIMIT (kanban #602, measured 2026-10-23 22:38-22:50Z: a bot with a brand-new wallet waited on one
// lock-client call that got no answer - its only open handles were its guardian sockets - and stood still for good, with no error, no
// log line and no retry): a call over its limit is named in the log and throws; the wallet is opened again on the next call and the
// pass is tried again. The limits (ms) are far above what the calls take (measured: join 0.6-1.6 s, balance 1 ms, invoice 0.3-0.6 s).
const LIMIT = { join: 60000, balance: 20000, feeRule: 20000, invoice: 30000, ecashIn: 30000, deposit: 15 * 60000, round: 15000 };
async function fed(name, f, ms = LIMIT[name]) {
  const t0 = Date.now();
  let timer;
  try {
    return await Promise.race([f(), new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error(`${name} got no answer in ${Math.round(ms / 1000)} s`), { overLimit: name })), ms); })]);
  } catch (e) {
    if (e && e.overLimit) {
      say({ step: 'over limit', call: name, ms: Date.now() - t0, limitMs: ms });
      if (name !== 'round') { const old = lc; lc = null; try { if (old && typeof old.free === 'function') old.free(); } catch { /* still busy: dropped */ } }
    }
    throw e;
  } finally { clearTimeout(timer); }
}
// the deposit path's steps, timed from the first one (kanban #602)
const depositSteps = (t0) => (step, more = {}) => say({ step: 'deposit step', what: step, ms: Date.now() - t0, ...more });
const io = { puts: 0, writes: 0, writeMs: 0 };   // the wallet file's puts and writes (kanban #601)
async function wallet() {
  if (lc) return lc;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `arena-lock-client-${process.pid}.mjs`);
  copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  LockClientCls = LockClient;
  const file = join(DIR, 'wallet.json');
  const held = new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  // ONE WRITE PER TURN, NOT PER PUT (kanban #601, measured 2026-10-24: a bot's lock submit took 294-1,568 ms against ~45 ms in the browser;
  // every put of the lock client rewrote the whole wallet - 7-8.5 MB of JSON - so one transaction's puts were that many full writes): the
  // puts of one turn of the event loop are written once, before any network answer can be read. WALLET_WRITE=each: the old way, to compare.
  const eachPut = env.WALLET_WRITE === 'each';
  let due = false;
  const write = () => { due = false; const t0 = Date.now(); const t = `${file}.tmp`; writeFileSync(t, JSON.stringify([...held]), { mode: 0o600 }); renameSync(t, file); io.writes++; io.writeMs += Date.now() - t0; };
  const later = () => { io.puts++; if (eachPut) return write(); if (!due) { due = true; setImmediate(write); } };
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); later(); }, remove: (k) => { held.delete(k); later(); } };
  const seedFile = join(DIR, 'seed.hex');
  if (!existsSync(seedFile)) writeFileSync(seedFile, toHex(rand(32)), { mode: 0o600 });
  const invite = readFileSync(env.INVITE_FILE, 'utf8').replace(/["\s]/g, '');
  inviteText = invite;
  walletFed = String(LockClient.federationIdOf(invite)).toLowerCase();
  const t0 = Date.now();
  lc = await fed('join', () => LockClient.join(invite, walletFed, readFileSync(seedFile, 'utf8').trim(), store));
  say({ step: 'wallet open', ms: Date.now() - t0, fresh: held.size === 0 || undefined });
  return lc;
}

// ---- A DEPOSIT WHEN THE WALLET RUNS LOW: from the payer lnd through the named gateway (as tn4-rps-paid.mjs) ----
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '') })));
// ---- THE SPOOL FOLDER (slice 3): the bots of one machine share it, per federation. Bots once put ALL their e-cash there in one file
// (sendAllEcash); a bot that runs low still takes such files first (claimed by an atomic rename). Since #586 it holds the requests
// between bots below (payNeeds, topUp) instead: a winner paying out everything left it nothing to play with.
const SPOOL = env.SPOOL_DIR || join(DIR, '..', 'spool');
const spoolOf = () => { const d = join(SPOOL, walletFed ? walletFed.slice(0, 16) : 'unknown'); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
async function takeFromSpool(needMsat) {
  const w = await wallet(), d = spoolOf();
  let have = BigInt(await fed('balance', () => w.balanceMsat()));
  for (const f of readdirSync(d).filter((x) => x.endsWith('.ecash')).sort()) {
    if (have >= needMsat) break;
    const mine = join(d, `${f}.taking-${NAME}`);
    try { renameSync(join(d, f), mine); } catch { continue; }   // another bot took it
    const said = JSON.parse(await fed('ecashIn', () => w.receiveEcash(readFileSync(mine, 'utf8').trim())));
    if (said.state === 'Success' || said.state === 'AlreadyReceived') unlinkSync(mine);
    else renameSync(mine, `${mine}.${String(said.state || 'refused').toLowerCase()}`);
    // the reissue is answered before the balance shows it (measured 23:23Z: "Success", balance 0, and a Lightning deposit paid for
    // nothing): the balance is read again until it moved, at most 15 s
    const before = have;
    for (let t = 0; t < 30; t++) { have = BigInt(await w.balanceMsat()); if (have > before || said.state !== 'Success') break; await new Promise((r) => setTimeout(r, 500)); }
    say({ step: 'spool in', file: f, state: said.state, balanceMsat: have });
  }
  return have;
}
// ---- REBALANCING BETWEEN BOTS (kanban #586, 2026-10-23: "if bot a has won and bot b has lost, there will be an imbalance.
// You need to balance it again"): a bot keeps TARGET_MSAT. One that runs short asks the others first - it makes a deposit invoice for
// what brings it back to TARGET and posts it as a request (`need-<ms>-<bot>.json`, claimed by an atomic rename like the spool's files);
// a bot holding more than TARGET pays any request its surplus above TARGET covers (its withdraw, through the federation's gateway:
// e-cash in, e-cash out, no channel between). A request nobody claims within PEER_WAIT_S is taken back and paid by the payer lnd.
// The wallet cannot send part of its notes (sendAllEcash only), so an invoice is the one exact transfer between two bots.
const TARGET = BigInt(env.TARGET_MSAT || 2000000);
const PEER_WAIT_MS = Number(env.PEER_WAIT_S || 60) * 1000;
const needs = () => readdirSync(spoolOf()).filter((x) => /^need-\d+-[^.]+\.json$/.test(x)).sort();
async function payNeeds() {
  const w = await wallet(), d = spoolOf();
  let have = BigInt(await w.balanceMsat());
  if (have <= TARGET) return;
  for (const f of needs()) {
    if (f.endsWith(`-${NAME}.json`)) continue;
    const mine = join(d, `${f}.paying-${NAME}`);
    let ask; try { ask = JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { continue; }
    // the request and the gateway's 1 % both out of the surplus above TARGET
    if (BigInt(ask.msat) * 102n / 100n > have - TARGET) continue;
    try { renameSync(join(d, f), mine); } catch { continue; }   // claimed by another bot, or taken back by its asker
    try {
      const paid = JSON.parse(await w.withdraw(ask.invoice, env.GATEWAY || null));
      have = BigInt(await w.balanceMsat());
      say({ step: 'paid a bot', to: ask.bot, msat: ask.msat, state: paid.state, balanceMsat: have });
    } catch (e) { say({ step: 'pay a bot failed', to: ask.bot, msat: ask.msat, why: String(e.message).slice(0, 200) }); }
    try { unlinkSync(mine); } catch { /* gone already */ }
    if (have <= TARGET) break;
  }
}
async function topUp(needMsat) {
  const w = await wallet();
  let have = BigInt(await fed('balance', () => w.balanceMsat()));
  if (have >= needMsat) return have;
  const step = depositSteps(Date.now());
  step('balance read', { balanceMsat: have, needMsat });
  have = await takeFromSpool(needMsat);   // e-cash files an older bot left in the spool
  if (have >= needMsat) return have;
  const amount = (needMsat > TARGET ? needMsat : TARGET) - have;
  const rcv = JSON.parse(await fed('invoice', () => w.receive(String(amount), env.GATEWAY || '')));
  step('invoice made', { msat: amount });
  // FIRST THE OTHER BOTS
  const d = spoolOf(), f = `need-${Date.now()}-${NAME}.json`;
  writeFileSync(join(d, `${f}.tmp`), JSON.stringify({ bot: NAME, msat: String(amount), invoice: rcv.invoice }), { mode: 0o600 });
  renameSync(join(d, `${f}.tmp`), join(d, f));
  step('asked the other bots');
  const until = Date.now() + PEER_WAIT_MS;
  while (Date.now() < until && existsSync(join(d, f))) await new Promise((r) => setTimeout(r, 2000));
  let by = 'a bot';
  if (existsSync(join(d, f))) {
    // nobody claimed it: taken back (a rename that fails means a bot claimed it just now - then that bot pays)
    let back = false; try { renameSync(join(d, f), join(d, `${f}.self`)); back = true; } catch { /* claimed */ }
    if (back) {
      unlinkSync(join(d, `${f}.self`));
      if (!env.LNCLI) throw new Error(`the wallet holds ${have} msat, ${needMsat} needed, no bot paid and no payer is named (LNCLI)`);
      const payer = (...a) => run(env.LNCLI, [`--lnddir=${env.PAYER_DIR}`, `--rpcserver=${env.PAYER_RPC}`, `--network=${env.ARENA_TN4_NETWORK || 'testnet4'}`, ...a]);
      const paid = await payer('payinvoice', '--force', '--timeout', '90s', rcv.invoice);
      by = (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err.slice(0, 120)])[0];
      step('payer paid', { by });
    }
  } else step('a bot paid');
  const final = await fed('deposit', () => w.awaitReceive(rcv.operation));
  step('deposit in', { final });
  const after = BigInt(await fed('balance', () => w.balanceMsat()));
  say({ step: 'deposit', msat: amount, by, final, balanceMsat: after });
  return after;
}

// ---- ONE ORDER: the page's join for a market order, with the bot mark ----
async function placeOrder(c, rid, rung, orderIndex, signers, closeMs, marginMs = AHEAD_MS) {
  const t0 = Date.now();
  const r = { ...c, orderStakeMsat: rung.stakeMsat };
  // THE SEATED SIGNER NODES (the seating certificate's settlement committee), not the contract's list: a seated round's shares are
  // dealt to them - measured 2026-10-22 22:50Z, shares dealt to c.nodes: "this node is not one of the signer nodes that handout was dealt to"
  // KEPT AS THE PAGE KEEPS THEM (kanban #601: the first order of a pass waited 7.1 s and 24.6 s before its lock): the round's attested
  // claim key once per round and its signer nodes (the page's ROUND_PREP), the federation's fee rule once a minute
  const steps = {};
  let ts = Date.now();
  const att = await claimKeyOf(c, rid, signers);
  steps.claimKeyMs = Date.now() - ts; ts = Date.now();
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  const w = await wallet();
  steps.walletMs = Date.now() - ts; ts = Date.now();
  const rule = await feeRuleOf(w);
  steps.feeRuleMs = Date.now() - ts; ts = Date.now();
  const oc = { ...c, stakeMsat: rung.stakeMsat };
  // A MARKET ORDER PAYS THE MARKET'S OWN FEE (join.js feeBpsForRound: Up/Down's 1 %) out of its stake, and no reserve or developer
  // outputs (reserves.js: "a market's reserves are a later slice") - measured 2026-10-22 22:42Z: an entry built with a game's split
  // was refused, "charged 2020 where 1% of 40406 is 404"
  const feeBps = feeBpsForRound(r);
  const feeMsat = entryFeeMsat(rung.stakeMsat, feeBps);
  const split = { feeMsat, donationMsat: 0n, netMsat: netStakeMsat({ stakeMsat: rung.stakeMsat, feeMsat, donationMsat: 0n }), shares: [], reserveKey: null };
  // WHETHER THE ROUND MINTS FEE LOCKS is the seats' decision on the ROUND's stake, not this order's (measured 22:58Z: a 49 c order's
  // own stake said no fee lock, the seats said "this round mints fee locks ... an entry that brings no fee lock is not taken")
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) }, feeBps });
  await topUp(rung.stakeMsat + 200000n);
  steps.balanceMs = Date.now() - ts;
  // A DEPOSIT CAN TAKE MINUTES (measured 2026-10-23 07:51-08:02Z: a payment in flight until its invoice expired, the order then
  // made two minutes past its window and refused): the window is asked again here, before any lock is paid
  if (closeMs - Date.now() < marginMs) throw new Error('its window closes before this order would stand: not placed');
  const seed = Uint8Array.from(Buffer.from(readFileSync(join(DIR, 'seed.hex'), 'utf8').trim(), 'hex'));
  // the order's own key (join.js playerFor with its order number): the payout and refund key the bot finds again from its seed
  const player = playerFor({ ...r, id: rid }, { seed, curve: feldmanGroup, order: orderIndex }).pubkey;
  const p = (() => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } })();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD);
  // the lock lasts the round's own stake expiry (a market's window and settlement, 1800+ blocks), not lockEntry's 150 for a short game -
  // measured 22:53Z: "that stake lock's lock height 155634 (its expiration 157469 less the round's 1835 blocks)"
  const tLock = Date.now();
  const io0 = { ...io };
  // SUBMITTED BEFORE THE GUARDIANS AGREE (kanban #601, 2026-10-23 "Sofort eingereicht"): the locks sent, the entry handed to the seats
  // while the federation accepts them, the locks to the seats once it did
  const locks = await lockEntry({ lc: w, c: oc, split, stakePoint: point, player, claimPk: att.claimPk, gate, rand, expiry: Number(c.stakeExpiryBlocks), submitOnly: true });
  const lockMs = Date.now() - tLock;
  steps.lockPuts = io.puts - io0.puts; steps.lockWrites = io.writes - io0.writes; steps.lockWriteMs = io.writeMs - io0.writeMs;
  if (env.DEBUG) say({ step: 'locks', gate: gate.pays, gateWhy: gate.why, fee: !!locks.fee, feeLock: locks.entryFields.feeLockOutpoint && toHex(locks.entryFields.feeLockOutpoint.txid).slice(0, 12), feeMsat: split.feeMsat, netMsat: split.netMsat });
  // THE CONTRACT'S SLOTS, NOT THE SEATED COUNT (as the page deals, join.js sharesNeededFor; measured 2026-10-27 23:02Z: the 23:00
  // window's round seated 6 of its 7 slots and every order failed "no committee threshold for 6 slots")
  const needed = receiptsNeeded(Number(c.settlementSlots)), e = rand(32);
  const dealt = await dealHandout({ preimage: p, signerNodes: signers, roundId: rid, playerPubkey: player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  // THE PAGE'S OWN LOCK RECORD for this order (saveLock): what a refund of a lock no seat took reads, and lookOwed's last resort
  saveLock(storage, { roundId: rid, playerPubkey: player, stake: { preimage: p, body: encodeHandout(dealt.handout) }, lock: { outpoint: locks.stake.outpoint,
    fields: locks.stake.fields, feeLock: locks.fee ? { preimage: locks.fee.preimage, outpoint: locks.fee.outpoint, fields: locks.fee.fields } : null } });
  const session = ed25519.utils.randomSecretKey();
  // the entry as tn4-rps-paid.mjs builds a paid one, with the order's pick, limit price (until the market closes) and the bot mark
  const entry = { roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(p), stakeMsat: rung.stakeMsat,
    feeMsat: split.feeMsat, donationMsat: split.donationMsat, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], ...locks.entryFields, claimKeyAttestationRef: att.ref,
    pick: Number(rung.outcome), limitPrice: Number(rung.price), orderExpiryMs: 0n, bot: true };
  const eid = entryId(entry);
  // MARKED BOT IN THE EXPLORER AS IT GOES OUT (kanban #2035): by the admin code, so the real-player count stays true
  markBot(entryKeys(eid, entry)).then((m) => { if (!m.ok) say({ step: 'not marked bot', entry: toHex(eid).slice(0, 16), why: m.why }); });
  // EVERY SEAT AT ONCE (2026-10-23 ~19:45Z: "Wie lange dauert nun eine btc up down Order über die api?"): the seats were handed the
  // order one after another - handout, entry, fee lock, lock, each lock checked by that seat with the federation - so an order waited for
  // seven seats in a row. Each seat's four posts stay in order; the seats run side by side. `ms`: the whole order, the locks at the
  // federation (lockMs), and the seats (seatsMs, firstSeatMs when the first one held the lock)
  const tSeats = Date.now();
  let firstSeatMs = null, submittedMs = null, acceptedMs = null;
  const accepted = (locks.accepted || Promise.resolve()).then(() => { acceptedMs = Date.now() - t0; });
  const said = [];
  // NOT WAITING FOR THE SLOWEST SEAT (kanban #605, measured 2026-10-24: orders accepted 1.3-1.5 s in, yet seatsMs 50-65 s - one seat's
  // POST /lock answered after a minute, and Promise.all held the order for it): the order stands once `needed` seats hold its lock;
  // the others finish behind it. Each seat call has SEAT_LIMIT_MS; a seat that does not answer in it is counted as not taking it.
  const limit = () => AbortSignal.timeout(SEAT_LIMIT_MS);
  let held = 0, enough;
  const enoughHeld = new Promise((r) => { enough = r; });
  // and each signer node outside NODES at its own address (kanban #804): an installed node seated in the round takes its shares too
  const to = [...nodes, ...await signerEndpoints(signers)];
  const all = Promise.all(to.map(async (n) => {
    try {
      const h = await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout), signal: limit() });
      const hWhy = h.status >= 300 ? (await h.text()).trim().slice(0, 200) : null;
      const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry), signal: limit() });
      const enWhy = en.status >= 300 ? (await en.text()).trim().slice(0, 200) : null;
      if (en.status >= 200 && en.status < 300 && submittedMs === null) submittedMs = Date.now() - t0;
      // A SEAT THAT REFUSED THE ENTRY GETS NO LOCKS (2026-10-24, the explorer: "Some show 404"): a node not seated for the round
      // holds no entry, so its lock doors could only answer 404
      if (en.status < 200 || en.status >= 300) { said.push({ seat: n.replace(/^https?:\/\//, ''), entry: en.status, why: enWhy }); return; }
      // THE PLAYER'S LOCK CLAIM (kanban #2069, #2088): a signature by the stake point over the entry id, as the page sends it - a seat then hands
      // these locks only to a claimed entry, never to a copy under another stake point. Never fatal.
      try { await fetch(`${n}/lock-claim?entry=${toHex(eid)}`, { method: 'POST', body: schnorr.sign(lockClaimDigest(eid), p), signal: limit() }).then((r) => r.text()); } catch { /* the seats show it to each other */ }
      await accepted;
      if (locks.fee) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.fee.fields)), signal: limit() });
      const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.stake.fields)), signal: limit() });
      const lWhy = l.status >= 300 ? (await l.text()).trim().slice(0, 200) : null;
      if (l.status >= 200 && l.status < 300 && firstSeatMs === null) firstSeatMs = Date.now() - t0;
      said.push({ seat: n.replace(/^https?:\/\//, ''), entry: en.status, lock: l.status, ...(enWhy ? { why: enWhy } : {}), ...(hWhy ? { handout: h.status, handoutWhy: hWhy } : {}), ...(lWhy ? { lockWhy: lWhy } : {}) });
      if (l.status >= 200 && l.status < 300 && ++held >= needed) enough();
    } catch (x) { said.push({ seat: n, why: x.message.slice(0, 80) }); }
  }));
  await Promise.race([enoughHeld, all]);
  all.catch(() => { /* each seat's own catch said it */ });
  const seatsMs = Date.now() - tSeats;
  // TAKEN only when enough seats took the entry and its lock (as tn4-rps-paid.mjs counts): else the rung is tried again next pass
  const took = said.filter((x) => x.lock >= 200 && x.lock < 300).length;
  if (env.DEBUG) for (const x of said) say({ step: 'seat answer', ...x });
  if (took < needed) throw new Error(`the seats did not take the order: ${took} of ${needed} needed took its lock; ${said.find((x) => x.handoutWhy)?.handoutWhy ? `handout: ${said.find((x) => x.handoutWhy).handoutWhy}; ` : ''}${said.find((x) => x.why)?.why || 'no reason given'}`);
  return { entry: toHex(eid), took, said: said.map((x) => `${x.seat}:${x.entry}/${x.lock}`).join(' '), session: toHex(session), limitCents: Number(rung.price / TICK), outcome: Number(rung.outcome),
    ms: Date.now() - t0, lockMs, submittedMs, acceptedMs, seatsMs, firstSeatMs, steps };
}
// a seat that has not answered one order post in this long is counted as not taking the order (kanban #605)
const SEAT_LIMIT_MS = Number(env.SEAT_LIMIT_MS || 30000);
const CLAIM_KEYS = new Map();
// THE SIGNER NODES' OWN ADDRESSES, asked beside the seats (kanban #804, signer-addresses.mjs: federation B round 76c7d631 had two installed
// nodes among its six signer nodes, and "4 of 6 signer nodes attest this claim key" while both served it)
const book = addressBook(nodes);
const signerEndpoints = (signers) => book.outside(signers);
async function claimKeyOf(c, rid, signers) {
  const key = `${toHex(rid)}:${signers.map((x) => String(x)).join(',')}`;
  let p = CLAIM_KEYS.get(key);
  if (!p) {
    const asked = [...nodes, ...await signerEndpoints(signers)];
    p = attestedClaimKey({ round: { ...c, id: rid }, signerNodes: signers, nodes: asked, curve: pageCurve });
    CLAIM_KEYS.set(key, p);
    p.then((a) => { if (!a.ok) CLAIM_KEYS.delete(key); }, () => CLAIM_KEYS.delete(key));
    if (CLAIM_KEYS.size > 64) CLAIM_KEYS.delete(CLAIM_KEYS.keys().next().value);
  }
  return p;
}
let feeRuleKept = null;
async function feeRuleOf(w) {
  if (feeRuleKept && Date.now() - feeRuleKept.at < 60000) return feeRuleKept.rule;
  const rule = JSON.parse(await fed('feeRule', () => w.feeRule()));
  feeRuleKept = { at: Date.now(), rule };
  return rule;
}

// ---- WHAT THE BOT WINS, COLLECTED (slice 5): for every order whose window ended more than a minute ago, the page's own look
// (page-lock.js lookOwed: the settlement, where the order's lock is, its forfeit) and collect (collectOwed: the payout redeemed, the stake
// back by forfeit or by the order's key after expiry) into this bot's wallet - until the federation holds nothing more of that order ----
const roundOf = new Map();
async function collectPass() {
  // AT MOST COLLECT_PER_PASS ORDERS A PASS, each looked at again only after LOOK_AGAIN_S (measured 23:34Z: ten bots looking at every
  // open order every pass - each look asks the seats the settlement, the lock and the forfeit - put the test host at load 59)
  const now = Date.now(), per = Number(env.COLLECT_PER_PASS || 4), again = Number(env.LOOK_AGAIN_S || 600) * 1000;
  const due = orders.filter((o) => !o.final && now > Number(o.windowEndMs) + 60000 && now >= Number(o.nextLookMs || 0))
    .sort((a, b) => Number(a.nextLookMs || 0) - Number(b.nextLookMs || 0)).slice(0, per);
  if (!due.length) return;
  const w = await wallet();
  const seed = Uint8Array.from(Buffer.from(readFileSync(join(DIR, 'seed.hex'), 'utf8').trim(), 'hex'));
  for (const o of due) {
    try {
      if (!roundOf.has(o.round)) roundOf.set(o.round, decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${o.round}`)).arrayBuffer())));
      const c = roundOf.get(o.round), rid = fromHex(o.round);
      const ask = { round: c, roundId: rid, invite: inviteText, seed, curve: feldmanGroup, LockClient: LockClientCls, storage, nodes, order: o.order };
      const look = await lookOwed({ ...ask, client: w });
      if (look.payoutMsat > 0n || look.stakeMsat > 0n || look.refundMsat > 0n) {
        const before = BigInt(await w.balanceMsat());
        await collectOwed({ look, client: w, ...ask });
        const after = BigInt(await w.balanceMsat());
        say({ step: 'collected', round: o.round.slice(0, 16), order: o.order, payoutMsat: look.payoutMsat, stakeMsat: look.stakeMsat, refundMsat: look.refundMsat, creditedMsat: after - before });
      }
      if (look.final) { o.final = true; o.payout = look.payout && look.payout.state; o.stake = look.stake && look.stake.state; }
      else o.nextLookMs = Date.now() + again;
      keepOrders();
    } catch (e) { o.nextLookMs = Date.now() + again; keepOrders(); say({ step: 'collect failed', round: o.round.slice(0, 16), order: o.order, why: String(e.message).slice(0, 200) }); }
  }
}

// ---- THE TAKER (TAKES, above) ----
// this pass's taker buy, or null: the favoured side (a tie is Up, the market's rule) at its fair value + TAKE_CENTS, 1..99 cents
function takeOf(fair, taken, startMs, closeMs) {
  if (!(TAKES > taken)) return null;
  const span = closeMs - TAKE_AHEAD_MS - startMs;
  if (Date.now() < startMs + (span / TAKES) * (taken + unitOf(`${NAME}:${startMs}:take:${taken}`))) return null;   // not yet its slot
  if (Math.random() >= TAKE_BASE + (1 - TAKE_BASE) * Math.abs(2 * fair - 1)) return null;
  const outcome = fair >= 0.5 ? 0 : 1;
  const priceCents = Math.min(99, Math.max(1, Math.round((outcome === 0 ? fair : 1 - fair) * 100) + TAKE_CENTS));
  return { key: `take:${taken}`, outcome, priceCents, price: BigInt(priceCents) * TICK, shares: TAKE_SHARES,
    stakeMsat: stakeFor({ shares: TAKE_SHARES, priceCents }) };
}

// ---- THE SELLER (SELLS, above): the book of the window read from the seats; each of this bot's orders in it that holds
// shares of its side, unoffered, and whose side's fair value moved SELL_CENTS from its limit, sold at the fair value less 1¢ ----
async function sellPass(row, fair, closeAt) {
  if (!(SELLS > 0) || DRY || closeAt - Date.now() < TAKE_AHEAD_MS) return;
  const mine = orders.filter((o) => o.round === row.id && o.session && (o.sold || 0) < SELLS);
  if (!mine.length) return;
  // only a round's signer seats hold its book (the others answer an empty one): every seat asked, the fullest answer kept, as the page does
  const books = (await Promise.all(nodes.map((n) => getJson(`${n}/book?round=${row.id}`, 5000).catch(() => null)))).filter(Boolean);
  const book = books.reduce((a, b) => ((b.positions || []).length > ((a && a.positions) || []).length ? b : a), null);
  if (!book) return;
  const pos = new Map((book.positions || []).map((p) => [p.entry, p]));
  const resting = new Set((book.resting && book.resting.sells) || []);
  for (const o of mine) {
    const p = pos.get(o.entry);
    if (!p) continue;
    const side = Number(o.outcome), sh = (p.shares || [0, 0]).map((x) => BigInt(x));
    const offered = (o.sells || []).filter((x) => resting.has(x.id) || Date.now() - x.atMs < 30000).reduce((t, x) => t + BigInt(x.sharesMsat), 0n);
    const free = sh[side] - sh[1 - side] - offered;
    const shares = free / 1000n;
    if (shares < 1n) continue;
    const fairCents = Math.round((side === 0 ? fair : 1 - fair) * 100);
    if (Math.abs(fairCents - Number(o.limitCents)) < SELL_CENTS || Math.random() >= SELL_BASE) continue;
    const priceCents = Math.min(99, Math.max(1, fairCents - 1)), price = BigInt(priceCents) * TICK, sharesMsat = shares * 1000n;
    const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const id = sellId({ roundId: fromHex(row.id), entryId: fromHex(o.entry), outcome: side, price, sharesMsat, nonce });
    const signature = toHex(ed25519.sign(id, fromHex(o.session)));
    const body = J({ entry: o.entry, outcome: side, price, sharesMsat, nonce, signature });
    const said = await Promise.all(nodes.map((n) => fetch(`${n}/sell?round=${row.id}`, { method: 'POST', body, signal: AbortSignal.timeout(8000) })
      .then(async (r) => ({ status: r.status, why: r.ok ? '' : (await r.text()).slice(0, 120) })).catch((e) => ({ status: 0, why: e.message.slice(0, 80) }))));
    const took = said.filter((x) => x.status >= 200 && x.status < 300).length;
    if (took) { o.sells = [...(o.sells || []), { id: toHex(id), sharesMsat: String(sharesMsat), priceCents, atMs: Date.now() }]; o.sold = (o.sold || 0) + 1; keepOrders(); }
    say({ step: took ? 'sell' : 'sell refused', round: row.id.slice(0, 16), side: side === 0 ? 'Up' : 'Down', boughtAt: o.limitCents, fairCents, priceCents, shares: String(shares), took,
      ...(took ? {} : { why: said.map((x) => x.why).filter(Boolean)[0] || '' }) });
  }
}

// ---- THE LOOP ----
const seatedOf = new Map();   // round id -> its seating certificate's signer nodes
async function pass() {
  const windows = await openWindows();
  if (!windows.length) { say({ step: 'no open window' }); return; }
  const last = await lastPrice();
  for (const row of windows) {
    const start = Number(row.windowStartMs), end = start + WINDOW_MS;
    const closeAt = Math.min(Number(row.entryCloseMs), end);
    // the makers' turn: from this bot's offset in the window until AHEAD_S before the close
    const makerTurn = Date.now() >= start + offsetIn(start) && closeAt - Date.now() > AHEAD_MS;
    let beat; try { beat = await beatOf(start); } catch (e) { say({ step: 'beat', round: row.id.slice(0, 16), why: e.message }); continue; }
    const fair = fairUp({ beat, last, msLeft: end - Date.now() });
    // ONLY ONE SIDE (ONLY_SIDE=up|down, a measuring knob): one bot quoting only Down above its fair value crosses another's Up -
    // measured 2026-10-27: two bots on the same price both bought the favourite every window and no order ever filled
    const ladder = quoteLadder({ fair, levels: LEVELS, stepCents: STEP, edgeCents: EDGE, shares: SHARES })
      .filter((q) => !ONLY_SIDE || Number(q.outcome) === (ONLY_SIDE === 'down' ? 1 : 0));
    const done = new Set(placed[row.id] || []);
    const made = [...done].filter((k) => !k.startsWith('take:')).length, taken = done.size - made;
    const todo = makerTurn ? ladder.filter((q) => !done.has(`${q.outcome}:${q.priceCents}`)).slice(0, Math.max(0, MAX_ORDERS - made)) : [];
    const take = takeOf(fair, taken, start, closeAt);
    if (take) todo.push(take);
    if (SELLS > 0 && !DRY) { try { await sellPass(row, fair, closeAt); } catch (e) { say({ step: 'sell pass failed', round: row.id.slice(0, 16), why: String(e.message).slice(0, 200) }); } }
    say({ step: 'quote', round: row.id.slice(0, 16), window: new Date(start).toISOString().slice(11, 16), beat, last, fair: Number(fair.toFixed(4)),
      ladder: ladder.map((q) => `${Number(q.outcome) === 0 ? 'Up' : 'Down'}@${q.priceCents}c×${q.shares}=${q.stakeMsat}msat`), placed: [...done], todo: todo.length,
      ...(take ? { take: `${Number(take.outcome) === 0 ? 'Up' : 'Down'}@${take.priceCents}c×${take.shares}` } : {}) });
    if (DRY || !todo.length) continue;
    const c = decodeRoundContract(new Uint8Array(await fed('round', async () => (await fetch(`${nodes[0]}/round?id=${row.id}`, { signal: AbortSignal.timeout(LIMIT.round) })).arrayBuffer())));
    const rid = roundId(c);
    if (toHex(rid) !== row.id) throw new Error('the seat answered another round');
    // seated before anything is paid (§5A.7) - read once per round: a round's seated signers do not change
    // A ROUND NOT SEATED IS SKIPPED, NOT THE PASS (measured 2026-10-27 23:15-23:45Z: the test host seats listed the window's fed-A round
    // 3e8f9277 as unseated - their certificate never written in, the test host seats held it - so an unseated round of the window came
    // first, threw "that round has no signer nodes yet" and ended the pass before the seated one was asked)
    let seated = seatedOf.get(row.id);
    if (!seated) {
      try { seated = await clientSettlementSignerNodes(row.id, c, nodes, { curve: pageCurve }); }
      catch (e) { say({ step: 'not seated', round: row.id.slice(0, 16), why: String(e.message).slice(0, 160) }); continue; }
      seatedOf.set(row.id, seated);
    }
    let placedThisPass = 0;
    for (const q of todo) {
      if (placedThisPass >= PER_PASS) break;
      const index = done.size;
      try {
        const o = await placeOrder(c, rid, q, index, seated.signerNodes, closeAt, q.key ? TAKE_AHEAD_MS : AHEAD_MS);
        done.add(q.key || `${q.outcome}:${q.priceCents}`); placed[row.id] = [...done]; keepPlaced(); placedThisPass++;
        orders.push({ round: row.id, order: index, entry: o.entry, windowEndMs: end, atMs: Date.now(), session: o.session, outcome: o.outcome, limitCents: o.limitCents }); keepOrders();
        const { session: _s, ...shown } = o;
        say({ step: q.key ? 'take' : 'order', round: row.id.slice(0, 16), side: Number(q.outcome) === 0 ? 'Up' : 'Down', priceCents: q.priceCents, stakeMsat: q.stakeMsat, ...shown });
      } catch (e) { say({ step: 'order failed', round: row.id.slice(0, 16), priceCents: q.priceCents, why: String(e.message).slice(0, 300) }); break; }
    }
  }
}

for (;;) {
  try { await pass(); } catch (e) {
    // A FAILED FETCH NAMES ITS ADDRESS AND CAUSE (kanban #804: "TypeError: fetch failed" on every pass of a bot, with no address)
    const c = e && e.cause; say({ step: 'pass failed', why: String(e.stack || e.message).slice(0, 400), ...(c ? { cause: String(c.code || c.message || c).slice(0, 160) } : {}), ...(lastFailedFetch ? { url: lastFailedFetch } : {}) });
  }
  if (!DRY) { try { await collectPass(); } catch (e) { say({ step: 'collect pass failed', why: String(e.message).slice(0, 200) }); } }
  if (!DRY) { try { await payNeeds(); } catch (e) { say({ step: 'pay bots failed', why: String(e.message).slice(0, 200) }); } }
  if (env.ONCE) break;
  await new Promise((r) => setTimeout(r, LOOP_MS));
}
process.exit(0);
