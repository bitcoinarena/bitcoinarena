// THE ARENA'S TRANSACTION EXPLORER, explorer.bitcoin-arena.io (kanban #624, 2026-10-24: "each order that was executed gets a transaction
// id in upordown and in the account history. They point to explorer.bitcoin-arena.io which records all transactions. They query nodes in the
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

/** One transaction from every seat's answer ([{ seat, status, body, why }]), merged. */
function merge(id, answers, readMs = null) {
  const known = answers.filter((a) => a.body && a.body.known);
  const first = known[0] ? known[0].body : null;
  const seats = answers.map((a) => ({ seat: seatName(a.seat), key: a.body && a.body.seat ? a.body.seat : null,
    status: a.status, known: !!(a.body && a.body.known), storedAt: a.body && a.body.storedAt ? a.body.storedAt : null,
    steps: a.body && Array.isArray(a.body.steps) ? a.body.steps : [], book: a.body ? a.body.book || null : null, why: a.why || null,
    did: a.body && a.body.processed && Array.isArray(a.body.processed.mine) ? a.body.processed.mine : [],
    locks: a.body && a.body.locks ? a.body.locks : null }));
  const settlement = known.map((a) => a.body.settlement).find((x) => x && x.txid) || null;
  const client = known.map((a) => a.body.client).find(Boolean) || null;
  // its result (won, lost, refunded, pending): a seat that holds the settlement says it; any seat says pending
  const results = known.map((a) => a.body.result).filter(Boolean);
  const result = results.find((r) => r.state !== 'pending') || results[0] || null;
  // WHO PROCESSED ITS ROUND (2026-10-24: "Also show who processed the round, e.g for settlement and verify"): the committees, the
  // asker and the outcome's attestors as the seats name them (the first that names each), each seat key named by the seat that has it
  const proc = known.map((a) => a.body.processed).filter(Boolean);
  const pick = (k) => (proc.find((p) => p[k] && (!Array.isArray(p[k]) || p[k].length)) || {})[k] || null;
  const names = Object.fromEntries(seats.filter((x) => x.key).map((x) => [x.key, x.seat]));
  const processed = proc.length ? { game: pick('game'), settlement: pick('settlement'), asker: pick('asker'), outcomes: pick('outcomes') || [],
    settledAt: pick('settledAt'), settlementWhy: pick('settlementWhy'), names } : null;
  return { id, found: known.length > 0, readAt: new Date().toISOString(), readMs,
    entry: first ? first.entry : null, locks: first ? first.locks : null, settlement, client, processed, result,
    storedFirst: seats.map((s) => s.storedAt).filter(Boolean).sort()[0] || null, seats };
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
// KV - per federation the reserve the most up-to-date seat holds (the largest), per website the most any seat indexed; the volume per day
// is read from D1's transactions when asked
async function readMetrics(env) {
  const [res, ref] = await Promise.all([
    Promise.all(SEATS.map((seat) => ask(`${seat}/reserves`, READ_MS))),
    Promise.all(SEATS.map((seat) => ask(`${seat}/referral-fees`, READ_MS)))]);
  const feds = new Map(), sites = new Map();
  for (const a of res) for (const f of (a.body && Array.isArray(a.body.federations) ? a.body.federations : [])) {
    const m = BigInt(f.heldMsat || 0); if (!feds.has(f.federationId) || m > feds.get(f.federationId)) feds.set(f.federationId, m);
  }
  // and each program's name, as its key said it (kanban #675): the newest any seat holds
  const names = new Map();
  for (const a of ref) for (const p of (a.body && Array.isArray(a.body.programs) ? a.body.programs : [])) {
    if (!names.has(p.site) || Number(p.atMs) > names.get(p.site).atMs) names.set(p.site, { name: p.name, atMs: Number(p.atMs) });
  }
  for (const a of ref) for (const x of (a.body && Array.isArray(a.body.sites) ? a.body.sites : [])) {
    const m = BigInt(x.msat || 0); if (!sites.has(x.site) || m > sites.get(x.site).msat) sites.set(x.site, { msat: m, payouts: x.payouts });
  }
  for (const [site] of names) if (!sites.has(site)) sites.set(site, { msat: 0n, payouts: 0 });
  const sum = (it) => [...it].reduce((t, m) => t + m, 0n);
  const m = { readAt: new Date().toISOString(), seats: { reserves: res.filter((a) => a.body).length, referral: ref.filter((a) => a.body).length, of: SEATS.length },
    reserve: { msat: String(sum(feds.values())), federations: [...feds].map(([federation, msat]) => ({ federation, msat: String(msat) })) },
    referral: { msat: String(sum([...sites.values()].map((x) => x.msat))), sites: [...sites].map(([site, x]) => ({ site, name: names.has(site) ? names.get(site).name : null, msat: String(x.msat), payouts: x.payouts }))
      .sort((a, b) => (BigInt(b.msat) > BigInt(a.msat) ? 1 : BigInt(b.msat) < BigInt(a.msat) ? -1 : 0)) } };
  await statePut(env, 'metrics', JSON.stringify(m));
  return m;
}

const DAY_MS = 86400000, VOLUME_DAYS = 30;
async function metrics(env) {
  const kept = JSON.parse((await stateGet(env, 'metrics')) || 'null');
  const since = Math.floor(Date.now() / DAY_MS) * DAY_MS - (VOLUME_DAYS - 1) * DAY_MS;
  // the stakes of the orders (kanban #683: the gifts and items bought are rows too, not stakes)
  const r = await env.DB.prepare(`SELECT (stored_ms / ${DAY_MS}) AS d, COUNT(*) AS n, SUM(CAST(json_extract(json, '$.entry.stakeMsat') AS INTEGER)) AS msat
    FROM txs WHERE stored_ms >= ? AND kind = 'order' GROUP BY d ORDER BY d DESC`).bind(since).all();
  const volume = (r.results || []).map((x) => ({ day: new Date(Number(x.d) * DAY_MS).toISOString().slice(0, 10), txs: Number(x.n), msat: String(x.msat || 0) }));
  return { volume, reserve: kept ? kept.reserve : null, referral: kept ? kept.referral : null, readAt: kept ? kept.readAt : null, seats: kept ? kept.seats : null };
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
    const w = await keep(env, merge(id, answers, null), hashes.get(id));
    if (w) writes.push(w);
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
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
  if (/^[0-9a-f]{1,64}$/.test(part)) { where.push('(id LIKE ? OR round LIKE ? OR fed_txid LIKE ?)'); binds.push(`%${part}%`, `%${part}%`, `%${part}%`); }
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

export default {
  // the health copy on its own trigger (kanban #686): its own run, so its fetches do not count against the transactions' read
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === HEALTH_CRON ? readHealth(env).catch((e) => console.log(JSON.stringify({ healthError: String(e && e.message ? e.message : e) }))) : poll(env));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/api/recent') return json(await recent(env, url.searchParams), { maxAge: 10 });
    if (url.pathname === '/api/metrics') return json(await metrics(env), { maxAge: 30 });
    if (url.pathname === '/api/health') {
      const kept = await env.EXPLORER.get('health');
      return kept ? new Response(kept, { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=20' } })
        : json({ why: 'no copy read yet' }, { status: 404 });
    }
    if (url.pathname === '/metrics' || url.pathname === '/metrics/') return inline(env, request, { metrics: await metrics(env) });
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
