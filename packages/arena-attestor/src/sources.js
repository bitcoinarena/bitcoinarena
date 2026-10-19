// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PRICE SOURCES AN ATTESTOR READS (kanban #236, the owner 2026-10-09: "A on the test host (Coinbase, Kraken, Bitstamp); B on the
// test host (Coinbase, Kraken, Bitstamp); C on the test host (Gemini, Coinbase, Kraken)"): public BTC/USD tickers, each read to
// whole cents - a decimal string cut at the cent, never a float.
export const SOURCES = Object.freeze({
  coinbase: { url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', price: (j) => j && j.data && j.data.amount },
  kraken: { url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', price: (j) => j && j.result && Object.values(j.result)[0] && Object.values(j.result)[0].c[0] },
  bitstamp: { url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', price: (j) => j && j.last },
  gemini: { url: 'https://api.gemini.com/v1/pubticker/btcusd', price: (j) => j && j.last },
});

/** A decimal price string to whole cents, cut (not rounded) at the cent; null if it is not a positive decimal. */
export function centsOf(text) {
  const m = /^\s*(\d{1,12})(?:\.(\d+))?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const cents = BigInt(m[1]) * 100n + BigInt(((m[2] || '') + '00').slice(0, 2));
  return cents > 0n ? cents : null;
}

/** The median of BigInt prices: the middle one, or the lower of the two middle ones (whole cents, no halving). */
export function medianOf(prices) {
  const s = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
}

/** One reading of `names` at once: each source's cents (or why not) and their median - none if fewer than two answered. */
export async function readSources(names, { fetcher = fetch, timeoutMs = 5000 } = {}) {
  const got = await Promise.all(names.map(async (name) => {
    const src = SOURCES[name];
    if (!src) return { name, cents: null, why: 'no such source' };
    try {
      const r = await fetcher(src.url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'arena-attestor/0.0.1' } });
      if (!r.ok) return { name, cents: null, why: `HTTP ${r.status}` };
      const cents = centsOf(src.price(await r.json()));
      return cents ? { name, cents } : { name, cents: null, why: 'no price in the answer' };
    } catch (e) { return { name, cents: null, why: e.message }; }
  }));
  const answered = got.filter((x) => x.cents !== null).map((x) => x.cents);
  return { sources: got, median: answered.length >= 2 ? medianOf(answered) : null };
}
