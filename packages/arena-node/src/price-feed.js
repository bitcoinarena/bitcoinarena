// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE'S PRICE FEED (§11): "the committee nodes publish one attested sample every 5 s of round time
// from the contract's named feed - and, with the first, the 64 samples before start_time from the feed's history ... The
// player never chooses the price; he can only replay it or not play."
//
//   READ. Every seat reads the feed itself every 5 s, on the wall clock's 5 s grid, and keeps its own readings (the last 128).
//   LEAD. Sample k of a round (applied at round time k x 5 s) is led by the round's seat k mod n, as an order batch is - ONE
//         PERIOD AHEAD: it takes its own reading at round time (k - 1) x 5 s, signs the sample (round, tick, price) and asks
//         every other seat (POST /price-sign), so the attested sample is at the player's page before the run reaches its
//         tick (measured need: a sample signed at its own moment reached the page 1-2 s after the tick it names).
//   SIGN. A seat signs only a sample of a round it holds, whose moment is now (within SIGN_SLACK_MS), at the tick that moment
//         names, and whose price is within `tolerance` of its OWN reading at that moment - so no seat can pick the price,
//         only report one the others saw too. It signs one price per (round, k): a second, different ask is refused.
//   HOLD. With the threshold of the committee's signatures (receiptsNeeded) the leader hands the attested sample to every
//         seat (POST /price-attested); each checks it stands before keeping it. GET /price-samples serves what a seat holds.
//   THE TAPE. The 64 prices before the start are one PriceTape, led by the round's seat 0 at the start: its readings on the
//         grid before the start; a seat signs it when every reading it holds for those moments is within tolerance and it
//         holds at least half of them.
//   THE ENDS. A round's result is made from two samples only: sample 0 (its open) and the last sample at or before its last tick
//         (its close, closeSampleK). Every seat that keeps one of them also writes it to its database, so a restart keeps it; a
//         seat that lacks one at the end asks the committee for it (GET /price-samples?ks=) and keeps it once it stands
//         (measured on testnet4 2026-10-14,: the samples lived in memory only, every seat of a 6 h Tick Tock round
//         had restarted during it, and each held a different first sample - 2151, 2175, 2190 ... - so no two would have signed
//         the same open).
// What a client does with them (the batch carries each attested sample at its tick; a run with none is SIM) is slice 2.
//
// PROTOCOL 5 - THE MEDIAN OF SIGNED READINGS (RULED 2026-10-14 ~21:50Z: "Build A as protocol 5 ... each seat
// signs the price it read, and the sample is the median of five signed readings. Nobody proposes a price, so nobody chooses
// BULLS, BEARS, or FLAT."). For a round whose OWN version is 5 or later (constants.js mediansPrices) - a round below keeps all
// of the above unchanged:
//   READ. As above, with the interim's rules for each seat's own reading: the exchange ticker, at most 5 s old, else none.
//   POST. Every seat of the committee - no leader - signs ITS OWN reading of sample k at round time (k - 1) x 5 s (one period
//         ahead, as above) and posts it to the committee's other seats (POST /price-reading); one reading a seat a sample,
//         and only at its moment. The tape: each seat signs its own 64 readings before the start once, a period before it.
//   HOLD. Every seat keeps every reading that is signed by a key of the round's committee and verifies (a key that signed two
//         different readings of one sample counts for none of them); a sample stands with `needed` (5 of 7) distinct readings,
//         its price their median (price-sample.js priceSampleStands5). GET /price-samples serves each standing sample with its
//         readings once all the committee's are in or SERVE_AFTER_MS has passed since its moment, so the pages take the same
//         set; `ks` serves every reading held of those samples.
//   THE ENDS. The readings of sample 0 and of the closing sample are written to the database as they come; at the end a seat
//         that holds fewer than the whole committee's asks the others (GET /price-samples?ks=) and takes every reading that
//         verifies, so the seats sign the result over the same readings (round-result.js roundResultFromReadings).
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { priceSampleId, priceTapeId, priceAttestationStands, sampleTick, PRICE_SAMPLE_EVERY_MS, PRICE_TAPE_LENGTH,
  priceReadingId, priceTapeReadingId, medianOf } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { roundResultFrom, roundResultFromReadings, roundResultId, frontName } from '../../arena-protocol/src/round-result.js';
import { mediansPrices } from '../../arena-protocol/src/constants.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const EVERY = PRICE_SAMPLE_EVERY_MS;
export const SIGN_SLACK_MS = 15000;
/** Protocol 5: a standing sample is served once every committee reading is in, or this long after its moment (all were posted). */
export const SERVE_AFTER_MS = 2500;
/** Protocol 5: a seat short of an end's readings asks the committee again at most this often. */
export const ASK_ENDS_EVERY_MS = 30000;
// THE TOLERANCE, 0.05 % (RULED 2026-10-14 ~21:50Z, interim D): at 0.5 % a seat signed any proposed price
// within about +-$408 of its own reading - more than BTC moves in a run - so the seat that proposed a sample chose BULLS, BEARS
// or FLAT (measured on rounds 6b51be20 / a45f2ae5: both ends the 15:36 close, $81,766.45, while the run traded $81,713-81,838).
// 0.05 % (about +-$41) narrows that choice until protocol 5 signs each seat's own reading and takes the median; a sample whose
// seats are further apart than this stays unsigned rather than signed at a price somebody chose.
export const DEFAULT_TOLERANCE = 0.0005;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const refuse = (why, status = 409) => ({ ok: false, status, why });
const NO_PROPOSAL = 'a round of protocol 5 takes no proposed price: each seat signs its own reading (POST /price-reading) and the sample is their median';
const roundOf = (body) => (body && typeof body.round === 'string' && /^[0-9a-f]{64}$/.test(body.round) ? fromHex(body.round) : null);
const grid = (ms) => Math.floor(ms / EVERY) * EVERY;
/** Sample k is applied at round time k x 5 s and reads the price one period before: round time (k - 1) x 5 s. */
export const readingMoment = (startMs, k) => startMs + (k - 1) * EVERY;
/** The round's closing sample: the last k whose tick is at or before `endTick`, its last tick. */
export function closeSampleK(endTick) {
  let k = Math.max(0, Math.floor(Number(msForTicks(BigInt(endTick)).ms) / EVERY));
  while (k > 0 && sampleTick(k) > endTick) k--;
  while (sampleTick(k + 1) <= endTick) k++;
  return k;
}

/**
 * BTC/USD FROM COINBASE'S EXCHANGE TICKER, WITH ITS TIME (interim B): the last trade's price and when it traded -
 * real time, where the consumer spot price (below) is cached and trailed the exchange by 5-20 s (measured 2026-10-14 21:41Z).
 * Answers { cents, atMs }.
 */
export async function exchangeTickerCents(fetcher = fetch) {
  const r = await fetcher('https://api.exchange.coinbase.com/products/BTC-USD/ticker', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`the ticker answered ${r.status}`);
  const j = await r.json();
  const cents = Math.round(Number(j && j.price) * 100);
  const atMs = Date.parse(j && j.time);
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('the ticker answered no price');
  if (!Number.isFinite(atMs)) throw new Error('the ticker answered no trade time');
  return { cents, atMs };
}

/** The default reading: the exchange ticker; the spot price only when the ticker does not answer (its age unknown: now). */
export async function coinbaseReading(fetcher = fetch) {
  try { return await exchangeTickerCents(fetcher); } catch { return { cents: await coinbaseCents(fetcher), atMs: Date.now() }; }
}

/** BTC/USD in whole cents from Coinbase's spot price - the fallback feed. */
export async function coinbaseCents(fetcher = fetch) {
  const r = await fetcher('https://api.coinbase.com/v2/prices/BTC-USD/spot', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`the feed answered ${r.status}`);
  const j = await r.json();
  const c = Math.round(Number(j && j.data && j.data.amount) * 100);
  if (!Number.isInteger(c) || c <= 0) throw new Error('the feed answered no price');
  return c;
}

export class PriceFeed {
  /**
   * `round`: the seat's Round (db, identity, get, openRounds). `priceRound(contract)`: whether that round plays against
   * the feed. `readPrice()`: cents, the seat's own read. `peersFor(roundIdBytes)`: the other seats' base URLs.
   */
  constructor(round, { priceRound = () => false, readPrice = () => coinbaseReading(), peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    now = () => Date.now(), tolerance = DEFAULT_TOLERANCE } = {}) {
    Object.assign(this, { round, priceRound, readPrice, peersFor, fetcher, now, tolerance });
    this.readings = new Map();   // grid ms -> cents, this seat's own
    this.samples = new Map();    // round hex -> Map(k -> { tick, priceCents, sigs })
    this.tapes = new Map();      // round hex -> { tick, prices, sigs }
    this.signed = new Map();     // `${round}:${k}` -> price this seat signed (one price per sample)
    // PROTOCOL 5: the committee's own signed readings
    this.heard = new Map();      // round hex -> Map(k -> Map(key hex -> [{ priceCents, signature }] - two only from a key that read twice))
    this.heardTapes = new Map(); // round hex -> Map(key hex -> [{ prices, signature }])
    this.mine = new Map();       // `${round}:${k}` / `${round}:tape` -> the reading this seat signed (one each)
    this.built = new Map();      // `${round}:${k}` -> the sample made of the readings held (dropped when one more comes)
    this.endsAsked = new Map();  // round hex -> when this seat last asked the committee for the ends' readings
    // the rounds' ENDS (sample 0 and the closing sample), kept across restarts in the seat's database
    this.ends = null;
    try {
      round.db.exec('CREATE TABLE IF NOT EXISTS price_ends (round TEXT NOT NULL, k INTEGER NOT NULL, tick INTEGER NOT NULL, cents INTEGER NOT NULL, sigs TEXT NOT NULL, PRIMARY KEY (round, k))');
      this.ends = {
        put: round.db.prepare('INSERT OR REPLACE INTO price_ends (round, k, tick, cents, sigs) VALUES (?, ?, ?, ?, ?)'),
        get: round.db.prepare('SELECT k, tick, cents, sigs FROM price_ends WHERE round = ? AND k = ?'),
      };
    } catch { this.ends = null; }   // a stand-in store without SQL: the ends live in memory only
  }

  /** Sample k of a round as held: in memory, else from the database. */
  #held(roundHex, k) {
    const m = this.samples.get(roundHex);
    if (m && m.has(k)) return m.get(k);
    if (!this.ends) return null;
    let r = null; try { r = this.ends.get.get(roundHex, k); } catch { r = null; }
    if (!r) return null;
    const x = { k: Number(r.k), tick: Number(r.tick), priceCents: Number(r.cents), sigs: JSON.parse(r.sigs) };
    if (!this.samples.has(roundHex)) this.samples.set(roundHex, new Map());
    this.samples.get(roundHex).set(k, x);
    return x;
  }

  /**
   * This seat's own reading for the moment `ms`, or null. NEVER OLDER THAN ONE PERIOD (interim C): only a reading
   * whose price was current within EVERY (5 s) of `ms` counts - the nearest such - so no stale price is vouched for; a seat
   * without one signs nothing for that moment.
   */
  ownAt(ms) {
    const g = grid(ms);
    let best = null;
    for (const at of [g, g - EVERY, g + EVERY]) {
      const r = this.readings.get(at);
      if (!r) continue;
      const d = Math.abs(r.atMs - ms);
      if (d <= EVERY && (!best || d < best.d)) best = { d, cents: r.cents };
    }
    return best ? best.cents : null;
  }

  async read() {
    const now = this.now();
    const at = grid(now);
    if (this.readings.has(at)) return this.readings.get(at).cents;
    let got = null;
    try { got = await this.readPrice(); } catch { got = null; }
    // a reader may answer cents (read now) or { cents, atMs } (the price's own time, the exchange ticker's last trade)
    const r = Number.isInteger(got) ? { cents: got, atMs: now } : got && Number.isInteger(got.cents) ? { cents: got.cents, atMs: Number(got.atMs) } : null;
    // a price already older than one period when it is read is no reading (interim C)
    const c = r && r.cents > 0 && Number.isFinite(r.atMs) && now - r.atMs <= EVERY ? r.cents : null;
    if (c !== null) this.readings.set(at, { cents: c, atMs: Math.min(r.atMs, now) });
    for (const k of [...this.readings.keys()].sort((a, b) => a - b).slice(0, Math.max(0, this.readings.size - 128))) this.readings.delete(k);
    return c;
  }

  #within(price, own) { return Number.isInteger(price) && Number.isInteger(own) && own > 0 && Math.abs(price - own) <= own * this.tolerance; }
  #contract(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this seat holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!this.priceRound(contract)) return refuse('that round does not play against the price feed');
    // a committee too small for the network's rule (a one-seat test round) needs every seat
    let needed; try { needed = receiptsNeeded(contract.nodes.length); } catch { needed = contract.nodes.length; }
    return { ok: true, contract, needed, committee: contract.nodes, median: mediansPrices(contract) };
  }
  #sign(id) { return { key: toHex(this.round.identity.pubkey || this.round.pubkey), signature: toHex(schnorr.sign(id, this.round.identity.secret)) }; }

  /** POST /price-sign: { round, kind: 'sample', k, priceCents } or { round, kind: 'tape', prices } - this seat's signature, or why not. */
  sign(body) {
    const rid = typeof body.round === 'string' && /^[0-9a-f]{64}$/.test(body.round) ? fromHex(body.round) : null;
    if (!rid) return refuse('a price ask names its round (64 hex)', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
    if (c.median) return refuse(NO_PROPOSAL);
    const start = Number(c.contract.startTimeMs);
    if (body.kind === 'tape') {
      if (!Array.isArray(body.prices) || body.prices.length !== PRICE_TAPE_LENGTH) return refuse(`a tape is ${PRICE_TAPE_LENGTH} prices`, 400);
      if (this.now() < start - EVERY - 1000 || this.now() > start + SIGN_SLACK_MS * 4) return refuse('a round\'s tape is signed at its start');
      let held = 0;
      for (let i = 0; i < PRICE_TAPE_LENGTH; i++) {
        const own = this.ownAt(start - (PRICE_TAPE_LENGTH - i) * EVERY);
        if (own === null) continue;
        held++;
        if (!this.#within(body.prices[i], own)) return refuse(`price ${i} of the tape is not what this seat read (${own} cents)`);
      }
      if (held < PRICE_TAPE_LENGTH / 2) return refuse(`this seat read ${held} of the tape's moments, too few to vouch for it`);
      const key = `${body.round}:tape`;
      const id = priceTapeId({ roundId: rid, tick: 0, prices: body.prices });
      if (this.signed.has(key) && this.signed.get(key) !== toHex(id)) return refuse('this seat signed another tape for that round');
      this.signed.set(key, toHex(id));
      return { ok: true, ...this.#sign(id) };
    }
    const k = Number(body.k);
    if (!Number.isInteger(k) || k < 0) return refuse('a sample names its k (0, 1, ... every 5 s of round time)', 400);
    const at = readingMoment(start, k);
    if (this.now() < at - 1000 || this.now() > at + SIGN_SLACK_MS) return refuse(`sample ${k} reads the price of ${new Date(at).toISOString()}, not now`);
    const own = this.ownAt(at);
    if (own === null) return refuse('this seat has no reading of its own for that moment');
    if (!this.#within(body.priceCents, own)) return refuse(`${body.priceCents} cents is not within ${this.tolerance * 100} % of this seat's reading, ${own}`);
    const key = `${body.round}:${k}`;
    if (this.signed.has(key) && this.signed.get(key) !== body.priceCents) return refuse('this seat signed another price for that sample');
    this.signed.set(key, body.priceCents);
    return { ok: true, ...this.#sign(priceSampleId({ roundId: rid, tick: sampleTick(k), priceCents: body.priceCents })) };
  }

  /** POST /price-attested: an attested sample or tape - kept once it stands with the round's committee. */
  hold(body) {
    const rid = typeof body.round === 'string' && /^[0-9a-f]{64}$/.test(body.round) ? fromHex(body.round) : null;
    if (!rid) return refuse('an attested price names its round (64 hex)', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
    if (c.median) return refuse(NO_PROPOSAL);
    if (body.kind === 'tape') {
      const t = { roundId: rid, tick: 0, prices: body.prices };
      let id; try { id = priceTapeId(t); } catch (e) { return refuse(e.message, 400); }
      const s = priceAttestationStands({ id, sigs: body.sigs, committee: c.committee, threshold: c.needed, verify });
      if (!s.ok) return refuse(`that tape does not stand: ${s.why}`);
      this.tapes.set(body.round, { tick: 0, prices: body.prices, sigs: body.sigs });
      return { ok: true };
    }
    const k = Number(body.k);
    const sample = { roundId: rid, tick: sampleTick(k), priceCents: body.priceCents };
    let id; try { id = priceSampleId(sample); } catch (e) { return refuse(e.message, 400); }
    const s = priceAttestationStands({ id, sigs: body.sigs, committee: c.committee, threshold: c.needed, verify });
    if (!s.ok) return refuse(`that sample does not stand: ${s.why}`);
    if (!this.samples.has(body.round)) this.samples.set(body.round, new Map());
    this.samples.get(body.round).set(k, { k, tick: sample.tick, priceCents: body.priceCents, sigs: body.sigs });
    if (this.ends && (k === 0 || k === closeSampleK(Number(c.contract.blockTicks)))) {
      try { this.ends.put.run(body.round, k, sample.tick, body.priceCents, JSON.stringify(body.sigs)); } catch { /* kept in memory */ }
    }
    return { ok: true };
  }

  /** The ends this seat lacks, from the committee's seats: each kept only once it stands (hold). */
  async #fetchEnds(roundIdBytes, ks) {
    const rh = toHex(roundIdBytes);
    for (const base of this.peersFor(roundIdBytes)) {
      const missing = ks.filter((k) => !this.#held(rh, k));
      if (!missing.length) return;
      try {
        const r = await this.fetcher(`${String(base).replace(/\/+$/, '')}/price-samples?round=${rh}&ks=${missing.join(',')}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        for (const x of (j && j.samples) || []) if (missing.includes(Number(x.k))) this.hold({ round: rh, kind: 'sample', k: Number(x.k), priceCents: x.priceCents, sigs: x.sigs });
      } catch { /* the next seat */ }
    }
  }

  /**
   * GET /round-result?round=: WHO WON THE ROUND (§13 RoundResult) - once its run has ended, the result this seat
   * makes from the round's two ends: sample 0 is the open, the closing sample (closeSampleK) the close. A seat that lacks one
   * asks the committee for it; without both it signs nothing, so no seat signs an open or close of its own choosing. Signed with
   * its node key; a client takes it when the committee's threshold signed the same result (round-result.js roundResultStands).
   */
  async result(roundHex) {
    const rid = typeof roundHex === 'string' && /^[0-9a-f]{64}$/.test(roundHex) ? fromHex(roundHex) : null;
    if (!rid) return refuse('GET /round-result?round=<id, 64 hex>', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
    const endTick = Number(c.contract.blockTicks);
    const endMs = Number(c.contract.startTimeMs) + Number(msForTicks(BigInt(endTick)).ms);
    if (this.now() < endMs) return refuse(`the round runs until ${new Date(endMs).toISOString()}: its result is made at its end`);
    const kClose = closeSampleK(endTick);
    if (c.median) return this.#result5(rid, roundHex, c, endTick, kClose);
    if (!this.#held(roundHex, 0) || !this.#held(roundHex, kClose)) await this.#fetchEnds(rid, [0, kClose]);
    const open = this.#held(roundHex, 0), close = this.#held(roundHex, kClose);
    if (!open || !close) return refuse(`no attested ${!open ? 'opening sample (k 0)' : `closing sample (k ${kClose})`} of the round is held here or by its committee`);
    const got = roundResultFrom({ roundId: rid, samples: [open, close], endTick });
    if (!got.ok) return refuse(got.why);
    const x = got.result;
    return { ok: true, round: roundHex, openCents: x.openCents, closeCents: x.closeCents, front: frontName(x.front), samples: got.samples,
      openTick: got.openTick, closeTick: got.closeTick, committee: c.committee.map(toHex), needed: c.needed, ...this.#sign(roundResultId(x)) };
  }

  /** GET /price-samples?round=&since=<tick>: the attested samples this seat holds for a round, and its tape; `ks` only those samples. */
  list(roundHex, sinceTick = 0, ks = null) {
    const c5 = this.#median(roundHex);
    if (c5) return this.#list5(roundHex, c5, sinceTick, ks);
    if (Array.isArray(ks)) return { round: roundHex, samples: ks.map((k) => this.#held(roundHex, k)).filter(Boolean), tape: null };
    const m = this.samples.get(roundHex);
    return { round: roundHex, samples: m ? [...m.values()].filter((x) => x.tick >= sinceTick).sort((a, b) => a.tick - b.tick) : [],
      tape: this.tapes.get(roundHex) || null };
  }

  async #ask(roundIdBytes, body) {
    const sigs = [];
    await Promise.all(this.peersFor(roundIdBytes).map(async (base) => {
      try {
        const r = await this.fetcher(`${String(base).replace(/\/+$/, '')}/price-sign`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        if (r.ok) { const j = await r.json(); if (j && j.key && j.signature) sigs.push({ key: j.key, signature: j.signature }); }
      } catch { /* that seat counts nothing */ }
    }));
    return sigs;
  }
  async #handOut(roundIdBytes, body) {
    await Promise.all(this.peersFor(roundIdBytes).map((base) => this.fetcher(`${String(base).replace(/\/+$/, '')}/price-attested`,
      { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => null)));
  }

  /** Lead sample k of a round (this seat is its leader): this seat's reading, the others' signatures, kept and handed out. */
  async leadSample(roundIdBytes, k) {
    const rh = toHex(roundIdBytes);
    const c = this.#contract(roundIdBytes); if (!c.ok) return c;
    const at = readingMoment(Number(c.contract.startTimeMs), k);
    const priceCents = this.ownAt(at);
    if (priceCents === null) return refuse('this seat has no reading for that moment');
    const own = this.sign({ round: rh, kind: 'sample', k, priceCents }); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }, ...await this.#ask(roundIdBytes, { round: rh, kind: 'sample', k, priceCents })];
    const held = this.hold({ round: rh, kind: 'sample', k, priceCents, sigs });
    if (!held.ok) return held;
    await this.#handOut(roundIdBytes, { round: rh, kind: 'sample', k, priceCents, sigs });
    return { ok: true, k, priceCents, signed: sigs.length };
  }

  async leadTape(roundIdBytes) {
    const rh = toHex(roundIdBytes);
    const c = this.#contract(roundIdBytes); if (!c.ok) return c;
    const start = Number(c.contract.startTimeMs);
    const prices = [];
    for (let i = 0; i < PRICE_TAPE_LENGTH; i++) prices.push(this.ownAt(start - (PRICE_TAPE_LENGTH - i) * EVERY));
    // A MOMENT THIS SEAT DID NOT READ STAYS UNREAD (interim C): it is not filled with an older price - the tape goes
    // out only when this seat read every moment; the other seats vouch for the moments they read (sign: at least half)
    if (prices.some((p) => p === null)) return refuse('this seat did not read every moment before the start, and fills none with an older price');
    const own = this.sign({ round: rh, kind: 'tape', prices }); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }, ...await this.#ask(roundIdBytes, { round: rh, kind: 'tape', prices })];
    const held = this.hold({ round: rh, kind: 'tape', prices, sigs });
    if (!held.ok) return held;
    await this.#handOut(roundIdBytes, { round: rh, kind: 'tape', prices, sigs });
    return { ok: true, signed: sigs.length };
  }

  /**
   * THE OPEN PRICE ROUNDS, EACH CONTRACT DECODED ONCE (2026-10-15: "Do everything you can to lower the load"; profiled on
   * a testnet4 seat: the beat was 13.8 % of its main thread - every 5 s it read every open round's contract out of the store and
   * decoded it twice, the 8 s grids' thousands of rounds, to find the few that play against the price). A round's contract never
   * changes: the open ids are read (no contract), a round seen for the first time is decoded once and remembered as a price round
   * or not, and a round no longer open is forgotten.
   */
  #openPriceRounds() {
    if (!this.kept) this.kept = new Map();       // round hex -> its contract when a price round, else null
    const ids = typeof this.round.openRoundIds === 'function' ? this.round.openRoundIds() : this.round.openRounds().map((r) => r.roundId);
    const open = new Set();
    const out = [];
    for (const id of ids) {
      const rh = toHex(id);
      open.add(rh);
      if (!this.kept.has(rh)) {
        let contract = null;
        try { const row = this.round.get(id); if (row) contract = decodeRoundContract(new Uint8Array(row.contract)); } catch { contract = null; }
        this.kept.set(rh, contract && this.priceRound(contract) ? contract : null);
      }
      const c = this.kept.get(rh);
      if (c) out.push({ roundId: id, contract: c });
    }
    for (const rh of this.kept.keys()) if (!open.has(rh)) this.kept.delete(rh);
    return out;
  }

  /** One beat of the timer (every 5 s): read the feed; lead the samples (and the tape) this seat leads in its open price rounds. */
  async beat() {
    await this.read();
    const now = this.now();
    const out = [];
    for (const r of this.#openPriceRounds()) {
      const contract = r.contract;
      const start = Number(contract.startTimeMs);
      if (now < start - EVERY) continue;   // the tape and sample 0 go out a period before the start
      const rh = toHex(r.roundId);
      const n = contract.nodes.length;
      const me = toHex(this.round.identity.pubkey || this.round.pubkey);
      if (mediansPrices(contract)) { out.push(...await this.#beat5(r.roundId, contract, now, me)); continue; }
      if (!this.tapes.has(rh) && toHex(contract.nodes[0]) === me) out.push(['tape', await this.leadTape(r.roundId).catch((e) => refuse(e.message))]);
      const k = Math.floor((now - start) / EVERY) + 1;   // the next sample: one period ahead of its tick
      const m = this.samples.get(rh);
      if (!(m && m.has(k)) && toHex(contract.nodes[k % n]) === me) out.push([k, await this.leadSample(r.roundId, k).catch((e) => refuse(e.message))]);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // PROTOCOL 5: THE MEDIAN OF SIGNED READINGS

  /** The round's contract facts when it is held, a price round and of protocol 5 - else null. */
  #median(roundHex) {
    if (typeof roundHex !== 'string' || !/^[0-9a-f]{64}$/.test(roundHex)) return null;
    let c; try { c = this.#contract(fromHex(roundHex)); } catch { return null; }
    return c.ok && c.median ? c : null;
  }

  /** This seat's own signed reading of sample k: signed once, at its moment, of its own reading only. */
  ownReading(roundIdBytes, k) {
    const c = this.#contract(roundIdBytes); if (!c.ok) return c;
    if (!c.median) return refuse('that round plays proposed samples: a signed reading is a protocol 5 price');
    const rh = toHex(roundIdBytes);
    const mine = this.mine.get(`${rh}:${k}`);
    if (mine) return { ok: true, ...mine };
    const at = readingMoment(Number(c.contract.startTimeMs), k);
    if (this.now() < at - 1000 || this.now() > at + SIGN_SLACK_MS) return refuse(`sample ${k} reads the price of ${new Date(at).toISOString()}, not now`);
    const priceCents = this.ownAt(at);
    if (priceCents === null) return refuse('this seat has no reading of its own for that moment');
    const r = { round: rh, kind: 'sample', k, priceCents, ...this.#sign(priceReadingId({ roundId: roundIdBytes, tick: sampleTick(k), priceCents })) };
    this.mine.set(`${rh}:${k}`, r);
    return { ok: true, ...r };
  }

  /** This seat's own signed tape: its readings of the 64 moments before the start, signed once - only when it read every one. */
  ownTapeReading(roundIdBytes) {
    const c = this.#contract(roundIdBytes); if (!c.ok) return c;
    if (!c.median) return refuse('that round plays proposed samples: a signed reading is a protocol 5 price');
    const rh = toHex(roundIdBytes);
    const mine = this.mine.get(`${rh}:tape`);
    if (mine) return { ok: true, ...mine };
    const start = Number(c.contract.startTimeMs);
    if (this.now() < start - EVERY - 1000 || this.now() > start + SIGN_SLACK_MS * 4) return refuse('a round\'s tape is signed at its start');
    const prices = [];
    for (let i = 0; i < PRICE_TAPE_LENGTH; i++) prices.push(this.ownAt(start - (PRICE_TAPE_LENGTH - i) * EVERY));
    if (prices.some((p) => p === null)) return refuse('this seat did not read every moment before the start, and fills none with an older price');
    const r = { round: rh, kind: 'tape', prices, ...this.#sign(priceTapeReadingId({ roundId: roundIdBytes, tick: 0, prices })) };
    this.mine.set(`${rh}:tape`, r);
    return { ok: true, ...r };
  }

  /**
   * POST /price-reading: one seat's own signed reading - { round, kind: 'sample', k, priceCents, key, signature } or { round,
   * kind: 'tape', prices, key, signature } - kept when its key is of the round's committee and it verifies. A second, different
   * reading by one key of one sample is kept beside the first, and that key then counts for neither.
   */
  reading(body, persist = true) {
    const rid = roundOf(body);
    if (!rid) return refuse('a reading names its round (64 hex)', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
    if (!c.median) return refuse('that round plays proposed samples: a signed reading is a protocol 5 price');
    const rh = body.round;
    const key = typeof body.key === 'string' ? body.key.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(key) || !c.committee.some((m) => toHex(m) === key)) return refuse('a reading is signed by a key of the round\'s committee');
    const signature = typeof body.signature === 'string' && /^[0-9a-f]{128}$/i.test(body.signature) ? body.signature.toLowerCase() : null;
    if (!signature) return refuse('a reading carries its 64-byte signature (128 hex)', 400);
    const tape = body.kind === 'tape';
    const k = tape ? null : Number(body.k);
    const kMax = closeSampleK(Number(c.contract.blockTicks));
    if (!tape && !(Number.isInteger(k) && k >= 0 && k <= kMax)) return refuse(`a reading names its sample, k 0..${kMax}`, 400);
    let id;
    try { id = tape ? priceTapeReadingId({ roundId: rid, tick: 0, prices: body.prices }) : priceReadingId({ roundId: rid, tick: sampleTick(k), priceCents: body.priceCents }); }
    catch (e) { return refuse(e.message, 400); }
    if (!verify(fromHex(signature), id, fromHex(key))) return refuse('that reading does not verify');
    const r = tape ? { prices: body.prices.slice(), signature } : { priceCents: body.priceCents, signature };
    const byKey = tape ? this.#tapeHeard(rh) : this.#heardAt(rh, k);
    const list = byKey.get(key) || [];
    if (list.some((x) => x.signature === signature || (tape ? x.prices.every((p, i) => p === r.prices[i]) : x.priceCents === r.priceCents))) return { ok: true, kept: false };
    if (list.length >= 2) return { ok: true, kept: false };   // a key that read twice counts for none already
    byKey.set(key, [...list, r]);
    this.built.delete(`${rh}:${tape ? 'tape' : k}`);
    if (!tape && persist && this.ends && (k === 0 || k === kMax)) {
      const s = this.#sample5(rh, rid, k, c);
      try { this.ends.put.run(rh, k, sampleTick(k), s ? s.priceCents : 0, JSON.stringify(this.#allReadings(rh, k))); } catch { /* kept in memory */ }
    }
    return { ok: true, kept: true };
  }

  #tapeHeard(rh) { if (!this.heardTapes.has(rh)) this.heardTapes.set(rh, new Map()); return this.heardTapes.get(rh); }
  /** The readings held of sample k - from memory, else (an end) from the database, each checked again as it is read back. */
  #heardAt(rh, k) {
    if (!this.heard.has(rh)) this.heard.set(rh, new Map());
    const m = this.heard.get(rh);
    if (m.has(k)) return m.get(k);
    m.set(k, new Map());
    if (this.ends) {
      let row = null; try { row = this.ends.get.get(rh, k); } catch { row = null; }
      if (row) for (const x of JSON.parse(row.sigs)) this.reading({ round: rh, kind: 'sample', k, priceCents: x.priceCents, key: x.key, signature: x.signature }, false);
    }
    return m.get(k);
  }
  #allReadings(rh, k) {
    const out = [];
    for (const [key, list] of this.#heardAt(rh, k)) for (const x of list) out.push({ key, priceCents: x.priceCents, signature: x.signature });
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  // the readings that count: one a key, from keys that read once; sorted by key, so every seat writes them the same way
  #counted(byKey, own) {
    return [...byKey].filter(([, list]) => list.length === 1).map(([key, [x]]) => ({ key, ...own(x), signature: x.signature }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  /** Sample k as the readings held make it: { k, tick, priceCents (their median), readings } once `needed` keys read it, else null. */
  #sample5(rh, rid, k, c) {
    const at = `${rh}:${k}`;
    if (this.built.has(at)) return this.built.get(at);
    const readings = this.#counted(this.#heardAt(rh, k), (x) => ({ priceCents: x.priceCents }));
    const s = readings.length >= c.needed ? { k, tick: sampleTick(k), priceCents: medianOf(readings.map((x) => x.priceCents)), readings } : null;
    this.built.set(at, s);
    return s;
  }
  #tape5(rh, c) {
    const at = `${rh}:tape`;
    if (this.built.has(at)) return this.built.get(at);
    const readings = this.#counted(this.#tapeHeard(rh), (x) => ({ prices: x.prices }));
    const t = readings.length >= c.needed
      ? { tick: 0, prices: Array.from({ length: PRICE_TAPE_LENGTH }, (_, i) => medianOf(readings.map((x) => x.prices[i]))), readings } : null;
    this.built.set(at, t);
    return t;
  }

  #list5(rh, c, sinceTick, ks) {
    const rid = fromHex(rh);
    if (Array.isArray(ks)) {
      return { round: rh, samples: ks.map((k) => {
        const all = this.#allReadings(rh, k);
        if (!all.length) return null;
        const s = this.#sample5(rh, rid, k, c);
        return { k, tick: sampleTick(k), priceCents: s ? s.priceCents : null, readings: all };
      }).filter(Boolean), tape: null };
    }
    // a standing sample is served once the whole committee's readings are in, or SERVE_AFTER_MS after its moment
    const start = Number(c.contract.startTimeMs), n = c.committee.length, now = this.now();
    const served = (count, moment) => count >= n || now >= moment + SERVE_AFTER_MS;
    const samples = [];
    for (const k of [...(this.heard.get(rh) || new Map()).keys()].sort((a, b) => a - b)) {
      if (sampleTick(k) < sinceTick) continue;
      const s = this.#sample5(rh, rid, k, c);
      if (s && served(s.readings.length, readingMoment(start, k))) samples.push(s);
    }
    const t = this.#tape5(rh, c);
    return { round: rh, samples, tape: t && served(t.readings.length, start - EVERY) ? t : null };
  }

  /** Every reading of samples `ks` the committee's seats hold, taken as each verifies - asked of every seat until all are in. */
  async #fetchReadings(roundIdBytes, ks, c) {
    const rh = toHex(roundIdBytes);
    for (const base of this.peersFor(roundIdBytes)) {
      const short = ks.filter((k) => this.#heardAt(rh, k).size < c.committee.length);
      if (!short.length) return;
      try {
        const r = await this.fetcher(`${String(base).replace(/\/+$/, '')}/price-samples?round=${rh}&ks=${short.join(',')}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        for (const x of (j && j.samples) || []) {
          if (!short.includes(Number(x.k))) continue;
          for (const y of x.readings || []) this.reading({ round: rh, kind: 'sample', k: Number(x.k), priceCents: y.priceCents, key: y.key, signature: y.signature });
        }
      } catch { /* the next seat */ }
    }
  }

  async #result5(rid, rh, c, endTick, kClose) {
    const short = [0, kClose].some((k) => this.#heardAt(rh, k).size < c.committee.length);
    if (short && !(this.now() - (this.endsAsked.get(rh) ?? -Infinity) < ASK_ENDS_EVERY_MS)) {
      this.endsAsked.set(rh, this.now());
      await this.#fetchReadings(rid, [0, kClose], c);
    }
    const open = this.#sample5(rh, rid, 0, c), close = this.#sample5(rh, rid, kClose, c);
    if (!open || !close) return refuse(`no ${!open ? 'opening sample (k 0)' : `closing sample (k ${kClose})`} of the round stands: fewer than ${c.needed} of the committee's readings are held here or by its committee`);
    const got = roundResultFromReadings({ roundId: rid, open: { tick: open.tick, readings: open.readings }, close: { tick: close.tick, readings: close.readings },
      endTick, committee: c.committee, threshold: c.needed, verify });
    if (!got.ok) return refuse(got.why);
    const x = got.result;
    return { ok: true, round: rh, openCents: x.openCents, closeCents: x.closeCents, front: frontName(x.front), samples: got.samples, readings: got.readings,
      openTick: got.openTick, closeTick: got.closeTick, committee: c.committee.map(toHex), needed: c.needed, ...this.#sign(roundResultId(x)) };
  }

  async #post(roundIdBytes, body) {
    await Promise.all(this.peersFor(roundIdBytes).map((base) => this.fetcher(`${String(base).replace(/\/+$/, '')}/price-reading`,
      { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => null)));
  }

  /** One beat for a protocol-5 round: this seat's own tape (once, at the start) and its own reading of the next sample, posted. */
  async #beat5(rid, contract, now, me) {
    if (!contract.nodes.some((k) => toHex(k) === me)) return [];   // only the committee reads for the round
    const rh = toHex(rid), start = Number(contract.startTimeMs), out = [];
    const send = async (got) => {
      if (!got.ok) return got;
      const { ok, ...body } = got;
      const kept = this.reading(body);
      if (!kept.ok) return kept;
      await this.#post(rid, body);
      return { ok: true, ...(body.kind === 'tape' ? {} : { priceCents: body.priceCents }) };
    };
    if (!this.mine.has(`${rh}:tape`) && now <= start + SIGN_SLACK_MS * 4) out.push(['tape', await send(this.ownTapeReading(rid)).catch((e) => refuse(e.message))]);
    const k = Math.floor((now - start) / EVERY) + 1;
    if (k <= closeSampleK(Number(contract.blockTicks)) && !this.mine.has(`${rh}:${k}`)) out.push([k, await send(this.ownReading(rid, k)).catch((e) => refuse(e.message))]);
    return out;
  }
}
