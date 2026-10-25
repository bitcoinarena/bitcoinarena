// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY DONATION IN EUR, USD, CHF OR GBP, AT ITS OWN HISTORIC RATE (kanban #578, 2026-10-22: "Add EUR/USD/CHF/GBP optional currency
// per donation. It needs to fetch the historic rates and apply it to each donation and a filter where the sats can be changed to your
// favorite currency"). A dev client records USD and EUR at the moment it records a donation (arena-donor rateAt); what a row lacks is
// filled here from the same provider, one range request per currency for the whole span (hourly points up to 90 days), the price closest
// to the donation taken, and kept in <client dir>/fiat-rates.json by outpoint - a rate is fetched once, never again.
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const FIATS = Object.freeze(['eur', 'usd', 'chf', 'gbp']);
const PROVIDER = 'https://api.coingecko.com/api/v3/coins/bitcoin';
const SPAN_MS = 85 * 86400000;          // a range under 90 days gives hourly points
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

/** A donation's own time, ms. */
export const atOf = (r) => Number(r.verifiedMs || r.recordedAt || 0);
/** msat at a BTC price, in that currency (two decimals kept by the caller). */
export const fiatOf = (msat, perBtc) => (Number(msat) / 1e11) * Number(perBtc);

/** The price closest to `atMs` among [ms, price] points; null without one within 6 h. */
function nearest(points, atMs) {
  let best = null;
  for (const p of points) if (!best || Math.abs(p[0] - atMs) < Math.abs(best[0] - atMs)) best = p;
  return best && Math.abs(best[0] - atMs) <= 6 * 3600000 ? best[1] : null;
}

/**
 * FILL WHAT THE ROWS LACK: { outpoint: { eur, usd, chf, gbp } } for every row - its recorded USD/EUR first, the cache next, the provider
 * for the rest (one request per currency per 85-day span). Writes the cache when something new was learned. A provider that does not
 * answer leaves those rows without that currency (the page shows sat for them).
 */
export async function fillFiatRates(dir, rows, { fetcher = fetch, timeoutMs = 10000 } = {}) {
  const file = join(dir, 'fiat-rates.json');
  const cache = readJson(file, {}) || {};
  let learned = false;
  const out = {};
  const missing = Object.fromEntries(FIATS.map((c) => [c, []]));
  for (const r of rows || []) {
    if (!r || !r.outpoint) continue;
    const had = cache[r.outpoint] || {};
    const v = { ...(r.eurPerBtc ? { eur: Number(r.eurPerBtc) } : {}), ...(r.usdPerBtc ? { usd: Number(r.usdPerBtc) } : {}),
      ...(r.chfPerBtc ? { chf: Number(r.chfPerBtc) } : {}), ...(r.gbpPerBtc ? { gbp: Number(r.gbpPerBtc) } : {}), ...had };
    out[r.outpoint] = v;
    for (const c of FIATS) if (!(v[c] > 0) && atOf(r) > 0) missing[c].push(r);
  }
  for (const c of FIATS) {
    const want = missing[c].sort((a, b) => atOf(a) - atOf(b));
    for (let i = 0; i < want.length;) {
      const from = atOf(want[i]) - 2 * 3600000;
      let j = i; while (j < want.length && atOf(want[j]) - from < SPAN_MS) j++;
      const to = atOf(want[j - 1]) + 2 * 3600000;
      let points = [];
      try {
        const r = await fetcher(`${PROVIDER}/market_chart/range?vs_currency=${c}&from=${Math.floor(from / 1000)}&to=${Math.ceil(to / 1000)}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) points = ((await r.json()).prices || []).filter((p) => Array.isArray(p) && p.length === 2);
      } catch { points = []; }
      for (const row of want.slice(i, j)) {
        const price = nearest(points, atOf(row));
        if (price) { out[row.outpoint] = { ...out[row.outpoint], [c]: price }; cache[row.outpoint] = { ...(cache[row.outpoint] || {}), [c]: price }; learned = true; }
      }
      i = j;
    }
  }
  if (learned) { try { writeFileSync(`${file}.tmp`, JSON.stringify(cache)); renameSync(`${file}.tmp`, file); } catch { /* kept in memory this time */ } }
  return out;
}

/** THE PRICE NOW, for what a client holds today: { eur, usd, chf, gbp, atMs } - kept 5 minutes; null when the provider does not answer. */
let nowKept = null;
export async function ratesNow({ fetcher = fetch, nowMs = Date.now(), timeoutMs = 8000 } = {}) {
  if (nowKept && nowMs - nowKept.atMs < 300000) return nowKept;
  try {
    const r = await fetcher(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${FIATS.join(',')}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return nowKept;
    const b = (await r.json()).bitcoin || {};
    if (FIATS.every((c) => Number(b[c]) > 0)) nowKept = { ...Object.fromEntries(FIATS.map((c) => [c, Number(b[c])])), atMs: nowMs };
  } catch { /* the last one kept, or none */ }
  return nowKept;
}

/**
 * WHAT THE PAGE SHOWS IN A CURRENCY: per period (day, week, all - UTC, the week from Monday) the sum of each donation at its own rate,
 * per currency; each outpoint's values; how many rows have no rate yet in that currency.
 */
export function fiatSummary(rows, rates, { nowMs = Date.now() } = {}) {
  const now = new Date(nowMs);
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const starts = { day, week: day - ((now.getUTCDay() + 6) % 7) * 86400000, all: -Infinity };
  const totals = Object.fromEntries(Object.keys(starts).map((k) => [k, Object.fromEntries(FIATS.map((c) => [c, 0]))]));
  const unrated = Object.fromEntries(FIATS.map((c) => [c, 0]));
  const values = {};
  for (const r of rows || []) {
    const v = rates[r.outpoint] || {};
    const at = atOf(r);
    values[r.outpoint] = {};
    for (const c of FIATS) {
      if (!(v[c] > 0)) { unrated[c]++; continue; }
      const x = fiatOf(r.amountMsat, v[c]);
      values[r.outpoint][c] = Math.round(x * 10000) / 10000;
      for (const [k, s] of Object.entries(starts)) if (at >= s) totals[k][c] += x;
    }
  }
  for (const k of Object.keys(totals)) for (const c of FIATS) totals[k][c] = Math.round(totals[k][c] * 100) / 100;
  return { totals, unrated, values };
}

/** The rows of a client's permanent record. */
export function rowsOf(dir) {
  const p = join(dir, 'donations.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
}
