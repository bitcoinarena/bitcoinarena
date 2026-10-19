// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOT THAT BUILDS ORDER DEPTH ON AN UP/DOWN MARKET (2026-10-08: "A few bots simulate real bot behavior
// and build order depth"). It quotes the way a market maker on Polymarket's btc-updown-15m does: a fair chance for Up from
// the last BTC/USD price, the price to beat and the time left; then a ladder of buys on BOTH sides below that fair value -
// Up at fair - edge - i x step, Down at (1 - fair) - edge - i x step - so an Up bid and a Down bid of one bot together cost
// less than a share's 1 sat and never cross each other, while a taker who pays the edge always finds a price. Pure: prices,
// sizes and sides only; placing an order (its locks and its entry) is the client's join path, as a player's.
import { PRICE_SCALE, TICK, SHARE_MSAT, MIN_SHARES, YES, NO } from '../../arena-protocol/src/order-book.js';

// the standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 7.5e-8)
const phi = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
};

/**
 * THE FAIR CHANCE OF UP: P(end >= beat) for a price that moves as a random walk in its log, `volPerMin` its standard
 * deviation over one minute (BTC/USD: ~0.0006, 0.06 % a minute). A tie is Up (the market's rule); with no time left the
 * answer is the side the last price is on.
 */
export function fairUp({ beat, last, msLeft, volPerMin = 0.0006 }) {
  if (!(beat > 0) || !(last > 0)) throw new Error('a fair chance needs the price to beat and a last price');
  if (!(msLeft > 0)) return last >= beat ? 1 : 0;
  const sigma = volPerMin * Math.sqrt(msLeft / 60000);
  return phi(Math.log(last / beat) / sigma);
}

const cents = (x) => Math.round(x * 100);
const priceOf = (c) => BigInt(c) * TICK;                       // a whole cent of a share, in PRICE_SCALE units

/** The stake (msat) that buys at least `shares` at `priceCents`, its fee (`feeBps`) taken out first. */
export function stakeFor({ shares, priceCents, feeBps = 100 }) {
  const cost = (BigInt(shares) * SHARE_MSAT * priceOf(priceCents) + PRICE_SCALE - 1n) / PRICE_SCALE;
  return (cost * 10000n + BigInt(10000 - feeBps) - 1n) / BigInt(10000 - feeBps) + 1n;
}

/**
 * THE LADDER: `levels` buys a side, `stepCents` apart, the best `edgeCents` inside fair, each buying `shares` (at least the
 * book's minimum). A price leaves the book's 1..99 cents, it is dropped. Answers [{ outcome, priceCents, price, stakeMsat,
 * shares }], Up's best first, then Down's.
 */
export function quoteLadder({ fair, levels = 3, stepCents = 2, edgeCents = 1, shares = Number(MIN_SHARES), feeBps = 100 } = {}) {
  if (!(fair >= 0 && fair <= 1)) throw new Error('a fair chance is between 0 and 1');
  const n = Math.max(Number(MIN_SHARES), shares);
  const out = [];
  for (const [outcome, f] of [[YES, fair], [NO, 1 - fair]]) {
    for (let i = 0; i < levels; i++) {
      const c = cents(f) - edgeCents - i * stepCents;
      if (c < 1 || c > 99) continue;
      out.push({ outcome, priceCents: c, price: priceOf(c), shares: n, stakeMsat: stakeFor({ shares: n, priceCents: c, feeBps }) });
    }
  }
  return out;
}

/** A book's depth by side from its resting orders ([{ outcome, price }]): price levels and orders on Up and on Down. */
export function depthOf(resting) {
  const side = (o) => resting.filter((r) => Number(r.outcome) === o);
  const levels = (xs) => new Set(xs.map((r) => String(r.price))).size;
  return { up: { orders: side(YES).length, levels: levels(side(YES)) }, down: { orders: side(NO).length, levels: levels(side(NO)) } };
}
