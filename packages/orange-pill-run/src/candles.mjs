// Orange Pill Run - the 48 thirty-minute BTC-USD candles of one UTC day (kanban #3247).
// Sources in order: Coinbase Advanced Trade public market candles (THIRTY_MINUTE), Coinbase Exchange 15-min
// candles merged in pairs (the Exchange API has no 30-min granularity), Kraken, Bitstamp. Each source is retried.
// The caller stores the result with the round and never fetches that day again: the stored candles are the level.
// A candle is [t, o, h, l, c] with t = unix seconds of its open; the day is complete only after it ended.
const DAY = 86400, HALF = 1800, N = 48;

export function dayStartOf(day) {
  if (typeof day === "number") return Math.floor(day / DAY) * DAY;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) throw new TypeError("day must be YYYY-MM-DD or unix seconds");
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
}
export const dayName = (start) => new Date(start * 1000).toISOString().slice(0, 10);

// null when the 48 candles of the day starting at `start` are complete and sane, else the reason
export function checkCandles(candles, start) {
  if (!Array.isArray(candles) || candles.length !== N) return "expected " + N + " candles, got " + (Array.isArray(candles) ? candles.length : typeof candles);
  for (let i = 0; i < N; i++) {
    const c = candles[i];
    if (!Array.isArray(c) || c.length !== 5 || !c.every((v) => typeof v === "number" && Number.isFinite(v))) return "candle " + i + " malformed";
    const [t, o, h, l, cl] = c;
    if (t !== start + i * HALF) return "candle " + i + " at " + t + ", expected " + (start + i * HALF);
    if (!(l > 0) || h < Math.max(o, cl) || l > Math.min(o, cl)) return "candle " + i + " has impossible prices";
  }
  return null;
}

function pick(rows, start) {
  const by = new Map();
  for (const r of rows) if (r[0] >= start && r[0] < start + DAY) by.set(r[0], r);
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}
const num = (v) => (typeof v === "number" ? v : Number(v));

async function getJson(fetchFn, url, timeoutMs) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ac.signal, headers: { accept: "application/json", "user-agent": "orange-pill-run/1" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}

export const SOURCES = [
  { name: "coinbase", async get(f, start, to) {
    const j = await getJson(f, `https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles?start=${start}&end=${start + DAY - HALF}&granularity=THIRTY_MINUTE`, to);
    return pick((j.candles || []).map((c) => [num(c.start), num(c.open), num(c.high), num(c.low), num(c.close)]), start);
  } },
  { name: "coinbase-exchange-15m", async get(f, start, to) {
    const iso = (s) => new Date(s * 1000).toISOString();
    const j = await getJson(f, `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=900&start=${iso(start)}&end=${iso(start + DAY - 900)}`, to);
    if (!Array.isArray(j)) throw new Error("unexpected answer");
    const q = pick(j.map((c) => [num(c[0]), num(c[3]), num(c[2]), num(c[1]), num(c[4])]), start), by = new Map(q.map((c) => [c[0], c]));
    const out = [];
    for (let t = start; t < start + DAY; t += HALF) { const a = by.get(t), b = by.get(t + 900); if (!a || !b) continue; out.push([t, a[1], Math.max(a[2], b[2]), Math.min(a[3], b[3]), b[4]]); }
    return out;
  } },
  { name: "kraken", async get(f, start, to) {
    const j = await getJson(f, `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=30&since=${start - 1}`, to);
    if (j.error && j.error.length) throw new Error(String(j.error));
    const k = Object.keys(j.result || {}).find((x) => x !== "last");
    return pick((j.result[k] || []).map((c) => [num(c[0]), num(c[1]), num(c[2]), num(c[3]), num(c[4])]), start);
  } },
  { name: "bitstamp", async get(f, start, to) {
    const j = await getJson(f, `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=1800&limit=48&start=${start}`, to);
    return pick(((j.data && j.data.ohlc) || []).map((c) => [num(c.timestamp), num(c.open), num(c.high), num(c.low), num(c.close)]), start);
  } },
];

// fetchDay("2026-11-22") -> { day, from, to, source, candles, tried }; throws when every source failed
export async function fetchDay(day, { fetch: fetchFn = globalThis.fetch, retries = 3, retryDelayMs = 2000, timeoutMs = 15000, nowS = Math.floor(Date.now() / 1000), sources = SOURCES, log = () => {} } = {}) {
  const start = dayStartOf(day);
  if (nowS < start + DAY) throw new Error("day " + dayName(start) + " has not ended yet");
  const tried = [];
  for (const src of sources) {
    for (let a = 1; a <= retries; a++) {
      try {
        const candles = await src.get(fetchFn, start, timeoutMs);
        const bad = checkCandles(candles, start);
        if (bad) throw new Error(bad);
        return { day: dayName(start), from: start, to: start + DAY, source: src.name, candles, tried };
      } catch (e) {
        tried.push({ source: src.name, attempt: a, error: String(e && e.message || e) });
        log(src.name + " try " + a + ": " + (e && e.message || e));
        if (a < retries) await new Promise((r) => setTimeout(r, retryDelayMs * a));
      }
    }
  }
  const err = new Error("no candles for " + dayName(start) + " from any source");
  err.tried = tried; throw err;
}
