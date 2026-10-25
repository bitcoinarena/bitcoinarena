// THE ARENA'S TRANSACTION EXPLORER, explorer.bitcoin-arena.io (kanban #624, 2026-10-24: "each order that was executed gets a transaction
// id in upordown and in the account history. They point to explorer.bitcoin-arena.io which records all transactions. They query nodes in the
// background for new transactions but maintains a local cache for faster loading. Also records the timing info we already display there and
// all relevant data. Also timings for all other apps."; "It should all be cached not be fetched from a node"; "You should do that for each
// tx not just on the fly"). A transaction's id is its entry id, the same at every seat.
//
//   every minute (cron)   each seat's GET /txs?full=1 over the last READ_BACK_MS: every transaction it holds with its whole record;
//                         merged across the seats and written to D1 (txs) for EVERY transaction, only where it changed
//   GET /api/recent       the newest, from D1
//   GET /api/tx/<id>      from D1; one the minute has not read yet is read from the seats once and kept
//   /, /tx/<id>           the pages (www/), with what D1 holds built into the page, so they draw at once
//   GET /api/metrics      the Metrics page's figures (kanban #676): volume per day from D1, the protocol reserve and the websites' fees
//   /metrics              that page, its figures built in
const SEATS = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`)
  .concat([1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/fed2-${i}`));
const RECENT_MAX = 1000;
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
  return env.DB.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET round = excluded.round, app = excluded.app, federation = excluded.federation, stored_ms = excluded.stored_ms,
    settled = excluded.settled, hash = excluded.hash, json = excluded.json, updated_ms = excluded.updated_ms`)
    .bind(tx.id, e.round || null, e.app || null, e.federation || null, tx.storedFirst ? Date.parse(tx.storedFirst) : Date.now(),
      tx.settlement ? tx.settlement.state : null, h, JSON.stringify(tx), Date.now());
}

// THE OLDER TRANSACTIONS TOO (2026-10-24: "You should do that for each tx"): besides the newest READ_BACK_MS, each minute reads one
// older window, walking back from where it stopped (KV 'backfill') until the nodes' 14 days; then it stops
const BACKFILL_UNTIL_MS = 14 * 24 * 3600000, BACKFILL_ROWS = 200;
async function backfill(env) {
  const t0 = Date.now();
  let at = Number(await env.EXPLORER.get('backfill')) || t0 - READ_BACK_MS;
  if (at <= t0 - BACKFILL_UNTIL_MS) return;
  const from = at - READ_BACK_MS;
  const n = await readWindow(env, from, BACKFILL_ROWS, at);
  await env.EXPLORER.put('backfill', String(from));
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
  await env.EXPLORER.put('metrics', JSON.stringify(m));
  return m;
}

const DAY_MS = 86400000, VOLUME_DAYS = 30;
async function metrics(env) {
  const kept = JSON.parse((await env.EXPLORER.get('metrics')) || 'null');
  const since = Math.floor(Date.now() / DAY_MS) * DAY_MS - (VOLUME_DAYS - 1) * DAY_MS;
  const r = await env.DB.prepare(`SELECT (stored_ms / ${DAY_MS}) AS d, COUNT(*) AS n, SUM(CAST(json_extract(json, '$.entry.stakeMsat') AS INTEGER)) AS msat
    FROM txs WHERE stored_ms >= ? GROUP BY d ORDER BY d DESC`).bind(since).all();
  const volume = (r.results || []).map((x) => ({ day: new Date(Number(x.d) * DAY_MS).toISOString().slice(0, 10), txs: Number(x.n), msat: String(x.msat || 0) }));
  return { volume, reserve: kept ? kept.reserve : null, referral: kept ? kept.referral : null, readAt: kept ? kept.readAt : null, seats: kept ? kept.seats : null };
}

async function poll(env) {
  const n = await readWindow(env, Date.now() - READ_BACK_MS, 500, null);
  console.log(JSON.stringify({ poll: n }));
  // every fifth minute: the figures change slowly, and each read asks every seat twice
  if (Math.floor(Date.now() / 60000) % 5 === 0 || !(await env.EXPLORER.get('metrics')))
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

async function recent(env) {
  // with its amount (2026-10-24: "Also add the amount to the list page in sats"): the entry's stake, msat
  const r = await env.DB.prepare(`SELECT id, round, app, federation, stored_ms, json_extract(json, '$.entry.stakeMsat') AS stake, json_extract(json, '$.result.state') AS rstate,
    json_extract(json, '$.result.netMsat') AS rnet, json_extract(json, '$.result.payoutMsat') AS rpaid FROM txs ORDER BY stored_ms DESC LIMIT ?`).bind(RECENT_MAX).all();
  return (r.results || []).map((x) => ({ id: x.id, round: x.round, app: x.app, federation: x.federation, storedMs: Number(x.stored_ms), stakeMsat: x.stake === null ? null : String(x.stake),
    result: x.rstate ? { state: x.rstate, netMsat: x.rnet === null ? null : String(x.rnet), payoutMsat: x.rpaid === null ? null : String(x.rpaid) } : null }));
}

async function txOf(env, ctx, id) {
  const row = await env.DB.prepare('SELECT json FROM txs WHERE id = ?').bind(id).first();
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
  async scheduled(event, env, ctx) { ctx.waitUntil(poll(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/api/recent') return json({ txs: await recent(env) }, { maxAge: 10 });
    if (url.pathname === '/api/metrics') return json(await metrics(env), { maxAge: 30 });
    if (url.pathname === '/metrics' || url.pathname === '/metrics/') return inline(env, request, { metrics: await metrics(env) });
    const m = /^\/api\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      const tx = url.searchParams.has('fresh') ? await readTx(m[1]) : await txOf(env, ctx, m[1]);
      return json(tx, { status: tx.found ? 200 : 404 });
    }
    const p = /^\/tx\/([0-9a-f]{64})\/?$/.exec(url.pathname);
    if (p) return inline(env, request, { tx: await txOf(env, ctx, p[1]) });
    if (url.pathname === '/' || url.pathname === '/index.html') return inline(env, request, { recent: await recent(env) });
    return env.ASSETS.fetch(request);
  },
};
