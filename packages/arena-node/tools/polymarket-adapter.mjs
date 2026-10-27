#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE ARENA CLOB ADAPTER (kanban #736): Polymarket's CLOB API, whole, on localhost beside a trading bot. A stock Polymarket client
 * (py-clob-client, @polymarket/clob-client) pointed at it works unchanged: the reads are passed to the seats' own /polymarket/ doors
 * (src/polymarket.js), the writes are done here with this process's own wallet - the stake and fee locks in the federation, the handout
 * to the seated signer nodes, the entry handed to the round's seats (arena-order.mjs, as market-bot.mjs places its rungs).
 *
 *   WHY BESIDE THE BOT, NOT ON A SEAT. On Polymarket the bot signs an order and the exchange contract moves funds it approved. Here an
 *   order IS the money: e-cash notes locked in the federation under the round's claim key, from the player's wallet, with the player's
 *   keys. A seat holds neither, and must not (no custody at a node - §23); so the one process that can place an order in the bot's name
 *   is one that holds the bot's wallet, and that is this one, on the bot's machine. The seats keep answering what they hold.
 *
 *   AUTH, AS THE CLIENT EXPECTS IT. POST /auth/api-key (L1 headers: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE) mints
 *   { apiKey, secret, passphrase } for that address and keeps them in ADAPTER_DIR/creds.json; GET /auth/derive-api-key hands them back.
 *   The L1 EIP-712 signature is the client's identity, not checked against a chain (there is none). Every write carries L2 headers
 *   (POLY_API_KEY, POLY_PASSPHRASE, POLY_TIMESTAMP, POLY_SIGNATURE = HMAC-SHA256 over timestamp + method + path + body with the
 *   secret, urlsafe base64) and is checked as Polymarket checks it, so a client's signing code runs as written.
 *
 *   NODES=<seat urls, comma> INVITE_FILE=<federation invite> WASM_PKG=<dir with blwp_lock_client.js> ADAPTER_DIR=<state dir>
 *   [PORT=8787] [BIND=127.0.0.1] [DRY=1 - reads only; an order answers success:false]   node tools/polymarket-adapter.mjs
 *
 *   Beside Polymarket's paths: GET /arena/wallet { federation, balanceMsat, sats } and GET /arena/deposit?msat= { invoice } - a Lightning
 *   invoice into this wallet, paid from anywhere; the balance is read again on the next order.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseOrder, stakeForNet, orderIdOf, entryOfOrderId, conditionIdOf, END_CURSOR } from '../src/polymarket.js';
import { openWallet, placeOrder, cancelOrder, collectOrder } from './arena-order.mjs';

const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
/** Polymarket's L2 signature (py-clob-client signing/hmac.py build_hmac_signature): HMAC-SHA256 of ts + method + path + body, urlsafe base64. */
export function hmacSignature(secret, timestamp, method, requestPath, body = '') {
  return b64url(createHmac('sha256', fromB64url(secret)).update(`${timestamp}${method}${requestPath}${body || ''}`).digest());
}
/** A fetch with a time limit whose timer is cleared once the answer is read: an AbortSignal.timeout left armed resets the kept-alive
 *  connection for the next request on it (measured in the adapter test: POST /handout after a relayed GET answered ECONNRESET). */
async function timedFetch(url, init = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`no answer in ${ms} ms`)), ms);
  try { const r = await fetch(url, { ...init, signal: ac.signal }); const text = await r.text(); return { status: r.status, text }; } finally { clearTimeout(timer); }
}
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, poly_address, poly_signature, poly_timestamp, poly_nonce, poly_api_key, poly_passphrase' };

/**
 * THE ADAPTER, as a server one can start in a test: `nodes` the seats, `dir` its state, `placer` what places an order (the wallet's, or a
 * stub) - async ({ roundHex, outcome, price, stakeMsat, orderIndex, expiryMs }) => { entry, session, player, windowEndMs } - `canceller`
 * ({ roundHex, entryHex, session }) => { ok }, `collector` ({ roundHex, orderIndex }) => { final }. Answers { server, listen(port, bind), close, state }.
 */
export function createAdapter({ nodes, dir, placer, canceller, collector = null, wallet = null, now = () => Date.now(), log = () => {} }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (name) => join(dir, name);
  const load = (name, empty) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : empty);
  const keep = (name, v) => { const t = `${file(name)}.tmp`; writeFileSync(t, JSON.stringify(v), { mode: 0o600 }); renameSync(t, file(name)); };
  // THE STATE: the credentials per address, and every order this adapter placed (its session key cancels it; its index finds its winnings)
  const creds = load('creds.json', {});
  const orders = load('orders.json', []);
  const state = { creds, orders };
  const ownIds = () => new Set(orders.map((o) => orderIdOf(o.entry)));

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', ...CORS }); res.end(J(body)); };
  const read = (req) => new Promise((ok, no) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => ok(Buffer.concat(chunks).toString('utf8'))); req.on('error', no); });
  const header = (req, k) => { const v = req.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };

  /** The seats asked in turn: the first answer under 500 is the answer. */
  async function fromSeat(path, init = {}) {
    let last = { status: 502, text: 'no seat answered' };
    for (const n of nodes) {
      try {
        const r = await timedFetch(`${n}/polymarket${path}`, init, 15000);
        if (r.status < 500) return r;
        last = r;
      } catch (e) { last = { status: 502, text: e.message }; }
    }
    return last;
  }
  const relay = (res, got) => { res.writeHead(got.status, { 'content-type': 'application/json', ...CORS }); res.end(got.text); };

  /** L1: an address and a signature over it (the EIP-712 auth message; not checked against a chain). */
  const l1 = (req) => { const a = String(header(req, 'POLY_ADDRESS') || '').toLowerCase(); return a && header(req, 'POLY_SIGNATURE') ? a : null; };
  /** L2: the API key's HMAC over this request, as the client built it. { ok, address } or { ok: false, why }. */
  function l2(req, path, body) {
    const key = header(req, 'POLY_API_KEY'), pass = header(req, 'POLY_PASSPHRASE'), ts = header(req, 'POLY_TIMESTAMP'), sig = header(req, 'POLY_SIGNATURE');
    const address = String(header(req, 'POLY_ADDRESS') || '').toLowerCase();
    const c = creds[address];
    if (!c || c.apiKey !== key) return { ok: false, why: 'no API key for that address: POST /auth/api-key first (create_or_derive_api_creds)' };
    if (c.passphrase !== pass) return { ok: false, why: 'the passphrase does not match that key' };
    if (!/^[0-9]{1,12}$/.test(String(ts)) || Math.abs(Math.floor(now() / 1000) - Number(ts)) > 600) return { ok: false, why: 'POLY_TIMESTAMP is more than 10 minutes from this clock' };
    const want = hmacSignature(c.secret, ts, req.method, path, body);
    const a = Buffer.from(String(sig || '')), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: 'the HMAC signature does not match (timestamp + method + path + body, the key\'s secret)' };
    return { ok: true, address };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://adapter');
    const path = url.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await read(req);
    try {
      // ---- AUTH ----
      if (path === '/auth/api-key' && req.method === 'POST') {
        const address = l1(req);
        if (!address) return json(res, 401, { error: 'L1 headers needed: POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE' });
        if (!creds[address]) { creds[address] = { apiKey: randomUUID(), secret: b64url(randomBytes(32)), passphrase: randomBytes(16).toString('hex'), madeAt: now() }; keep('creds.json', creds); }
        return json(res, 200, { apiKey: creds[address].apiKey, secret: creds[address].secret, passphrase: creds[address].passphrase });
      }
      if (path === '/auth/derive-api-key' && req.method === 'GET') {
        const address = l1(req);
        const c = address && creds[address];
        return c ? json(res, 200, { apiKey: c.apiKey, secret: c.secret, passphrase: c.passphrase }) : json(res, 404, { error: 'no key for that address yet: POST /auth/api-key' });
      }
      if (path === '/auth/api-keys' && req.method === 'GET') { const a = l2(req, path, body); return a.ok ? json(res, 200, { apiKeys: [creds[a.address].apiKey] }) : json(res, 401, { error: a.why }); }
      if (path === '/auth/api-key' && req.method === 'DELETE') { const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why }); delete creds[a.address]; keep('creds.json', creds); return json(res, 200, 'OK'); }
      if (path === '/auth/ban-status/closed-only') return json(res, 200, { closed_only: false });
      // ---- THE WALLET (Arena's own doors) ----
      if (path === '/arena/wallet') return json(res, 200, wallet ? { federation: wallet.federation, balanceMsat: String(await wallet.balanceMsat()), sats: Number(await wallet.balanceMsat() / 1000n) } : { federation: null, balanceMsat: '0', sats: 0, dry: true });
      if (path === '/arena/deposit') {
        if (!wallet) return json(res, 501, { error: 'no wallet (DRY)' });
        const msat = String(url.searchParams.get('msat') || '');
        if (!/^[0-9]{4,15}$/.test(msat)) return json(res, 400, { error: 'GET /arena/deposit?msat=<at least 1000>' });
        const rcv = JSON.parse(await wallet.lc.receive(msat, ''));
        return json(res, 200, { invoice: rcv.invoice, operation: rcv.operation, msat });
      }
      if (path === '/balance-allowance') {
        const sats = wallet ? Number(await wallet.balanceMsat() / 1000n) : 0;
        return json(res, 200, { balance: String(BigInt(sats) * 1000000n), allowances: {} });   // sats, in Polymarket's 6-decimal units
      }
      if (path === '/balance-allowance/update') return json(res, 200, 'OK');
      if (path === '/notifications') return json(res, 200, []);
      if (path === '/v1/heartbeats' && req.method === 'POST') return json(res, 200, { heartbeat_id: randomUUID() });
      // ---- THE WRITES ----
      if (path === '/order' && req.method === 'POST') {
        const a = l2(req, path, body);
        if (!a.ok) return json(res, 401, { success: false, errorMsg: a.why, orderID: '', status: '' });
        let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { success: false, errorMsg: 'the body is not JSON', orderID: '', status: '' }); }
        const o = parseOrder(parsed);
        if (!o.ok) return json(res, 400, { success: false, errorMsg: o.why, orderID: '', status: '' });
        if (o.side === 'SELL') return json(res, 400, { success: false, errorMsg: 'a SELL of held shares is not placed through the adapter yet (kanban #736): cancel and re-buy the other side', orderID: '', status: '' });
        // THE ROUND the token names: the one of its two candidates the seats hold
        let roundHex = null;
        for (const h of o.candidates) { const got = await fromSeat(`/markets/${conditionIdOf(h)}`); if (got.status === 200) { roundHex = h; break; } }
        if (!roundHex) return json(res, 404, { success: false, errorMsg: 'no seat holds a market of that token', orderID: '', status: '' });
        const market = JSON.parse((await fromSeat(`/markets/${conditionIdOf(roundHex)}`)).text);
        if (!market.accepting_orders) return json(res, 400, { success: false, errorMsg: `the market is not accepting orders (${market.closed ? 'closed' : 'not open yet'}: window ${market.game_start_time} - ${market.end_date_iso})`, orderID: '', status: '' });
        const feeBps = Number(market.maker_base_fee || 0);
        const stakeMsat = stakeForNet(o.netMsat, feeBps);
        // FOK / FAK: good for the next batch only - a GTD expiring in a second (the batch interval is 0.5 s)
        const expiryMs = o.orderType === 'FOK' || o.orderType === 'FAK' ? BigInt(now()) + 1000n : o.expiryMs;
        const orderIndex = orders.filter((x) => x.round === roundHex).length;
        let placed;
        try { placed = await placer({ roundHex, outcome: o.outcome, price: o.price, stakeMsat, orderIndex, expiryMs, maker: a.address }); }
        catch (e) { log({ step: 'order refused', why: e.message }); return json(res, 400, { success: false, errorMsg: e.message, orderID: '', status: '' }); }
        orders.push({ entry: placed.entry, session: placed.session, player: placed.player, round: roundHex, order: orderIndex, outcome: o.outcome, priceCents: Number(o.price / 1000n), shares: String(o.shares),
          stakeMsat: String(stakeMsat), maker: a.address, token: o.token, orderType: o.orderType, at: now(), windowEndMs: placed.windowEndMs || null, final: false });
        keep('orders.json', orders);
        log({ step: 'order', id: orderIdOf(placed.entry), round: roundHex.slice(0, 16), outcome: o.outcome, price: o.priceDecimal, shares: String(o.shares), stakeMsat: String(stakeMsat) });
        return json(res, 200, { success: true, errorMsg: '', orderID: orderIdOf(placed.entry), transactionsHashes: [], status: 'live', takingAmount: '', makingAmount: '' });
      }
      if (path === '/orders' && req.method === 'POST') return json(res, 400, [{ success: false, errorMsg: 'post the orders one by one (POST /order): each is its own lock in the federation', orderID: '' }]);
      const cancels = async (ids, a) => {
        const canceled = [], not_canceled = {};
        for (const id of ids) {
          const eh = entryOfOrderId(id);
          const o = eh && orders.find((x) => x.entry === eh && x.maker === a.address);
          if (!o) { not_canceled[id] = 'not an order of this adapter'; continue; }
          try { const got = await canceller({ roundHex: o.round, entryHex: o.entry, session: o.session }); if (got.ok) { o.cancelAt = now(); canceled.push(id); } else not_canceled[id] = (got.said || []).map((s) => s.why).filter(Boolean)[0] || 'no seat took the cancel'; }
          catch (e) { not_canceled[id] = e.message; }
        }
        keep('orders.json', orders);
        return { canceled, not_canceled };
      };
      if (path === '/order' && req.method === 'DELETE') {
        const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why });
        let b; try { b = JSON.parse(body); } catch { return json(res, 400, { error: 'a body of { orderID }' }); }
        return json(res, 200, await cancels([String(b.orderID || '')], a));
      }
      if (path === '/orders' && req.method === 'DELETE') {
        const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why });
        let b; try { b = JSON.parse(body); } catch { return json(res, 400, { error: 'a body of [orderID]' }); }
        return json(res, 200, await cancels(Array.isArray(b) ? b.map(String) : [], a));
      }
      if ((path === '/cancel-all' || path === '/cancel-market-orders') && req.method === 'DELETE') {
        const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why });
        let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { b = {}; }
        const market = b.market ? String(b.market).toLowerCase().replace(/^0x/, '') : null;
        const ids = orders.filter((o) => o.maker === a.address && !o.cancelAt && !o.final && (!market || o.round === market) && (!b.asset_id || o.token === String(b.asset_id)) && o.windowEndMs && o.windowEndMs > now()).map((o) => orderIdOf(o.entry));
        return json(res, 200, await cancels(ids, a));
      }
      // ---- THE READS THAT ARE THIS ADAPTER'S OWN: its orders, trades and positions ----
      if ((path === '/data/orders' || path === '/data/trades') && req.method === 'GET') {
        const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why });
        const mine = orders.filter((o) => o.maker === a.address);
        const rounds = new Set(mine.map((o) => o.round));
        const q = url.searchParams;
        if (q.get('market')) { const h = String(q.get('market')).toLowerCase().replace(/^0x/, ''); for (const r of [...rounds]) if (r !== h) rounds.delete(r); }
        const data = [];
        for (const r of rounds) {
          const got = await fromSeat(`${path}?market=${conditionIdOf(r)}${path === '/data/orders' ? '&all=1' : ''}`);
          if (got.status !== 200) continue;
          const rows = JSON.parse(got.text).data || [];
          const own = ownIds();
          for (const x of rows) if (own.has(path === '/data/orders' ? x.id : x.taker_order_id)) data.push(x);
        }
        let out = data;
        if (path === '/data/orders' && q.get('all') !== '1') out = out.filter((x) => ['LIVE', 'DELAYED'].includes(x.status));
        if (q.get('asset_id')) out = out.filter((x) => x.asset_id === q.get('asset_id'));
        if (q.get('id')) out = out.filter((x) => x.id === q.get('id'));
        return json(res, 200, { data: out, next_cursor: END_CURSOR, limit: out.length, count: out.length });
      }
      if (path.startsWith('/data/order/') && req.method === 'GET') {
        const a = l2(req, path, body); if (!a.ok) return json(res, 401, { error: a.why });
        const eh = entryOfOrderId(path.slice('/data/order/'.length));
        if (!eh || !orders.some((o) => o.entry === eh && o.maker === a.address)) return json(res, 404, { error: 'not an order of this adapter' });
        return relay(res, await fromSeat(path));
      }
      if (path === '/positions' && req.method === 'GET') {
        // every own filled order's position, from the seats; `user` is taken as this adapter (its orders have a key each)
        const data = [];
        for (const o of orders) { if (o.cancelAt && !o.final) { /* may still hold a fill */ } const got = await fromSeat(`/positions?user=${o.entry}&market=${conditionIdOf(o.round)}`); if (got.status === 200) data.push(...JSON.parse(got.text)); }
        return json(res, 200, data);
      }
      // ---- EVERYTHING ELSE IS A SEAT'S ----
      if (req.method === 'GET') return relay(res, await fromSeat(`${path}${url.search}`));
      if (path === '/books' && req.method === 'POST') return relay(res, await fromSeat(path, { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
      return json(res, 404, { error: `no such door: ${req.method} ${path}` });
    } catch (e) {
      log({ step: 'door failed', path, why: e.message });
      return json(res, 500, { error: e.message });
    }
  }

  const server = createServer((req, res) => { handle(req, res).catch((e) => { try { json(res, 500, { error: e.message }); } catch { /* gone */ } }); });
  // THE COLLECTOR: every minute, each order whose window ended over a minute ago and is not final - its winnings into the wallet
  let timer = null;
  if (collector) timer = setInterval(async () => {
    for (const o of orders.filter((x) => !x.final && x.windowEndMs && now() > x.windowEndMs + 60000 && now() >= (x.nextLookMs || 0)).slice(0, 4)) {
      try { const got = await collector({ roundHex: o.round, orderIndex: o.order }); if (got.final) o.final = true; else o.nextLookMs = now() + 600000; if (got.payoutMsat > 0n || got.stakeMsat > 0n || got.refundMsat > 0n) log({ step: 'collected', order: orderIdOf(o.entry), ...got }); }
      catch (e) { o.nextLookMs = now() + 600000; log({ step: 'collect failed', order: orderIdOf(o.entry), why: e.message }); }
      keep('orders.json', orders);
    }
  }, 60000).unref();
  return { server, state, handle,
    listen: (port, bind = '127.0.0.1') => new Promise((ok) => server.listen(port, bind, () => ok(server.address().port))),
    close: () => new Promise((ok) => { if (timer) clearInterval(timer); server.close(() => ok()); }) };
}

// ---- THE SCRIPT ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  for (const k of ['NODES', 'ADAPTER_DIR', ...(env.DRY ? [] : ['INVITE_FILE', 'WASM_PKG'])]) if (!env[k]) { console.error(`${k} is needed`); process.exit(2); }
  const nodes = env.NODES.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
  const say = (o) => console.log(J({ at: new Date().toISOString(), ...o }));
  const kept = new Map();
  const wallet = env.DRY ? null : await openWallet({ dir: env.ADAPTER_DIR, invitePath: env.INVITE_FILE, wasmPkg: env.WASM_PKG });
  if (wallet) say({ step: 'wallet open', federation: wallet.federation, balanceMsat: String(await wallet.balanceMsat()) });
  const placer = wallet ? (o) => placeOrder({ nodes, wallet, kept, log: say, ...o }) : async () => { throw new Error('DRY: nothing is placed'); };
  const canceller = (o) => cancelOrder({ nodes, ...o });
  const collector = wallet ? (o) => collectOrder({ nodes, wallet, kept, ...o }) : null;
  const a = createAdapter({ nodes, dir: env.ADAPTER_DIR, placer, canceller, collector, wallet, log: say });
  const port = await a.listen(Number(env.PORT || 8787), env.BIND || '127.0.0.1');
  say({ step: 'listening', base: `http://${env.BIND || '127.0.0.1'}:${port}`, seats: nodes, dry: !!env.DRY });
}
