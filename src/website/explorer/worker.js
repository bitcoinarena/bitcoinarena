// THE ARENA'S TRANSACTION EXPLORER, explorer.bitcoin-arena.io (kanban #624, the owner 2026-10-24: "each order that was executed gets a transaction
// id in upordown and in the account history. They point to explorer.bitcoin-arena.io which records all transactions. They query nodes in the
// background for new transactions but maintains a local cache for faster loading. Also records the timing info we already display there and
// all relevant data. Also timings for all other apps."). A transaction's id is its entry id, the same at every seat.
//
//   every minute (cron)   each seat's GET /txs since the last read: the newest transactions, kept in KV (the newest RECENT_MAX)
//   GET /api/recent       those, newest first
//   GET /api/tx/<id>      every seat's GET /tx, asked together and merged: the entry, when each seat stored it, each door's steps at each
//                         seat, the locks' federation transactions, the round's settlement, the page's own signed timing. Kept in KV:
//                         30 s while the round is not settled, a day once it is.
//   /, /tx/<id>           the pages (www/), which keep what they read in the browser too
const SEATS = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`)
  .concat([1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/fed2-${i}`));
const RECENT_MAX = 1000;
const ASK_MS = 6000;
const hex64 = /^[0-9a-f]{64}$/;

const json = (body, { status = 200, maxAge = 0 } = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' } });

async function ask(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ASK_MS), headers: { accept: 'application/json' } });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = null; }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: null, why: String(e && e.message ? e.message : e).slice(0, 120) }; }
}

/** Every seat's view of one transaction, merged. */
async function readTx(id) {
  const t0 = Date.now();
  const answers = await Promise.all(SEATS.map(async (seat) => ({ seat, ...(await ask(`${seat}/tx?id=${id}`)) })));
  const known = answers.filter((a) => a.body && a.body.known);
  const first = known[0] ? known[0].body : null;
  const seats = answers.map((a) => ({ seat: a.seat.replace('https://tn4.bitcoin-arena.io/', ''), key: a.body && a.body.seat ? a.body.seat : null,
    status: a.status, known: !!(a.body && a.body.known), storedAt: a.body && a.body.storedAt ? a.body.storedAt : null,
    steps: a.body && Array.isArray(a.body.steps) ? a.body.steps : [], book: a.body ? a.body.book || null : null, why: a.why || null,
    did: a.body && a.body.processed && Array.isArray(a.body.processed.mine) ? a.body.processed.mine : [] }));
  const settlement = known.map((a) => a.body.settlement).find((x) => x && x.txid) || null;
  const client = known.map((a) => a.body.client).find(Boolean) || null;
  // WHO PROCESSED ITS ROUND (the owner 2026-10-24: "Also show who processed the round, e.g for settlement and verify"): the committees, the
  // asker and the outcome's attestors as the seats name them (the first that names each), each seat key named by the seat that has it
  const proc = known.map((a) => a.body.processed).filter(Boolean);
  const pick = (k) => (proc.find((p) => p[k] && (!Array.isArray(p[k]) || p[k].length)) || {})[k] || null;
  const names = Object.fromEntries(seats.filter((x) => x.key).map((x) => [x.key, x.seat]));
  const processed = proc.length ? { game: pick('game'), settlement: pick('settlement'), asker: pick('asker'), outcomes: pick('outcomes') || [],
    settledAt: pick('settledAt'), settlementWhy: pick('settlementWhy'), names } : null;
  return { id, found: known.length > 0, readAt: new Date().toISOString(), readMs: Date.now() - t0,
    entry: first ? first.entry : null, locks: first ? first.locks : null, settlement, client, processed,
    storedFirst: seats.map((s) => s.storedAt).filter(Boolean).sort()[0] || null, seats };
}

async function poll(env) {
  const kept = (await env.EXPLORER.get('recent', 'json')) || [];
  const since = (await env.EXPLORER.get('since', 'json')) || {};
  const byId = new Map(kept.map((t) => [t.id, t]));
  let added = 0;
  await Promise.all(SEATS.map(async (seat) => {
    const got = await ask(`${seat}/txs?since=${Number(since[seat] || Date.now() - 24 * 3600000)}&limit=500`);
    if (!got.body || !Array.isArray(got.body.txs)) return;
    for (const t of got.body.txs) {
      since[seat] = Math.max(Number(since[seat] || 0), Number(t.storedMs) || 0);
      if (!hex64.test(String(t.id))) continue;
      const had = byId.get(t.id);
      // a row kept before the seats named its app and federation gets them from the next seat that does
      if (had) { if (!had.app && t.app) had.app = t.app; if (!had.federation && t.federation) had.federation = t.federation; continue; }
      const row = { id: t.id, round: t.round, storedMs: Number(t.storedMs), app: t.app || null, federation: t.federation || null };
      byId.set(t.id, row); kept.push(row); added++;
    }
  }));
  kept.sort((a, b) => b.storedMs - a.storedMs);
  await env.EXPLORER.put('recent', JSON.stringify(kept.slice(0, RECENT_MAX)));
  await env.EXPLORER.put('since', JSON.stringify(since));
  console.log(JSON.stringify({ poll: { added, kept: Math.min(kept.length, RECENT_MAX) } }));
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(poll(env)); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/api/recent') return json({ txs: (await env.EXPLORER.get('recent', 'json')) || [] }, { maxAge: 20 });
    const m = /^\/api\/tx\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      const id = m[1];
      const cached = url.searchParams.has('fresh') ? null : await env.EXPLORER.get(`tx:${id}`, 'json');
      if (cached) return json({ ...cached, cached: true }, { maxAge: 10 });
      const tx = await readTx(id);
      if (tx.found) ctx.waitUntil(env.EXPLORER.put(`tx:${id}`, JSON.stringify(tx), { expirationTtl: tx.settlement && tx.settlement.state === 'ACCEPTED' ? 86400 : 60 }));
      return json(tx, { status: tx.found ? 200 : 404 });
    }
    // the pages: /tx/<id> is the same page as /, which reads the id from the address
    if (/^\/tx\/[0-9a-f]{64}\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/', url), request));   // '/', not '/index.html': the assets answer that with a 307 to '/'
    return env.ASSETS.fetch(request);
  },
};
