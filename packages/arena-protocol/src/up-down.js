// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "BITCOIN UP OR DOWN - 15 MINUTES" (2026-10-09: "match this polymarket market" -
// polymarket.com/event/btc-updown-15m-1791598500, series "BTC Up or Down 15m", recurrence 15m). Its rule, verbatim:
//
//   "This market will resolve to "Up" if the time-weighted average price (TWAP) of Bitcoin ... of the time range specified
//    in the title is greater than or equal to the price at the beginning of that range. Otherwise, it will resolve to
//    "Down"."   (source: the Chainlink BTC/USD TWAP 60 s stream)
//
//
// THE "TWAP" IS THE STREAM'S, NOT THE WINDOW'S (measured 2026-10-09, comment 1154). Chainlink's "TWAP 60 s"
// stream publishes, at each moment, the average of the 60 seconds before it. Polymarket compares that value at the
// window's end with the same value at its start. A first reading of the rule averaged the whole window instead: over 4
// live windows it disagreed with Polymarket twice (a late rise; a window that averaged above its start and closed below
// it), while end-versus-start agreed 4 of 4.
//
// So: two outcomes, Up (0) and Down (1). The PRICE TO BEAT is the 60-second time-weighted average ending at the window's
// start; the END PRICE is the same average ending at the window's end. Up when the end price is at or above the price to
// beat - A TIE IS UP. This file is that rule as a pure function, the one every attestor applies to the samples it read,
// so two honest attestors reading the same samples sign the same outcome. Prices are integers (e.g. USD cents) and times
// ms, both BigInt; no float anywhere.

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

export const UP_DOWN_AVERAGE_MS = 60000n;      // the stream's average: the 60 s before each moment

/** The time-weighted average of the readings over [from, to) (each valid from its time until the next), floored; null when no reading is in force at `from`. */
function averageOver(s, from, to) {
  const before = s.filter((x) => x.atMs <= from);
  if (!before.length) return null;
  let weighted = 0n, at = from, price = before[before.length - 1].price;
  for (const x of s.filter((y) => y.atMs > from && y.atMs < to)) { weighted += price * (x.atMs - at); at = x.atMs; price = x.price; }
  weighted += price * (to - at);
  return { weighted, span: to - from };
}

/**
 * The window's prices from a feed's samples ([{ atMs, price }], any order; each a reading valid from its time until the
 * next): the PRICE TO BEAT - the 60 s average ending at the window's start - and the END PRICE - the 60 s average ending
 * at its end. Answers { ok, priceToBeat, endPrice, up } or why not: no reading in force a minute before the start, or a
 * minute before the end, decides nothing.
 */
export function upDownPrices(samples, { startMs, endMs }, averageMs = UP_DOWN_AVERAGE_MS) {
  if (typeof startMs !== 'bigint' || typeof endMs !== 'bigint' || endMs <= startMs) return { ok: false, why: 'a window is two BigInt ms times, end after start' };
  const s = [...samples].filter((x) => typeof x.atMs === 'bigint' && typeof x.price === 'bigint' && x.price > 0n)
    .sort((a, b) => (a.atMs < b.atMs ? -1 : a.atMs > b.atMs ? 1 : 0));
  const beat = averageOver(s, startMs - averageMs, startMs);
  if (!beat) return { ok: false, why: 'no reading a minute before the window\'s start: the price to beat is not known' };
  const end = averageOver(s, endMs - averageMs, endMs);
  if (!end) return { ok: false, why: 'no reading a minute before the window\'s end: the end price is not known' };
  // FLOORED for display; the comparison is exact (both averages span the same 60 s: end >= beat  <=>  weighted sums compare)
  return { ok: true, priceToBeat: beat.weighted / beat.span, endPrice: end.weighted / end.span, up: end.weighted >= beat.weighted };
}

/** The outcome: Up (0) when the end price is at or above the price to beat - a tie is Up - else Down (1). */
export function upDownOutcome(samples, window) {
  const p = upDownPrices(samples, window);
  if (!p.ok) return p;
  return { ok: true, outcome: p.up ? UP : DOWN, label: UP_DOWN_OUTCOMES[p.up ? UP : DOWN], priceToBeat: p.priceToBeat, endPrice: p.endPrice };
}
