// BOTS THAT BUILD ORDER DEPTH WITH REAL WALLETS (kanban #236, the owner 2026-10-08: "A few bots simulate real bot behavior and
// build order depth"; the winnings paid out, measured to the msat). On the test host's paid regtest Up or Down market
// (market-series-regtest.sh, SERIES_GAME=updown): each bot is a browser context on the page - its own player wallet, funded
// over Lightning from alice's lnd through the page's own deposit - and places its orders through the market's own door
// (ARENA_GAME.market.order: the page's join, stake and fee locks on the federation, the entry handed to the seven seats).
//   M1, M2: market makers. Each reads BTC/USD (M1 Coinbase, M2 Kraken), takes the fair chance of Up (book-bot.js fairUp) and
//           quotes a ladder of buys on both sides below it (quoteLadder); twice a window, the second pass on the newer price.
//   T:      a taker, who pays the spread on the side the price is moving to.
// After the window: the outcome by 2 of the market's 3 (test) attestors, from Coinbase's 1-minute candles before the window's
// start and end, posted to the seven seats; then the seats' own settlement, and every number of it written down: the cleared
// book, each entry's position, the settlement the seats made, the same settlement computed here from the positions
// (book-ledger.js's rule), and each bot's wallet before and after.
//   URL=<page lobby link with &game=btc-updown-15m> SEATS=<p,p,...> LNCLI=<lncli> ALICE_DIR=<dir> ALICE_RPC=<host:port>
//   OUT=<dir> [CDP=9351] [DEPOSIT_SAT=20000] [SHARES=100] node book-bots-paid.mjs
import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fairUp, quoteLadder } from '../src/book-bot.js';
import { UPDOWN } from '../../arena-node/test/plugins/updown/index.js';
import { attestorSign } from '../../arena-node/test/plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';

const env = process.env;
const OUT = env.OUT; mkdirSync(OUT, { recursive: true });
const seats = env.SEATS.split(',').map((p) => `http://127.0.0.1:${p}`);
const SHARES = Number(env.SHARES || 100), TICK = 1000, PERIOD_MS = 900000, FEE = 0.99;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const log = [];
const say = (o) => { const l = { at: new Date().toISOString().slice(11, 23), ...o }; log.push(l); console.log(J(l)); };
const lncli = (...a) => new Promise((ok) => execFile(env.LNCLI, [`--lnddir=${env.ALICE_DIR}`, `--rpcserver=${env.ALICE_RPC}`, '--network=regtest', ...a], { timeout: 120000 },
  (e, so, se) => ok(e ? { error: String(se || e.message).trim().slice(0, 200) } : JSON.parse(so))));
const getJson = async (u) => { try { const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : { status: r.status, why: (await r.text()).slice(0, 200) }; } catch (e) { return { error: e.message }; } };

// ---- PRICES (the bots' own reads; the attestors' rule is the 60 s average, the 1-minute candle's close stands in here) ----
const coinbase = async () => { const j = await getJson('https://api.coinbase.com/v2/prices/BTC-USD/spot'); return j.data ? Number(j.data.amount) : null; };
const kraken = async () => { const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'); const r = j.result && Object.values(j.result)[0]; return r ? Number(r.c[0]) : null; };
async function closeBefore(ms) {
  const iso = (t) => new Date(t).toISOString();
  const c = await getJson(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(ms - 180000)}&end=${iso(ms)}`);
  const before = Array.isArray(c) ? c.filter((x) => x[0] * 1000 < ms).sort((a, b) => b[0] - a[0])[0] : null;
  return before ? before[4] : null;
}

// ---- THE BROWSER: one Chrome, one context per bot (its own storage, so its own wallet) ----
const v = await (await fetch(`http://127.0.0.1:${env.CDP || 9351}/json/version`)).json();
const bws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => (bws.onopen = r));
let n = 0; const pend = new Map(); const consoleBy = new Map();
bws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.consoleAPICalled' && d.sessionId && consoleBy.has(d.sessionId)) consoleBy.get(d.sessionId).push([Date.now(), d.params.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^(?!\[blwp\] player wallet deposit)([\s\S]{300})[\s\S]*$/, '$1')]); };   // a deposit line whole: its invoice is paid from it
const call = (m, params = {}, sessionId) => new Promise((r) => { const i = ++n; pend.set(i, r); bws.send(JSON.stringify({ id: i, method: m, params, ...(sessionId ? { sessionId } : {}) })); });
const contexts = [];
async function bot(name) {
  const ctx = (await call('Target.createBrowserContext')).result.browserContextId; contexts.push(ctx);
  const t = await call('Target.createTarget', { url: 'about:blank', browserContextId: ctx, newWindow: true });
  const sid = (await call('Target.attachToTarget', { targetId: t.result.targetId, flatten: true })).result.sessionId;
  const c = (m, pr) => call(m, pr, sid);
  const logs = []; consoleBy.set(sid, logs);
  await c('Page.enable'); await c('Runtime.enable');
  await c('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: true });
  const ev = async (x) => { const r = await c('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };
  const t0 = Date.now();
  await c('Page.navigate', { url: env.URL });
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { await wait(500); up = !!(await ev('!!(window.ARENA_GAME && window.ARENA_GAME.market && window.BLWP_READ_BALANCE)').catch(() => false)); }
  say({ bot: name, step: 'page up', ok: up, s: (Date.now() - t0) / 1000 });
  // EVERY DEPOSIT THE PAGE ASKS FOR: its Custom tab set to DEPOSIT_SAT, and the invoice it then makes paid from alice's lnd
  const paid = new Set(); const deposits = [];
  const depositSat = String(env.DEPOSIT_SAT || 20000);
  const payer = setInterval(async () => {
    await ev(`(() => { const m = document.getElementById('blwp-deposit'); if (!m || !m.querySelector('.dep-tabs')) return 0;
      const c = [...m.querySelectorAll('.dep-tabs button')].find((x) => /custom/i.test(x.textContent)); const f = m.querySelector('.dep-custom input');
      if (!c || !f || f.value === '${depositSat}') return 0; c.click(); f.value = '${depositSat}'; f.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`).catch(() => 0);
    const want = BigInt(depositSat) * 1000n;
    const line = logs.map(([, s]) => s).find((s) => s.startsWith('[blwp] player wallet deposit: ' + String(want) + ' msat, ') && !paid.has(s.split(', ')[1]));
    if (!line) return;
    const inv = line.split(', ')[1].trim(); paid.add(inv);
    const rec = { at: Date.now(), msat: String(want) }; deposits.push(rec);
    const r = await lncli('payinvoice', '--force', '--json', inv);
    rec.ok = r.status === 'SUCCEEDED'; rec.ms = Date.now() - rec.at; rec.feeMsat = r.fee_msat;
    say({ bot: name, step: 'deposit paid', msat: rec.msat, ok: rec.ok, ms: rec.ms, why: rec.ok ? undefined : (r.failure_reason || r.error) });
  }, 400);
  const balance = async () => { await ev('window.BLWP_READ_BALANCE && window.BLWP_READ_BALANCE()'); return ev('JSON.stringify(window.BLWP_WALLET_BALANCE || null)').then((s) => JSON.parse(s || 'null')); };
  // ONE ORDER, as the market's client places it, and its join followed to the end (picked / refused)
  const order = async (round, pick, cents, shares, expiryMs = 0) => {
    const stakeSat = Math.ceil((shares * cents) / 100 / FEE);
    const before = await ev('JSON.stringify(window.BLWP_PICKED || null)');
    const s0 = Date.now();
    const took = await ev(`window.ARENA_GAME.market.order(${J(round)}, ${pick}, ${cents * TICK}, ${expiryMs}, ${stakeSat * 1000})`);
    let st = null;
    for (const stop = Date.now() + 240000; Date.now() < stop; await wait(400)) {
      st = JSON.parse(await ev(`JSON.stringify({ join: window.BLWP_JOIN ? { state: window.BLWP_JOIN.state, why: window.BLWP_JOIN.why } : null, picked: window.BLWP_PICKED || null, refused: window.BLWP_JOIN_REFUSED || null })`) || '{}');
      if (st.join && st.join.state === 'refused') break;
      if (st.picked && J(st.picked) !== before && st.join && st.join.state === 'picked') break;
    }
    const rec = { bot: name, round: round.slice(0, 12), pick, cents, shares, stakeSat, took, ms: Date.now() - s0, state: st && st.join && st.join.state,
      why: st && st.join && st.join.why, entry: st && st.picked && st.picked.entryIdHex };
    say({ step: 'order', ...rec });
    return rec;
  };
  return { name, ev, logs, deposits, balance, order, shot: async (nm) => { const r = await c('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${OUT}/${name}-${nm}.png`, Buffer.from(r.result.data, 'base64')); },
    stop: () => clearInterval(payer) };
}

const M1 = await bot('M1'), M2 = await bot('M2'), T = await bot('T');
const bots = [M1, M2, T];
// THE WINDOW: the paid Up or Down round whose entry (= the window's end) closes soonest, with >= 9 min of it left
let round = null;
for (const stop = Date.now() + 1200000; Date.now() < stop && !round; await wait(5000)) {
  const rows = JSON.parse(await M1.ev('JSON.stringify((window.ARENA_GAME.allRows ? window.ARENA_GAME.allRows() : window.ARENA_GAME.rows()).filter((r) => !r.free && r.entryCloseMs))') || '[]');
  round = rows.filter((r) => r.entryCloseMs - Date.now() > 540000 && r.entryCloseMs - Date.now() <= PERIOD_MS + 60000).sort((x, y) => x.entryCloseMs - y.entryCloseMs)[0] || null;
}
if (!round) { say({ step: 'no paid window with 9 min left came up' }); process.exit(1); }
const endMs = round.entryCloseMs, startMs = endMs - PERIOD_MS;
say({ step: 'window', round: round.id, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
if (Date.now() < startMs) await wait(startMs - Date.now() + 70000);   // the price to beat is known a minute after the start
const beat = await closeBefore(startMs);
say({ step: 'price to beat', usd: beat });
const before = {}; for (const b of bots) before[b.name] = await b.balance();
say({ step: 'wallets before', before });

const orders = [];
// TWO QUOTING PASSES OF THE MAKERS (now, and 5 minutes on with the newer price); the taker between them
for (const pass of (env.PASSES === '1' ? [1] : [1, 2])) {
  const [pc, pk] = await Promise.all([coinbase(), kraken()]);
  const msLeft = endMs - Date.now();
  for (const [b, last] of [[M1, pc], [M2, pk]]) {
    const fair = fairUp({ beat, last, msLeft });
    const ladder = quoteLadder({ fair, levels: Number(env.LEVELS || 3), stepCents: 2, edgeCents: 1 });
    say({ step: 'quotes', pass, bot: b.name, last, fair: Number(fair.toFixed(4)), ladder: ladder.map((q) => `${q.outcome === 0 ? 'Up' : 'Down'} ${q.priceCents}c`) });
    for (const q of ladder) orders.push(await b.order(round.id, q.outcome, q.priceCents, SHARES));
  }
  if (pass === 1) {
    // THE TAKER: buys the side the price leans to, 5 c over the makers' fair, so it crosses their best quote
    const fair = fairUp({ beat, last: pc, msLeft: endMs - Date.now() });
    const side = fair >= 0.5 ? 0 : 1, cents = Math.min(99, Math.round((side === 0 ? fair : 1 - fair) * 100) + 5);
    orders.push(await T.order(round.id, side, cents, SHARES));
    if (env.PASSES !== '1') await wait(Math.max(0, Math.min(300000, endMs - Date.now() - 180000)));
  }
}
await M1.shot('orders');
// THE BOOK AS CLEARED, until the window's end
let book = null;
while (Date.now() < endMs + 20000) { book = await getJson(`${seats[0]}/book?round=${round.id}`); await wait(15000); }
say({ step: 'book at the close', batches: book && book.batches && book.batches.map((b) => ({ k: b.k, price: b.price, fills: (b.fills || []).length })), resting: book && book.resting && book.resting.length });

// ---- THE OUTCOME: 2 of the 3 test attestors, from Coinbase's 1-minute closes before the start and the end ----
await wait(Math.max(0, endMs + 65000 - Date.now()));
const endPrice = await closeBefore(endMs);
const outcome = endPrice >= beat ? 0 : 1;
const keys = UPDOWN.attestors;
const body = { roundId: Buffer.from(round.id, 'hex'), outcome, observedAtMs: BigInt(endMs) };
const att = encodeAttestation({ ...body, signatures: [keys[0], keys[2]].map((k) => attestorSign(k, body)) });
const posted = await Promise.all(seats.map(async (s) => { try { const r = await fetch(`${s}/outcome?round=${round.id}`, { method: 'POST', body: att }); return r.status; } catch (e) { return e.message; } }));
say({ step: 'attested', beat, endPrice, outcome: outcome === 0 ? 'Up' : 'Down', perSeat: posted });

// ---- THE SEATS' SETTLEMENT (final 600 s after the outcome), up to 25 min ----
let ls = null;
for (const stop = Date.now() + 1500000; Date.now() < stop; await wait(15000)) {
  ls = await getJson(`${seats[0]}/lock-settlement?round=${round.id}`);
  if (ls && (ls.state === 'ACCEPTED' || ls.state === 'REFUSED')) break;
}
const finalBook = await getJson(`${seats[0]}/book?round=${round.id}`);
const outcomeDoc = await getJson(`${seats[0]}/outcome?round=${round.id}`);
await wait(20000);
const after = {}; for (const b of bots) after[b.name] = await b.balance();
const withdrawable = {}; for (const b of bots) withdrawable[b.name] = await b.ev('window.BLWP_WITHDRAW_AVAILABLE ? JSON.stringify(window.BLWP_WITHDRAW_AVAILABLE(), (k, v) => (typeof v === "bigint" ? String(v) : v)) : null');
say({ step: 'settlement', state: ls && ls.state, why: ls && ls.why, txid: ls && ls.txid, after, withdrawable });
for (const b of bots) { await b.shot('end'); b.stop(); }
writeFileSync(`${OUT}/book-bots.json`, J({ round, beat, endPrice, outcome, orders, before, after, withdrawable, book: finalBook, settlement: ls, outcomeDoc,
  deposits: Object.fromEntries(bots.map((b) => [b.name, b.deposits])), console: Object.fromEntries(bots.map((b) => [b.name, b.logs.filter(([, s]) => /\[blwp\]|\[arena\]/.test(s))])), log }));
say({ step: 'done', out: `${OUT}/book-bots.json` });
for (const c of contexts) await call('Target.disposeBrowserContext', { browserContextId: c }).catch(() => {});
process.exit(0);
