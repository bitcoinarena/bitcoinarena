// THE ARENA'S TRANSACTION EXPLORER, explorer.bitcoinarena.io (kanban #624, 2026-10-24: "each order that was executed gets a transaction
// id in upordown and in the account history. They point to explorer.bitcoinarena.io which records all transactions. They query nodes in the
// background for new transactions but maintains a local cache for faster loading. Also records the timing info we already display there and
// all relevant data. Also timings for all other apps."; "It should all be cached not be fetched from a node"; "You should do that for each
// tx not just on the fly"). A transaction's id is its entry id, the same at every seat.
//
//   every minute (cron)   each seat's GET /txs?full=1 over the last READ_BACK_MS: every transaction it holds with its whole record;
//                         merged across the seats and written to D1 (txs) for EVERY transaction, only where it changed
//   every minute (cron)   each seat's GET /payments: the gifts, zaps and items bought (kanban #683), each a row of its own kind
//   GET /api/recent       a page of them, newest first, from D1: ?app= &kind= &fed= &since= &q=, &before= / &after= a row's cursor (kanban #683)
//   GET /api/tx/<id>      from D1; one the minute has not read yet is read from the seats once and kept
//   /, /tx/<id>           the pages (www/), with what D1 holds built into the page, so they draw at once
//   GET /api/metrics      the Metrics page's figures (kanban #676): volume per day from D1, the protocol reserve and the websites' fees
//   /metrics              that page, its figures built in
//   GET /api/health       the Network health page's kept copy (kanban #686): every door that page asks, asked every minute (its own cron)
//   GET /api/played       played rounds per day, week and month, per game, real players apart from the owner and our bots (kanban #1090)
//   GET /api/totals       every round since the first one this explorer holds, per game: rounds, rounds settled, entries (kanban #1197; a count that only grows)
//   POST /api/mark        entry keys that are the owner's or a bot's, with the admin code (kanban #1090); the owner's address is kept (kanban #1414)
//   GET  /api/admin-ip    { admin }: whether the caller's address sent the admin code within 48 hours (kanban #1414, #1420)
//   POST /api/mark-ip     entry keys of a browser on an admin address, marked as the owner's without the code - only entries held here, never
//                         over another mark, with the address recorded (kanban #1414, #1420)
import { readHealth, HEALTH_CRON } from './health.js';

const SEATS = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`)
  .concat([1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/fed2-${i}`));
const PAGE = 200, PAGE_MAX = 1000;
const ASK_MS = 6000, READ_MS = 20000;
const READ_BACK_MS = 3 * 3600000;    // a transaction's record still changes until its round settles: read again for 3 h
const hex64 = /^[0-9a-f]{64}$/;
const seatName = (url) => url.replace('https://tn4.bitcoin-arena.io/', '');

const json = (body, { status = 200, maxAge = 0 } = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' } });

async function ask(url, ms = ASK_MS) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: null, why: String(e && e.message ? e.message : e).slice(0, 120) }; }
}

// NO ONE SEAT SAYS WHAT A TRANSACTION IS (kanban #1510): its entry, locks, settlement and result are the value at least AGREE seats send
// byte for byte (and more of them than any other value), never the first seat's - one seat of fourteen could list a made-up order that
// /api/played and Umami counted as a real player's round, turn an order the others hold as lost into won, swap an entry's player key past
// the bot and owner marks, or backdate it to another day. An id fewer than AGREE seats hold the same entry of is not found and not stored.
const AGREE = 2;
function agreed(values) {
  const n = new Map();
  for (const v of values) { if (v === null || v === undefined) continue; const k = JSON.stringify(v); n.set(k, (n.get(k) || 0) + 1); }
  const top = [...n].sort((a, b) => b[1] - a[1]);
  if (!top.length || top[0][1] < AGREE || (top[1] && top[1][1] === top[0][1])) return null;
  return JSON.parse(top[0][0]);
}

/** One transaction from every seat's answer ([{ seat, status, body, why }]), merged. */
function merge(id, answers, readMs = null) {
  const held = answers.filter((a) => a.body && a.body.known);
  const entry = agreed(held.map((a) => a.body.entry));
  // the seats that hold that entry (kanban #1510): only they speak for the rest of it
  const known = entry ? held.filter((a) => JSON.stringify(a.body.entry) === JSON.stringify(entry)) : [];
  const seats = answers.map((a) => ({ seat: seatName(a.seat), key: a.body && a.body.seat ? a.body.seat : null,
    status: a.status, known: !!(a.body && a.body.known), storedAt: a.body && a.body.storedAt ? a.body.storedAt : null,
    steps: a.body && Array.isArray(a.body.steps) ? a.body.steps : [], book: a.body ? a.body.book || null : null, why: a.why || null,
    did: a.body && a.body.processed && Array.isArray(a.body.processed.mine) ? a.body.processed.mine : [],
    locks: a.body && a.body.locks ? a.body.locks : null }));
  const settlement = agreed(known.map((a) => a.body.settlement).filter((x) => x && x.txid));
  const client = known.map((a) => a.body.client).find(Boolean) || null;
  // its result (won, lost, refunded, pending): what the seats that hold the settlement agree on; else what they agree it is (pending)
  const results = known.map((a) => a.body.result).filter(Boolean);
  const result = agreed(results.filter((r) => r.state !== 'pending')) || agreed(results);
  // WHO PROCESSED ITS ROUND (2026-10-24: "Also show who processed the round, e.g for settlement and verify"): the committees, the
  // asker and the outcome's attestors as the seats name them (the first that names each), each seat key named by the seat that has it
  const proc = known.map((a) => a.body.processed).filter(Boolean);
  const pick = (k) => (proc.find((p) => p[k] && (!Array.isArray(p[k]) || p[k].length)) || {})[k] || null;
  const names = Object.fromEntries(seats.filter((x) => x.key).map((x) => [x.key, x.seat]));
  const processed = proc.length ? { game: pick('game'), settlement: pick('settlement'), asker: pick('asker'), outcomes: pick('outcomes') || [],
    settledAt: pick('settledAt'), settlementWhy: pick('settlementWhy'), names } : null;
  // stored first: the AGREE-th earliest time of the seats that hold the entry - no one seat moves it to another day (kanban #1510)
  const stored = known.map((a) => a.body.storedAt).filter(Boolean).sort();
  return { id, found: known.length > 0, readAt: new Date().toISOString(), readMs,
    entry, locks: agreed(known.map((a) => a.body.locks)), settlement, client, processed, result,
    storedFirst: stored[Math.min(AGREE, stored.length) - 1] || null, seats };
}

/** Every seat's view of one transaction, asked now - only for one the minute's read has not stored yet. */
async function readTx(id) {
  const t0 = Date.now();
  const answers = await Promise.all(SEATS.map(async (seat) => ({ seat, ...(await ask(`${seat}/tx?id=${id}`)) })));
  return merge(id, answers, Date.now() - t0);
}

async function sha(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A merged transaction's write into D1, or null when it is what D1 holds already (its hash leaves out when it was read). */
async function keep(env, tx, had) {
  const { readAt, readMs, ...stable } = tx; void readAt; void readMs;
  const h = await sha(JSON.stringify(stable));
  if (had === h) return null;
  const e = tx.entry || {};
  return env.DB.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms, kind, fed_txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET round = excluded.round, app = excluded.app, federation = excluded.federation, stored_ms = excluded.stored_ms,
    settled = excluded.settled, hash = excluded.hash, json = excluded.json, updated_ms = excluded.updated_ms, kind = excluded.kind, fed_txid = excluded.fed_txid`)
    .bind(tx.id, e.round || null, e.app || null, e.federation || null, tx.storedFirst ? Date.parse(tx.storedFirst) : Date.now(),
      tx.settlement ? tx.settlement.state : null, h, JSON.stringify(tx), Date.now(), tx.kind || 'order', tx.payment ? tx.payment.txid : null);
}

// THE GIFTS, ZAPS AND ITEMS BOUGHT (kanban #683, 2026-10-26: "I don't see item purchases in the explorer"; #682: a gift "doesn't show in
// the explorer"): each a row of its own kind beside the orders - what it paid for, from whom, its federation transaction and its outputs,
// and which seats keep it. A seat keeps every one of its network (each is handed on to all), and a kept one never changes.
const PAYMENT_KINDS = ['item', 'donation', 'zap'];
function paymentTx(id, answers) {
  const held = answers.filter((a) => a.row);
  const r = held[0].row;
  const { keptMs, ...payment } = r; void keptMs;
  const kept = held.map((a) => Number(a.row.keptMs)).filter(Number.isFinite).sort((a, b) => a - b);
  return { id, kind: PAYMENT_KINDS.includes(r.kind) ? r.kind : 'donation', found: true, readAt: new Date().toISOString(), readMs: null,
    entry: { app: r.gameName || null, federation: r.federation, player: r.kind === 'item' ? r.player : r.donor }, amountMsat: r.totalMsat, payment,
    settlement: null, client: null, processed: null, result: null, storedFirst: kept.length ? new Date(kept[0]).toISOString() : null,
    seats: answers.map((a) => ({ seat: seatName(a.seat), key: a.key || null, status: a.status, known: !!a.row,
      storedAt: a.row && Number.isFinite(Number(a.row.keptMs)) ? new Date(Number(a.row.keptMs)).toISOString() : null, why: a.why || null })) };
}

/** Every seat's gifts and items kept after `since` (at most `limit` of each), merged into D1; and where a further read goes on from. */
async function readPayments(env, since, limit) {
  const t0 = Date.now();
  const got = await Promise.all(SEATS.map(async (seat) => ({ seat, ...(await ask(`${seat}/payments?since=${since}&limit=${limit}`, READ_MS)) })));
  const byId = new Map();
  // GOES ON FROM: the earliest last row of a list a seat filled to its limit (the rest of it after that), else nothing is left
  let next = null;
  for (const g of got) {
    if (!g.body || !Array.isArray(g.body.gifts) || !Array.isArray(g.body.items)) continue;
    for (const list of [g.body.gifts, g.body.items]) {
      if (list.length >= limit) { const last = Number(list[list.length - 1].keptMs); if (Number.isFinite(last) && (next === null || last < next)) next = last; }
      for (const r of list) {
        if (!hex64.test(String(r.id)) || !hex64.test(String(r.txid))) continue;
        if (!byId.has(r.id)) byId.set(r.id, new Map());
        byId.get(r.id).set(g.seat, { row: r, key: g.body.seat || null });
      }
    }
  }
  // a seat that answered and did not list it does not keep it; a seat before GET /payments (404) or that did not answer is said so
  const answered = new Map(got.map((g) => [g.seat, !!(g.body && Array.isArray(g.body.gifts))]));
  const ids = [...byId.keys()];
  const hashes = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT id, hash FROM txs WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const x of r.results || []) hashes.set(x.id, x.hash);
  }
  const writes = [];
  for (const id of ids) {
    const per = byId.get(id);
    const answers = SEATS.map((seat) => (per.has(seat) ? { seat, status: 200, ...per.get(seat) }
      : answered.get(seat) ? { seat, status: 404 } : { seat, status: got.find((g) => g.seat === seat).status, why: 'did not list its payments' }));
    const w = await keep(env, paymentTx(id, answers), hashes.get(id));
    if (w) writes.push(w);
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
  return { seats: [...answered.values()].filter(Boolean).length, payments: ids.length, written: writes.length, next, ms: Date.now() - t0 };
}

// THE EXPLORER'S OWN STATE IN D1 (2026-10-26, Cloudflare blocked KV puts for the day: "exceeded the daily Workers KV free tier limit of
// 1,000 put operations" - the walks' positions and the kept figures were written every minute): one row per key in the table state
// (migrations/0003_state.sql); KV keeps only the Health copy
const stateGet = async (env, k) => { const r = await env.DB.prepare('SELECT v FROM state WHERE k = ?').bind(k).first(); return r ? r.v : null; };
const statePut = (env, k, v) => env.DB.prepare('INSERT INTO state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();

// THE OLDER ONES TOO: from the first a seat kept, a page each minute (KV 'payments-walk'), until a read leaves nothing over; the
// minute's own read covers the newest READ_BACK_MS from then on
async function paymentsWalk(env) {
  const at = await stateGet(env, 'payments-walk');
  if (at === 'done') return;
  const n = await readPayments(env, Number(at) || 0, BACKFILL_ROWS);
  if (!n.seats) return;   // no seat lists payments yet (before their roll): asked again next minute
  await statePut(env, 'payments-walk', n.next === null ? 'done' : String(n.next));
  console.log(JSON.stringify({ paymentsWalk: { from: Number(at) || 0, ...n } }));
}

// THE OLDER TRANSACTIONS TOO (2026-10-24: "You should do that for each tx"): besides the newest READ_BACK_MS, each minute reads one
// older window, walking back from where it stopped (KV 'backfill') until the nodes' 14 days; then it stops
const BACKFILL_UNTIL_MS = 14 * 24 * 3600000, BACKFILL_ROWS = 200;
async function backfill(env) {
  const t0 = Date.now();
  let at = Number(await stateGet(env, 'backfill')) || t0 - READ_BACK_MS;
  if (at <= t0 - BACKFILL_UNTIL_MS) return;
  const from = at - READ_BACK_MS;
  const n = await readWindow(env, from, BACKFILL_ROWS, at);
  await statePut(env, 'backfill', String(from));
  console.log(JSON.stringify({ backfill: { from: new Date(from).toISOString(), to: new Date(at).toISOString(), ...n } }));
}

// THE METRICS (kanban #676, 2026-10-25: "Explorer also shows volume in Sats / btc per day, current protocol reserve in sats / btc, and total
// referrer fees accumulated in sats / btc", "This is On a metrics page"): each minute every seat's GET /reserves and GET /referral-fees, kept in
// KV - per federation the reserve the seats agree on (the median), per website the median fee the seats indexed; the volume per day
// is read from D1's transactions when asked
// ONE SEAT DOES NOT SET THE RESERVE (kanban #1534): the largest any seat said was kept, so one seat of 14 could show 21M BTC or hide a
// drain behind an old, higher reserve, and BigInt() of one malformed amount threw for the whole read (the metrics went stale for everyone).
// Each amount is now checked (msatOf: 1-20 digits, else that seat's row is skipped) and each figure is the median of the seats that report it.
const msatOf = (v) => ((typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v))) && /^\d{1,20}$/.test(String(v)) ? BigInt(v) : null);
const median = (list) => { const s = [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s[Math.floor((s.length - 1) / 2)]; };
// ONE VALUE PER SEAT, AND THE MEDIAN OVER EVERY SEAT THAT ANSWERED (kanban #1709, #1773, #1821, #1855; #1534 did not hold): the median was taken over
// every ROW of the seats that report a key, so one seat repeating its row 14 times outvoted 13 honest seats, and a federation or site one seat
// made up had that seat's own value as its "median" and was summed into the total. byQuorum takes each seat's rows (an array per seat that
// answered), keeps the first row per key of each seat, and gives a key a value only when a strict majority of the answering seats list it;
// its value is the lower median over all answering seats, a seat that does not list the key counting 0 (with a strict majority listing it,
// that median is always one of the listed values). pick(row) -> bigint or null (null: the row is skipped).
// A MAJORITY OF ALL SEATS, NOT OF THOSE THAT ANSWERED (kanban #1993, #2007, #2040, #2059; #1534 did not hold): a key needs more than half of `of`
// (every seat asked, SEATS.length) listing it - with 13 seats timed out the one fast seat was the whole quorum and replaced the kept figures.
function byQuorum(perSeat, keyOf, pick, of = SEATS.length) {
  const rows = new Map();   // key -> [{ v, row }] one per seat
  for (const list of perSeat) {
    const seen = new Set();
    for (const row of list) {
      const k = keyOf(row); if (typeof k !== 'string' || seen.has(k)) continue;
      const v = pick(row); if (v === null) continue;
      seen.add(k);
      if (!rows.has(k)) rows.set(k, []); rows.get(k).push({ v, row });
    }
  }
  const n = perSeat.length, out = new Map();
  for (const [k, list] of rows) {
    if (2 * list.length <= Math.max(n, of)) continue;
    const mid = median([...list.map((r) => r.v), ...Array(n - list.length).fill(0n)]);
    out.set(k, list.find((r) => r.v === mid) || { v: mid, row: null });
  }
  return out;
}
// (kanban #1993, #2007, #2040, #2059) a part of the figures - the reserve, the referral fees - is replaced only when more than half of ALL seats
// answered it; with fewer the kept part stays (and the read says so in the log). A program (a site's name, kanban #675) is an object with a
// string site, a string name and a finite atMs, else it is skipped (one seat's programs: [null] threw for the whole read); its name is the
// (site, name) a majority of all seats list, one per site per seat - never "the newest any seat holds" by that seat's own atMs - and a site
// gets a zero-fee row only from such a name.
const programOf = (p) => (p && typeof p === 'object' && typeof p.site === 'string' && typeof p.name === 'string' && Number.isFinite(Number(p.atMs)) ? p : null);
async function readMetrics(env) {
  const [res, ref] = await Promise.all([
    Promise.all(SEATS.map((seat) => ask(`${seat}/reserves`, READ_MS))),
    Promise.all(SEATS.map((seat) => ask(`${seat}/referral-fees`, READ_MS)))]);
  const kept = JSON.parse((await stateGet(env, 'metrics')) || 'null');
  const quorum = (n) => 2 * n > SEATS.length;
  const feds = new Map(), sites = new Map();
  const resSeats = res.filter((a) => a.body && Array.isArray(a.body.federations)).map((a) => a.body.federations);
  for (const [id, x] of byQuorum(resSeats, (f) => (f ? f.federationId : null), (f) => msatOf(f.heldMsat))) feds.set(id, x.v);
  const refAnswered = ref.filter((a) => a.body && Array.isArray(a.body.sites));
  const progSeats = refAnswered.map((a) => {
    const one = new Map();
    for (const p of (Array.isArray(a.body.programs) ? a.body.programs : [])) { const q = programOf(p); if (q && !one.has(q.site)) one.set(q.site, q); }
    return [...one.values()];
  });
  const names = new Map();
  for (const [, x] of byQuorum(progSeats, (p) => JSON.stringify([p.site, p.name]), () => 1n)) names.set(x.row.site, x.row.name);
  const refSeats = refAnswered.map((a) => a.body.sites);
  for (const [site, x] of byQuorum(refSeats, (r) => (r ? r.site : null), (r) => msatOf(r.msat))) {
    sites.set(site, { msat: x.v, payouts: x.row && Number.isSafeInteger(x.row.payouts) ? x.row.payouts : 0 });
  }
  for (const [site] of names) if (!sites.has(site)) sites.set(site, { msat: 0n, payouts: 0 });
  const sum = (it) => [...it].reduce((t, m) => t + m, 0n);
  const resOk = quorum(resSeats.length), refOk = quorum(refSeats.length);
  if (!resOk || !refOk) console.log(JSON.stringify({ metricsShort: { reserves: resSeats.length, referral: refSeats.length, of: SEATS.length, kept: !!kept } }));
  if (!resOk && !refOk) return kept;
  const reserve = resOk ? { msat: String(sum(feds.values())), federations: [...feds].map(([federation, msat]) => ({ federation, msat: String(msat) })) }
    : kept ? kept.reserve : null;
  const referral = refOk ? { msat: String(sum([...sites.values()].map((x) => x.msat))), sites: [...sites].map(([site, x]) => ({ site, name: names.has(site) ? names.get(site) : null, msat: String(x.msat), payouts: x.payouts }))
    .sort((a, b) => (BigInt(b.msat) > BigInt(a.msat) ? 1 : BigInt(b.msat) < BigInt(a.msat) ? -1 : 0)) } : kept ? kept.referral : null;
  const m = { readAt: new Date().toISOString(), seats: { reserves: resSeats.length, referral: refSeats.length, of: SEATS.length }, reserve, referral };
  await statePut(env, 'metrics', JSON.stringify(m));
  return m;
}

const DAY_MS = 86400000, VOLUME_DAYS = 30;
// THE RESERVE OVER TIME (kanban #1095, the owner 2026-11-03: "Gespielte Runden auf Explorer auch grafisch darstellen, auch Volume, und Reserven"):
// every payment into a federation's reserve carries its time (GET /reserves?all=1, paidIn[].at), so the history is rebuilt from the start, not
// only recorded from now. Read once an hour from three seats; per federation and UTC day the median of what the seats say came in that day
// (kanban #1534: not the longest list, which one seat could pad; an amount that does not parse skips that payment, never the read); the
// reserve held at each day's end, summed over the federations. Payouts out of the reserve (none yet) are taken off on their day.
const HISTORY_SEATS = [0, 1, 7];
// (kanban #1993, #2007, #2040, #2059) THREE ANSWERS OR THE KEPT HISTORY: with one history seat slow the lower median of the other two was the
// smaller one (one seat set every day to 0), with two slow the third alone was the history. A history seat that does not answer is replaced by
// the next seat (at most HISTORY_ROUNDS rounds of asking); fewer than HISTORY_SEATS.length answers leave the kept history. A payment's time
// counts only from HISTORY_FROM_MS to now, and a day enters the history only when its median is above 0: one seat naming a payment in 1900
// (or year -271821, ~1e8 days) no longer starts the history there.
const HISTORY_ROUNDS = 3, HISTORY_FROM_MS = Date.UTC(2026, 7, 1);
async function readReserveHistory(env) {
  const want = HISTORY_SEATS.length;
  const order = [...HISTORY_SEATS, ...SEATS.map((_, i) => i).filter((i) => !HISTORY_SEATS.includes(i))];
  const answers = [];
  for (let round = 0, next = 0; round < HISTORY_ROUNDS && answers.length < want && next < order.length; round++) {
    const ask1 = order.slice(next, next + want - answers.length); next += ask1.length;
    const got = await Promise.all(ask1.map((i) => ask(`${SEATS[i]}/reserves?all=1`, 45000)));
    answers.push(...got.filter((a) => a.body && Array.isArray(a.body.federations)));
  }
  if (answers.length < want) {
    console.log(JSON.stringify({ reserveHistoryShort: { answered: answers.length, of: want } }));
    return JSON.parse((await stateGet(env, 'reserve-history')) || 'null');
  }
  // (kanban #1709, #1773, #1821, #1855): a federation counts only when a strict majority of the history seats that answered list it, and each
  // day's median is over all of them - a seat that does not list the federation (or has nothing that day) counts 0
  const answered = answers.filter((a) => a.body && Array.isArray(a.body.federations));
  const best = new Map();   // federation -> one per-day map per seat that reports it
  for (const a of answered) {
    const seen = new Set();
    for (const f of a.body.federations) {
      if (!f || typeof f.federationId !== 'string' || seen.has(f.federationId)) continue; seen.add(f.federationId);
      const day = new Map();
      for (const x of (Array.isArray(f.paidIn) ? f.paidIn : [])) {
        const t = x ? Date.parse(x.at) : NaN, m = x ? msatOf(x.amountMsat) : null;
        if (!Number.isFinite(t) || t < HISTORY_FROM_MS || t > Date.now() || m === null) continue;
        const d = new Date(Math.floor(t / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
        day.set(d, (day.get(d) || 0n) + m);
      }
      if (!best.has(f.federationId)) best.set(f.federationId, []); best.get(f.federationId).push(day);
    }
  }
  const kept = [...best.values()].filter((views) => 2 * views.length > answered.length);
  if (!kept.length) return null;
  const perDay = new Map();
  for (const views of kept) {
    const all = [...views, ...Array(answered.length - views.length).fill(new Map())];
    for (const d of new Set(views.flatMap((v) => [...v.keys()]))) {
      const mid = median(all.map((v) => v.get(d) || 0n));
      if (mid > 0n) perDay.set(d, (perDay.get(d) || 0n) + mid);
    }
  }
  const days = [...perDay.keys()].sort();
  const out = []; let held = 0n;
  if (days.length) for (let t = Date.parse(days[0]); t <= Date.now(); t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    const came = perDay.get(d) || 0n; held += came;
    out.push({ day: d, inMsat: String(came), heldMsat: String(held) });
  }
  const h = { readAt: new Date().toISOString(), federations: kept.length, days: out };
  await statePut(env, 'reserve-history', JSON.stringify(h));
  return h;
}
async function metrics(env) {
  const kept = JSON.parse((await stateGet(env, 'metrics')) || 'null');
  const since = Math.floor(Date.now() / DAY_MS) * DAY_MS - (VOLUME_DAYS - 1) * DAY_MS;
  // the stakes of the orders (kanban #683: the gifts and items bought are rows too, not stakes)
  // THE STAKE IS READ BEFORE THE GROUPING (kanban #1459, the owner 2026-11-11: "metrics is offline" - D1_ERROR: out of memory: SQLITE_NOMEM): grouped
  // directly, SQLite sorted each order's whole json (14.5 KB on average, 238 MB in all) by its day; now only the day and the stake are sorted
  const r = await env.DB.prepare(`WITH x AS MATERIALIZED (SELECT stored_ms / ${DAY_MS} AS d, CAST(json_extract(json, '$.entry.stakeMsat') AS INTEGER) AS s
    FROM txs WHERE stored_ms >= ? AND kind = 'order') SELECT d, COUNT(*) AS n, SUM(s) AS msat FROM x GROUP BY d ORDER BY d DESC`).bind(since).all();
  const volume = (r.results || []).map((x) => ({ day: new Date(Number(x.d) * DAY_MS).toISOString().slice(0, 10), txs: Number(x.n), msat: String(x.msat || 0) }));
  const history = JSON.parse((await stateGet(env, 'reserve-history')) || 'null');
  return { volume, reserve: kept ? kept.reserve : null, referral: kept ? kept.referral : null, readAt: kept ? kept.readAt : null, seats: kept ? kept.seats : null,
    reserveHistory: history };
}

// PLAYED ROUNDS (kanban #1090, the owner 2026-11-03: "Played rounds mit Tages / Wochen / Monats Anzeige", "Auch rueckwirkend seit 1.11",
// "Wieviel Runden insgesamt und pro Spiel, tu da meine Runden RAUS NEHMEN", "nicht CH pauschal ausblenden"): every paid entry the explorer
// keeps (txs, kind order) since 2026-11-01, by its round. An entry is the OWNER's or a BOT's when its key was marked (POST /api/mark, with the
// admin code the page's flag holds, kanban #1092); every other entry is a real player's - no country, no guess. A round is a real players'
// round when at least one of its entries is. Counted per UTC day, ISO week (from Monday) and month, per game.
const ADMIN_SHA256 = '18fcacfac3164c5a5dc71e71d053c9061fea37403e63056eb9d11e602ab1bc79';
const PLAYED_FROM_MS = Date.UTC(2026, 10, 1);
const sha256Hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))))].map((b) => b.toString(16).padStart(2, '0')).join('');
// ADMIN BY ADDRESS (kanban #1414): an address that sent the admin code within ADMIN_IP_DAYS is the admin's - a private window or a fresh browser there
// is flagged too, and its entries are marked without the code. An IPv6 address counts by its /64 (its first four groups, written out).
// AN ADDRESS IS THE ADMIN'S FOR 48 HOURS AFTER ITS LAST CODE MARK (audit 6, kanban #1420; was 90 days): a shared address - a carrier's CGNAT, a hotel's
// Wi-Fi - did not stay flagged for months; the admin's own browser, which marks with the code each minute it plays, keeps it fresh
const ADMIN_IP_HOURS = 48;
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s); if (v4) return v4[1];
  if (!s.includes(':') || s.split('::').length > 2) return s;
  const [head, tail = null] = s.split('::'); const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = tail === null ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}
const callerIp = (request) => ipKey(request.headers.get('cf-connecting-ip'));
async function adminIp(env, request) {
  const ip = callerIp(request); if (!ip) return false;
  const r = await env.DB.prepare('SELECT at_ms FROM admin_ips WHERE ip = ?').bind(ip).first().catch(() => null);
  return !!(r && Date.now() - Number(r.at_ms) < ADMIN_IP_HOURS * 3600000);
}
async function putMarks(env, keys, kind) {
  const at = Date.now();
  for (let i = 0; i < keys.length; i += 50)
    // a mark with the code or a bot's clears an earlier address's by_ip (audit 6 re-check N6, kanban #1426): undoing marks by address never takes it
    await env.DB.batch(keys.slice(i, i + 50).map((k) => env.DB.prepare('INSERT INTO marked (key, kind, at_ms) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, at_ms = excluded.at_ms, by_ip = NULL').bind(k, kind, at)));
}
const keysOf = (b) => [...new Set((Array.isArray(b && b.keys) ? b.keys : []).map((k) => String(k).toLowerCase()).filter((k) => hex64.test(k)))].slice(0, 500);
// POST /api/mark-ip { keys }: the entries of a browser on an admin address, marked as the owner's - no code; any other address is refused.
// ONLY ENTRIES THIS EXPLORER HOLDS, NEVER OVER ANOTHER MARK, AND SAYING WHO (audit 6, kanban #1420): any key was taken and a code or bot mark was
// overwritten, with no record of the address - now a key must be an entry id in txs, a key already marked keeps its mark, and the row names the
// address (by_ip) so it can be found and undone. Answers the keys it took: the page counts only those as sent
// A TEST BROWSER CLOSES BEFORE ITS ENTRY IS HERE (kanban #1466, Daniel 2026-11-11: "Sind die Runden vom 11.11 heute von 22 echten spielern? Prüfe das" - all 22 were
// playtest scripts on the admin's address: each placed an order and closed its browser within the minute, before the explorer's next read held the entry,
// so every mark was refused and never asked again - "fix it in code so it won't happen again"): an entry id from an admin address that is not held yet is
// kept in mark_pending and marked when the entry arrives (applyPendingMarks, each poll), for PENDING_MARK_MS. Still only from an admin address, never over
// another mark, by_ip kept. A browser under automation (navigator.webdriver) sends kind 'bot'; every other admin browser 'owner'.
const PENDING_MARK_MS = 2 * DAY_MS;
const pendingTable = (env) => env.DB.prepare('CREATE TABLE IF NOT EXISTS mark_pending (key TEXT PRIMARY KEY, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, by_ip TEXT)').run();
export async function applyPendingMarks(env, now = Date.now()) {
  await pendingTable(env);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO marked (key, kind, at_ms, by_ip) SELECT p.key, p.kind, p.at_ms, p.by_ip FROM mark_pending p WHERE p.key IN (SELECT id FROM txs) ON CONFLICT(key) DO NOTHING'),
    env.DB.prepare('DELETE FROM mark_pending WHERE key IN (SELECT id FROM txs) OR at_ms < ?').bind(now - PENDING_MARK_MS),
  ]);
}
async function markByIp(env, request) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, why: 'a mark is JSON: { keys }' }, { status: 400 }); }
  if (!(await adminIp(env, request))) return json({ ok: false, why: 'this address is not the admin\'s' }, { status: 403 });
  const kind = b && b.kind === 'bot' ? 'bot' : 'owner';
  const ip = callerIp(request), asked = keysOf(b), at = Date.now(), took = [];
  for (let i = 0; i < asked.length; i += 50) {
    const part = asked.slice(i, i + 50);
    const held = await env.DB.prepare(`SELECT id FROM txs WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all().then((r) => new Set((r.results || []).map((x) => x.id))).catch(() => new Set());
    const fresh = part.filter((k) => held.has(k)), later = part.filter((k) => !held.has(k));
    if (fresh.length) await env.DB.batch(fresh.map((k) => env.DB.prepare('INSERT INTO marked (key, kind, at_ms, by_ip) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(k, kind, at, ip)));
    if (later.length) { await pendingTable(env); await env.DB.batch(later.map((k) => env.DB.prepare('INSERT INTO mark_pending (key, kind, at_ms, by_ip) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(k, kind, at, ip))); }
    took.push(...fresh, ...later);   // marked now, or kept until the entry is here: the page need not send them again
  }
  return json({ ok: true, marked: took.length, took, kind, by: 'address' });
}
async function mark(env, request) {
  let b; try { b = await request.json(); } catch { return json({ ok: false, why: 'a mark is JSON: { keys, kind, code }' }, { status: 400 }); }
  if (!b || typeof b.code !== 'string' || await sha256Hex(b.code.trim()) !== (env.ADMIN_SHA256 || ADMIN_SHA256)) return json({ ok: false, why: 'not the admin code' }, { status: 403 });
  if (!['owner', 'bot'].includes(b.kind)) return json({ ok: false, why: 'kind is owner or bot' }, { status: 400 });
  // entry ids (transaction ids) or player keys, 64 hex each
  const keys = keysOf(b);
  await putMarks(env, keys, b.kind);
  // the owner's address is kept (kanban #1414): a fresh browser there is the admin's too. A bot's runner is not an admin address
  if (b.kind === 'owner') { const ip = callerIp(request); if (ip) await env.DB.prepare('INSERT INTO admin_ips (ip, at_ms) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET at_ms = excluded.at_ms').bind(ip, Date.now()).run().catch(() => null); }
  return json({ ok: true, marked: keys.length, kind: b.kind });
}
const weekOf = (ms) => { const d = new Date(Math.floor(ms / DAY_MS) * DAY_MS); const back = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10); };
// THE PLAYED ROUNDS, TOLD TO UMAMI (kanban #1110, the owner 2026-11-03: "die events in umami muessen mit unseren gespielten runden im explorer
// übereinstimmen, admin und bot runden ausgenommen"): the page's own events miss what an ad blocker stops or what is not played on the page, and
// they came from admin play too. So the explorer sends them itself, from the same rows /api/played counts, with the same rule: an order is
// real when neither its entry id nor its player key is marked. Each real entry once ('played-entry'), each round with a real entry once
// ('played-round'), at the time it was played (a round at its first order's time, as /api/played dates it), from 2026-11-01. An order is
// told only an hour after it was stored, so the bots' marking (every 10 min) and the owner's have come first. UMAMI_SEND=off stops it.
const UMAMI_SEND_URL = 'https://stats.bitcoinarena.io/api/send', UMAMI_SITE = '024ff09e-c3a6-4dfd-bede-3163eb8be36a', UMAMI_HOST = 'testnet.bitcoinarena.io';
const UMAMI_DELAY_MS = 3600000, UMAMI_PER_RUN = 25;
async function sendPlayed(env, now = Date.now(), post = fetch) {
  if (env.UMAMI_SEND === 'off') return { sent: 0, off: true };
  const rows = ((await env.DB.prepare(`SELECT t.id, t.round, t.app, t.stored_ms AS ms,
      (SELECT MIN(o.stored_ms) FROM txs o WHERE o.round = t.round AND COALESCE(o.kind, 'order') = 'order') AS round_ms,
      EXISTS (SELECT 1 FROM umami_sent u WHERE u.key = 'r:' || t.round) AS round_sent
    FROM txs t WHERE COALESCE(t.kind, 'order') = 'order' AND t.round IS NOT NULL AND t.stored_ms >= ? AND t.stored_ms < ?
      AND NOT EXISTS (SELECT 1 FROM marked m WHERE m.key = t.id OR m.key = lower(json_extract(t.json, '$.entry.player')))
      AND NOT EXISTS (SELECT 1 FROM umami_sent u WHERE u.key = 'e:' || t.id)
    ORDER BY t.stored_ms LIMIT ?`).bind(PLAYED_FROM_MS, now - UMAMI_DELAY_MS, UMAMI_PER_RUN).all()).results) || [];
  let sent = 0; const roundsNow = new Set();
  const tell = async (name, game, ms) => {
    const r = await post(env.UMAMI_SEND_URL || UMAMI_SEND_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; arena-explorer)' },
      body: JSON.stringify({ type: 'event', payload: { website: env.UMAMI_SITE || UMAMI_SITE, hostname: UMAMI_HOST, url: '/played/' + game, name, data: { game }, timestamp: Math.floor(Number(ms) / 1000) } }) });
    if (!r.ok) throw new Error(`umami ${r.status}`);
    sent++;
  };
  // EACH ONE CLAIMED BEFORE IT IS SENT (measured 2026-11-03: a run of 60 took longer than the minute, the next run read the same rows and
  // 11-02 got 15 rounds twice): the row is written first, and a run that finds it written skips it; a send that fails takes it back
  const claim = async (key) => { const r = (await env.DB.prepare('INSERT INTO umami_sent (key, at_ms) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(key, now).run()) || {};
    return Number(r.meta ? r.meta.changes : r.changes) > 0; };
  const unclaim = (key) => env.DB.prepare('DELETE FROM umami_sent WHERE key = ?').bind(key).run();
  for (const x of rows) {
    const game = x.app || 'unknown';
    if (!Number(x.round_sent) && !roundsNow.has(x.round) && await claim('r:' + x.round)) {
      roundsNow.add(x.round);
      try { await tell('played-round', game, x.round_ms ?? x.ms); } catch (e) { await unclaim('r:' + x.round); return { sent, why: e.message }; }
    }
    if (!(await claim('e:' + x.id))) continue;
    try { await tell('played-entry', game, x.ms); } catch (e) { await unclaim('e:' + x.id); return { sent, why: e.message }; }
  }
  return { sent, rows: rows.length };
}

/** EVERY ROUND SINCE THE FIRST ONE HELD HERE, PER GAME (kanban #1197, the homepage's numbers): rounds, settled rounds and entries - nothing that shrinks when nobody plays. */
async function totals(env) {
  const r = await env.DB.prepare(`SELECT app, COUNT(DISTINCT round) AS rounds, COUNT(DISTINCT CASE WHEN settled = 'ACCEPTED' THEN round END) AS settled, COUNT(*) AS entries,
    MIN(stored_ms) AS first FROM txs WHERE kind = 'order' AND round IS NOT NULL GROUP BY app`).all();
  const games = {}; let first = null;
  for (const x of r.results || []) {
    games[x.app || 'unknown'] = { rounds: Number(x.rounds), settled: Number(x.settled), entries: Number(x.entries) };
    if (x.first !== null && (first === null || Number(x.first) < first)) first = Number(x.first);
  }
  const all = Object.values(games).reduce((t, g) => ({ rounds: t.rounds + g.rounds, settled: t.settled + g.settled, entries: t.entries + g.entries }), { rounds: 0, settled: 0, entries: 0 });
  return { since: first === null ? null : new Date(first).toISOString(), readAt: new Date().toISOString(), all, games };
}

async function played(env) {
  const [rows, marks] = await Promise.all([
    env.DB.prepare(`SELECT id, round, app, stored_ms AS ms, settled, json_extract(json, '$.entry.player') AS p FROM txs WHERE kind = 'order' AND stored_ms >= ? AND round IS NOT NULL`).bind(PLAYED_FROM_MS).all(),
    env.DB.prepare('SELECT key, kind FROM marked').all()]);
  const kindOf = new Map((marks.results || []).map((m) => [m.key, m.kind]));
  // each round once: its game, its first entry's time, its entries' kinds, whether it settled
  const rounds = new Map();
  for (const r of rows.results || []) {
    // marked by its entry id (a transaction's id: what our bots keep of each order) or by its player key
    const k = String(r.p || '').toLowerCase(), who = kindOf.get(String(r.id)) || kindOf.get(k) || 'real';
    const x = rounds.get(r.round) || { app: r.app || 'unknown', ms: Number(r.ms), settled: false, entries: { real: 0, owner: 0, bot: 0 }, players: new Set() };
    x.ms = Math.min(x.ms, Number(r.ms)); x.entries[who] += 1; if (who === 'real') x.players.add(k);
    if (r.settled === 'ACCEPTED') x.settled = true;
    rounds.set(r.round, x);
  }
  const out = { day: new Map(), week: new Map(), month: new Map() };
  const add = (map, period, x) => {
    const row = map.get(period) || { period, all: { rounds: 0, real: 0, settled: 0, entries: 0, realEntries: 0, owner: 0, bot: 0, players: new Set() }, games: new Map() };
    for (const t of [row.all, row.games.get(x.app) || (row.games.set(x.app, { rounds: 0, real: 0, settled: 0, entries: 0, realEntries: 0, owner: 0, bot: 0, players: new Set() }), row.games.get(x.app))]) {
      t.rounds += 1; if (x.entries.real) t.real += 1; if (x.settled) t.settled += 1;
      t.entries += x.entries.real + x.entries.owner + x.entries.bot; t.realEntries += x.entries.real; t.owner += x.entries.owner; t.bot += x.entries.bot;
      for (const p of x.players) t.players.add(p);
    }
    map.set(period, row);
  };
  for (const x of rounds.values()) {
    add(out.day, new Date(x.ms).toISOString().slice(0, 10), x);
    add(out.week, weekOf(x.ms), x);
    add(out.month, new Date(x.ms).toISOString().slice(0, 7), x);
  }
  const flat = (t) => ({ rounds: t.rounds, real: t.real, settled: t.settled, entries: t.entries, realEntries: t.realEntries, owner: t.owner, bot: t.bot, realPlayers: t.players.size });
  const list = (map) => [...map.values()].sort((a, b) => (a.period < b.period ? 1 : -1))
    .map((r) => ({ period: r.period, all: flat(r.all), games: Object.fromEntries([...r.games].map(([g, t]) => [g, flat(t)])) }));
  const marked = { owner: 0, bot: 0 }; for (const k of kindOf.values()) marked[k] = (marked[k] || 0) + 1;
  return { from: new Date(PLAYED_FROM_MS).toISOString().slice(0, 10), readAt: new Date().toISOString(), marked, day: list(out.day), week: list(out.week), month: list(out.month) };
}

async function poll(env) {
  const n = await readWindow(env, Date.now() - READ_BACK_MS, 500, null);
  const pay = await readPayments(env, Date.now() - READ_BACK_MS, 500).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  console.log(JSON.stringify({ poll: n, payments: pay }));
  await paymentsWalk(env).catch((e) => console.log(JSON.stringify({ paymentsWalkError: String(e && e.message ? e.message : e) })));
  // every quarter hour: each app's, kind's and federation's count for the list's filters (a read of every row)
  if (Math.floor(Date.now() / 60000) % 15 === 0 || !(await stateGet(env, 'facets')))
    await readFacets(env).catch((e) => console.log(JSON.stringify({ facetsError: String(e && e.message ? e.message : e) })));
  // every fifth minute: the figures change slowly, and each read asks every seat twice
  if (Math.floor(Date.now() / 60000) % 5 === 0 || !(await stateGet(env, 'metrics')))
    await readMetrics(env).catch((e) => console.log(JSON.stringify({ metricsError: String(e && e.message ? e.message : e) })));
  // every hour: the reserve's history (kanban #1095), three seats' whole lists of payments in
  if (Math.floor(Date.now() / 60000) % 60 === 7 || !(await stateGet(env, 'reserve-history')))
    await readReserveHistory(env).catch((e) => console.log(JSON.stringify({ reserveHistoryError: String(e && e.message ? e.message : e) })));
  await backfill(env).catch((e) => console.log(JSON.stringify({ backfillError: String(e && e.message ? e.message : e) })));
}

/** Every seat's transactions stored from `since` (at most `limit` each, those before `before` when it is given), merged into D1. */
async function readWindow(env, since, limit, before) {
  const t0 = Date.now();
  const got = await Promise.all(SEATS.map(async (seat) => ({ seat, ...(await ask(`${seat}/txs?since=${since}&limit=${limit}&full=1`, READ_MS)) })));
  const byId = new Map();
  for (const g of got) {
    if (!g.body || !Array.isArray(g.body.txs)) continue;
    for (const t of g.body.txs) {
      if (!hex64.test(String(t.id)) || !t.detail || (before && Number(t.storedMs) >= before)) continue;
      if (!byId.has(t.id)) byId.set(t.id, new Map());
      byId.get(t.id).set(g.seat, { status: 200, body: t.detail });
    }
  }
  // a seat that answered the read and did not list a transaction does not hold it; one that did not answer is said so
  const answered = new Map(got.map((g) => [g.seat, !!(g.body && Array.isArray(g.body.txs))]));
  const ids = [...byId.keys()];
  const hashes = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT id, hash FROM txs WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const x of r.results || []) hashes.set(x.id, x.hash);
  }
  const writes = [];
  for (const id of ids) {
    const per = byId.get(id);
    const answers = SEATS.map((seat) => (per.has(seat) ? { seat, ...per.get(seat) }
      : answered.get(seat) ? { seat, status: 404, body: { known: false } } : { seat, status: 0, body: null, why: 'did not answer the read' }));
    const tx = merge(id, answers, null);
    if (!tx.found) continue;   // fewer than AGREE seats hold its entry: not stored, so not counted (kanban #1510)
    const w = await keep(env, tx, hashes.get(id));
    if (w) writes.push(w);
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
  await applyPendingMarks(env).catch((e) => console.log(JSON.stringify({ pendingMarksError: String(e && e.message ? e.message : e) })));
  return { seats: [...answered.values()].filter(Boolean).length, txs: ids.length, written: writes.length, ms: Date.now() - t0 };
}

// THE LIST'S FILTERS (kanban #683, 2026-10-26: "I don't see other apps in the explorer"): the apps, kinds and federations over every row D1
// holds, not over the newest 1000 - kept in KV, read again each quarter hour
async function readFacets(env) {
  const r = await env.DB.prepare('SELECT kind, app, federation, COUNT(*) AS n FROM txs GROUP BY kind, app, federation').all();
  const sum = (key) => { const m = new Map(); for (const x of r.results || []) { const k = x[key] === null ? '-' : x[key]; m.set(k, (m.get(k) || 0) + Number(x.n)); }
    return [...m].map(([v, n]) => ({ [key]: v, n })).sort((a, b) => b.n - a.n); };
  const f = { apps: sum('app'), kinds: sum('kind'), feds: sum('federation').filter((x) => x.federation !== '-'), total: (r.results || []).reduce((t, x) => t + Number(x.n), 0), readAt: new Date().toISOString() };
  await statePut(env, 'facets', JSON.stringify(f));
  return f;
}
async function facets(env) { return JSON.parse((await stateGet(env, 'facets')) || 'null') || readFacets(env); }

// A ROW'S CURSOR: its time and id, "<ms>_<id>" - a page goes on before or after it (kanban #683: "Add paging to the explorer to display more
// than a 1000")
const cursorOf = (x) => `${Number(x.stored_ms)}_${x.id}`;
const cursorIn = (c) => { const m = /^(\d{1,16})_([0-9a-f]{64})$/.exec(String(c || '')); return m ? { ms: Number(m[1]), id: m[2] } : null; };
/** The filters a page is asked with, as SQL: app (- for none), kind, fed, since (seconds back), q (hex: part of an id, round or federation transaction). */
function filterSql(q, now = Date.now()) {
  const where = [], binds = [];
  const app = String(q.get('app') || '');
  if (app === '-') where.push('app IS NULL'); else if (app) { where.push('app = ?'); binds.push(app.slice(0, 80)); }
  const kind = String(q.get('kind') || '');
  if (kind) { where.push('kind = ?'); binds.push(kind.slice(0, 20)); }
  const fed = String(q.get('fed') || '').toLowerCase();
  if (hex64.test(fed)) { where.push('federation = ?'); binds.push(fed); }
  const since = Number(q.get('since'));
  if (Number.isFinite(since) && since > 0) { where.push('stored_ms >= ?'); binds.push(now - since * 1000); }
  const part = String(q.get('q') || '').toLowerCase();
  // instr, not LIKE: D1 refuses a LIKE pattern over 50 bytes, so a whole 64-hex id ("%" + 64 + "%") answered 500 (kanban #1107, 2026-11-03)
  if (/^[0-9a-f]{1,64}$/.test(part)) { where.push('(instr(id, ?) > 0 OR instr(round, ?) > 0 OR instr(fed_txid, ?) > 0)'); binds.push(part, part, part); }
  // OUR BOTS' AND THE OWNER'S TRANSACTIONS LEFT OUT (kanban #1107, the owner 2026-11-03: "bot Transaktionen und admin tx standardmäßig ausblenden, es
  // gibt ein flag um es einzublenden"): an order whose entry id or player key is marked (POST /api/mark), and every other transaction of a round
  // whose orders are all marked; ?marked=1 shows them
  if (q.get('marked') !== '1') {
    const markedOrder = (t) => `EXISTS (SELECT 1 FROM marked m WHERE m.key = ${t}.id OR m.key = lower(json_extract(${t}.json, '$.entry.player')))`;
    where.push(`NOT ${markedOrder('txs')}`);
    where.push(`NOT (txs.round IS NOT NULL AND COALESCE(txs.kind, 'order') != 'order'
      AND EXISTS (SELECT 1 FROM txs o WHERE o.round = txs.round AND COALESCE(o.kind, 'order') = 'order')
      AND NOT EXISTS (SELECT 1 FROM txs o WHERE o.round = txs.round AND COALESCE(o.kind, 'order') = 'order' AND NOT ${markedOrder('o')}))`);
  }
  return { where, binds };
}
const ROW_SQL = `SELECT id, round, app, federation, stored_ms, kind, json_extract(json, '$.entry.stakeMsat') AS stake, json_extract(json, '$.amountMsat') AS amount,
  json_extract(json, '$.payment.item') AS item, json_extract(json, '$.result.state') AS rstate, json_extract(json, '$.result.netMsat') AS rnet,
  json_extract(json, '$.result.payoutMsat') AS rpaid FROM txs`;
const rowOut = (x) => ({ id: x.id, kind: x.kind || 'order', round: x.round, app: x.app, federation: x.federation, storedMs: Number(x.stored_ms),
  // with its amount (2026-10-24: "Also add the amount to the list page in sats"): an order's stake, msat; a gift's or purchase's total
  stakeMsat: x.stake !== null && x.stake !== undefined ? String(x.stake) : x.amount !== null && x.amount !== undefined ? String(x.amount) : null, item: x.item || null,
  result: x.rstate ? { state: x.rstate, netMsat: x.rnet === null ? null : String(x.rnet), payoutMsat: x.rpaid === null ? null : String(x.rpaid) } : null });

/** One page of the list, newest first: { txs, older, newer, total, facets } - older/newer the cursors of the pages beside it, or null. */
async function recent(env, q = new URLSearchParams()) {
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(q.get('limit')) || PAGE));
  const { where, binds } = filterSql(q);
  const before = cursorIn(q.get('before')), after = before ? null : cursorIn(q.get('after'));
  const at = before || after;
  const w = at ? [...where, after ? '(stored_ms > ? OR (stored_ms = ? AND id > ?))' : '(stored_ms < ? OR (stored_ms = ? AND id < ?))'] : where;
  const sql = `${ROW_SQL}${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY stored_ms ${after ? 'ASC' : 'DESC'}, id ${after ? 'ASC' : 'DESC'} LIMIT ?`;
  const got = ((await env.DB.prepare(sql).bind(...binds, ...(at ? [at.ms, at.ms, at.id] : []), limit + 1).all()).results) || [];
  const more = got.length > limit;
  let rows = got.slice(0, limit);
  // NEWER THAN A ROW, UP TO THE NEWEST: read upwards and turned round; at the top, the first page itself (a full page, no cursor)
  if (after && !more) return recent(env, new URLSearchParams([...q].filter(([k]) => k !== 'after')));
  if (after) rows = rows.reverse();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM txs${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).bind(...binds).first();
  return { txs: rows.map(rowOut), older: rows.length && (after || more) ? cursorOf(rows[rows.length - 1]) : null,
    newer: rows.length && (after || before) ? cursorOf(rows[0]) : null, total: count ? Number(count.n) : null, limit, facets: await facets(env) };
}

async function txOf(env, ctx, id) {
  // by its id, or a gift's or purchase's by its federation transaction - what the wallet history names (kanban #682)
  const row = await env.DB.prepare('SELECT json FROM txs WHERE id = ? OR fed_txid = ? LIMIT 1').bind(id, id).first();
  if (row) return { ...JSON.parse(row.json), cached: true };
  const tx = await readTx(id);
  if (tx.found) { const w = await keep(env, tx, null); if (w) ctx.waitUntil(w.run()); }
  return tx;
}

// what D1 holds, built into the page (no "Loading …"): a <script> before the page's own, its JSON safe inside HTML
async function inline(env, request, data) {
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  const html = (await page.text()).replace('</head>', `<script>window.EXPLORER_DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};</script>\n</head>`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
export { sendPlayed };
export default {
  // the health copy on its own trigger (kanban #686): its own run, so its fetches do not count against the transactions' read
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === HEALTH_CRON ? readHealth(env).catch((e) => console.log(JSON.stringify({ healthError: String(e && e.message ? e.message : e) })))
      : Promise.all([poll(env), sendPlayed(env).then((r) => { if (r.sent || r.why) console.log(JSON.stringify({ umami: r })); }).catch((e) => console.log(JSON.stringify({ umamiError: String(e && e.message ? e.message : e) })))]));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
  { const went = moved(url); if (went) return went; }
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/api/recent') return json(await recent(env, url.searchParams), { maxAge: 10 });
    if (url.pathname === '/api/metrics') return json(await metrics(env), { maxAge: 30 });
    if (url.pathname === '/api/played') return json(await played(env), { maxAge: 60 });
    if (url.pathname === '/api/totals') return json(await totals(env), { maxAge: 300 });
    if (url.pathname === '/api/mark' && request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
    if (url.pathname === '/api/mark' && request.method === 'POST') return mark(env, request);
    if (url.pathname === '/api/mark-ip' && request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
    if (url.pathname === '/api/mark-ip' && request.method === 'POST') return markByIp(env, request);
    if (url.pathname === '/api/admin-ip') return json({ ok: true, admin: await adminIp(env, request) });
    if (url.pathname === '/api/health') {
      const kept = await env.EXPLORER.get('health');
      return kept ? new Response(kept, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=20' } })
        : json({ why: 'no copy read yet' }, { status: 404 });
    }
    if (url.pathname === '/metrics' || url.pathname === '/metrics/') return inline(env, request, { metrics: await metrics(env), played: await played(env).catch(() => null) });
    const m = /^\/api\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      const tx = url.searchParams.has('fresh') ? await readTx(m[1]) : await txOf(env, ctx, m[1]);
      return json(tx, { status: tx.found ? 200 : 404 });
    }
    const p = /^\/tx\/([0-9a-f]{64})\/?$/.exec(url.pathname);
    if (p) return inline(env, request, { tx: await txOf(env, ctx, p[1]) });
    if (url.pathname === '/' || url.pathname === '/index.html') return inline(env, request, { recent: await recent(env, url.searchParams) });
    return env.ASSETS.fetch(request);
  },
};
