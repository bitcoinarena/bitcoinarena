// "BITCOIN UP OR DOWN - 15 MINUTES" (kanban #235/#278; the owner 2026-10-09: "match this polymarket market" -
// polymarket.com/event/btc-updown-15m-1791598500, series "BTC Up or Down 15m", recurrence 15m). Its rule, verbatim:
//
//   "This market will resolve to "Up" if the time-weighted average price (TWAP) of Bitcoin ... of the time range specified
//    in the title is greater than or equal to the price at the beginning of that range. Otherwise, it will resolve to
//    "Down"."   (source: the Chainlink BTC/USD TWAP 60 s stream)
//
// So: two outcomes, Up (0) and Down (1); the PRICE TO BEAT is the price at the window's start; Up when the window's TWAP is
// at or above it - A TIE IS UP. This file is that rule as a pure function, the one every attestor applies to the samples it
// read, so two honest attestors reading the same samples sign the same outcome. Prices are integers (e.g. USD cents) and
// times ms, both BigInt; no float anywhere.

export const UP = 0;
export const DOWN = 1;
export const UP_DOWN_OUTCOMES = Object.freeze(['Up', 'Down']);
export const UP_DOWN_PERIOD_MS = 15n * 60n * 1000n;

/** The 15-minute window a time falls in: [start, start + 15 min), on the clock's quarter hours (UTC). */
export function upDownWindow(atMs, periodMs = UP_DOWN_PERIOD_MS) {
  if (typeof atMs !== 'bigint' || atMs < 0n) throw new Error('a time is BigInt ms');
  const startMs = atMs - (atMs % periodMs);
  return { startMs, endMs: startMs + periodMs };
}

/**
 * The window's prices from a feed's samples ([{ atMs, price }], any order; each a reading valid from its time until the
 * next): the PRICE TO BEAT - the reading in force at the window's start - and the TIME-WEIGHTED AVERAGE over the window,
 * each reading weighted by how long it stood inside [start, end). Answers { ok, priceToBeat, twap } or why not: no reading
 * at or before the start, or none reaching into the window, decides nothing.
 */
export function upDownPrices(samples, { startMs, endMs }) {
  if (typeof startMs !== 'bigint' || typeof endMs !== 'bigint' || endMs <= startMs) return { ok: false, why: 'a window is two BigInt ms times, end after start' };
  const s = [...samples].filter((x) => typeof x.atMs === 'bigint' && typeof x.price === 'bigint' && x.price > 0n)
    .sort((a, b) => (a.atMs < b.atMs ? -1 : a.atMs > b.atMs ? 1 : 0));
  const before = s.filter((x) => x.atMs <= startMs);
  if (!before.length) return { ok: false, why: 'no reading at or before the window\'s start: the price to beat is not known' };
  const priceToBeat = before[before.length - 1].price;
  let weighted = 0n;
  let at = startMs;
  let price = priceToBeat;
  for (const x of s.filter((y) => y.atMs > startMs && y.atMs < endMs)) {
    weighted += price * (x.atMs - at);
    at = x.atMs; price = x.price;
  }
  weighted += price * (endMs - at);
  // FLOORED: the comparison below is exact either way (twap >= beat  <=>  weighted >= beat * span)
  return { ok: true, priceToBeat, twap: weighted / (endMs - startMs), up: weighted >= priceToBeat * (endMs - startMs) };
}

/** The outcome: Up (0) when the window's TWAP is at or above the price to beat - a tie is Up - else Down (1). */
export function upDownOutcome(samples, window) {
  const p = upDownPrices(samples, window);
  if (!p.ok) return p;
  return { ok: true, outcome: p.up ? UP : DOWN, label: UP_DOWN_OUTCOMES[p.up ? UP : DOWN], priceToBeat: p.priceToBeat, twap: p.twap };
}
