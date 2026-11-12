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
//         The ask carries the leader's own signature of the sample (`leaderSig`); a seat signs only an ask its leader signed
//         (kanban #1181: any caller could ask every seat first with a price within tolerance, collect a threshold, and choose
//         BULLS, BEARS or FLAT; the real leader was then refused).
//   SIGN. A seat signs only a sample of a round it holds, whose moment is now (within SIGN_SLACK_MS), at the tick that moment
//         names, and whose price is within `tolerance` of its OWN reading at that moment - so no seat can pick the price,
//         only report one the others saw too. It signs one price per (round, k): a second, different ask is refused - and that
//         one price is written to its database before the signature leaves it (kanban #1181), so a restart signs no second one.
//   HOLD. With the threshold of the committee's signatures (receiptsNeeded) the leader hands the attested sample to every
//         seat (POST /price-attested); each checks it stands before keeping it, and keeps the FIRST that stands per (round, k):
//         a second attested sample or tape of the same moment is refused (kanban #1181: INSERT OR REPLACE let a later one replace
//         it). GET /price-samples serves what a seat holds.
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
import { durably } from './store.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { priceSampleId, priceTapeId, priceAttestationStands, sampleTick, PRICE_SAMPLE_EVERY_MS, PRICE_TAPE_LENGTH,
  priceReadingId, priceTapeReadingId, medianOf } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { roundResultFrom, roundResultFromReadings, roundResultId, frontName } from '../../arena-protocol/src/round-result.js';
import { mediansPrices } from '../../arena-protocol/src/constants.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { OBJECTION_WINDOW_MS } from '../../arena-protocol/src/window.js';
import { CLOSED } from './store.js';

const EVERY = PRICE_SAMPLE_EVERY_MS;
export const SIGN_SLACK_MS = 15000;
/** Protocol 5: a standing sample is served once every committee reading is in, or this long after its moment (all were posted). */
export const SERVE_AFTER_MS = 2500;
/** Protocol 5: a seat short of an end's readings asks the committee again at most this often. */
export const ASK_ENDS_EVERY_MS = 30000;
/** Protocol 5: a seat that has signed no result of a round yet asks the committee again for both ends, and the results they signed, at
 *  most this often (kanban #1693 / #1759 / #1804). */
export const ASK_RESULTS_EVERY_MS = 5000;
/** The held maps' sizes are logged at most this often (kanban #742: the before/after on the live seats). */
export const HELD_LOG_EVERY_MS = 600000;
// THE TOLERANCE, 0.05 % (RULED 2026-10-14 ~21:50Z, interim D): at 0.5 % a seat signed any proposed price
// within about +-$408 of its own reading - more than BTC moves in a run - so the seat that proposed a sample chose BULLS, BEARS
// or FLAT (measured on rounds 6b51be20 / a45f2ae5: both ends the 15:36 close, $81,766.45, while the run traded $81,713-81,838).
// 0.05 % (about +-$41) narrows that choice until protocol 5 signs each seat's own reading and takes the median; a sample whose
// seats are further apart than this stays unsigned rather than signed at a price somebody chose.
export const DEFAULT_TOLERANCE = 0.0005;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const refuse = (why, status = 409) => ({ ok: false, status, why });
const NO_PROPOSAL = 'a round of protocol 5 takes no proposed price: each seat signs its own reading (POST /price-reading) and the sample is their median';
/**
 * A LEGACY SAMPLE'S STATE AT THIS SEAT (kanban #1181), per (round, k) and per round's tape, one transition function:
 *   SIGNED  this seat signed one value (a price, or a tape's id): the same value is signed again, another is refused
 *   HELD    an attested one stands and is kept: another of the same moment is refused, the same is taken again
 * `x` { signed, held } (each the value or null); `ev` { kind: 'sign' | 'hold', value }. Answers { ok, x, again } or { ok: false, why }.
 */
export const LEGACY_SAMPLE_STATE = Object.freeze({ SIGNED: 'SIGNED', HELD: 'HELD' });
export function legacySampleStep(x, ev) {
  const was = x || { signed: null, held: null };
  const v = String(ev.value);
  if (ev.kind === 'sign') {
    if (was.signed !== null && was.signed !== undefined) return String(was.signed) === v ? { ok: true, x: was, again: true } : { ok: false, why: 'this seat signed another value for that moment' };
    return { ok: true, x: { ...was, signed: v } };
  }
  if (ev.kind === 'hold') {
    if (was.held !== null && was.held !== undefined) return String(was.held) === v ? { ok: true, x: was, again: true } : { ok: false, why: 'another attested value of that moment is held here: the first stands' };
    return { ok: true, x: { ...was, held: v } };
  }
  return { ok: false, why: 'no such step' };
}
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
    now = () => Date.now(), tolerance = DEFAULT_TOLERANCE, log = (line) => console.log(line) } = {}) {
    Object.assign(this, { round, priceRound, readPrice, peersFor, fetcher, now, tolerance, log });
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
    // every map above but `readings` is let go of a round once it is finished (tidy, kanban #742)
    this.evicted = 0;            // rounds let go of since the last held line
    this.heldLoggedAt = null;
    // the rounds' ENDS (sample 0 and the closing sample), kept across restarts in the seat's database
    this.ends = null;
    try {
      round.db.exec('CREATE TABLE IF NOT EXISTS price_ends (round TEXT NOT NULL, k INTEGER NOT NULL, tick INTEGER NOT NULL, cents INTEGER NOT NULL, sigs TEXT NOT NULL, PRIMARY KEY (round, k))');
      this.ends = {
        put: round.db.prepare('INSERT OR REPLACE INTO price_ends (round, k, tick, cents, sigs) VALUES (?, ?, ?, ?, ?)'),
        get: round.db.prepare('SELECT k, tick, cents, sigs FROM price_ends WHERE round = ? AND k = ?'),
        // a legacy end is kept first-wins (kanban #1181); protocol 5's `put` replaces as more readings come
        putFirst: round.db.prepare('INSERT OR IGNORE INTO price_ends (round, k, tick, cents, sigs) VALUES (?, ?, ?, ?, ?)'),
      };
      // WHAT THIS SEAT SIGNED, per (round, k) or (round, 'tape') - written before the signature leaves it (kanban #1181)
      round.db.exec('CREATE TABLE IF NOT EXISTS price_signed (round TEXT NOT NULL, slot TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (round, slot))');
      this.signedDb = {
        get: round.db.prepare('SELECT value FROM price_signed WHERE round = ? AND slot = ?'),
        // what this seat signed is on the disk before the signature leaves it (kanban #1243)
        put: (() => { const st = round.db.prepare('INSERT OR IGNORE INTO price_signed (round, slot, value) VALUES (?, ?, ?)'); return { run: (...a) => durably(round.db, () => st.run(...a)) }; })(),
        drop: round.db.prepare('DELETE FROM price_signed WHERE round = ?'),
      };
    } catch { this.ends = null; this.signedDb = null; }   // a stand-in store without SQL: the ends live in memory only
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
    let needed; try { needed = receiptsNeeded(contract.gameVerifySlots); } catch { needed = contract.nodes.length; }
    return { ok: true, contract, needed, committee: contract.nodes, median: mediansPrices(contract) };
  }
  #sign(id) { return { key: toHex(this.round.identity.pubkey || this.round.pubkey), signature: toHex(schnorr.sign(id, this.round.identity.secret)) }; }

  /**
   * POST /price-sign: { round, kind: 'sample', k, priceCents, leaderSig } or { round, kind: 'tape', prices, leaderSig } - this seat's
   * signature, or why not. Only an ask the moment's LEADER signed (kanban #1181): sample k's leader is the round's seat k mod n, the
   * tape's its seat 0, and `leaderSig` is the leader's own BIP340 signature of the sample's (tape's) id. The leader signs its own
   * sample itself (leadSample), never at this door: a stranger's ask first would pin the leader to his price.
   */
  sign(body) { return this.#signAsk(body, { leading: false }); }
  /** What this seat signed for (round, slot): from memory, else from its database. */
  #signedOf(roundHex, slot) {
    const key = `${roundHex}:${slot}`;
    if (this.signed.has(key)) return this.signed.get(key);
    if (!this.signedDb) return null;
    let r = null; try { r = this.signedDb.get.get(roundHex, String(slot)); } catch { r = null; }
    if (!r) return null;
    const v = slot === 'tape' || slot === 'result5' ? r.value : Number(r.value);   // the round's one result is kept as JSON (kanban #1375)
    this.signed.set(key, v);
    return v;
  }
  /** One 'sign' step, kept in the database (compare-and-set: a row there with another value refuses) before the signature is made. */
  #stepSign(roundHex, slot, value) {
    const had = this.#signedOf(roundHex, slot);
    const s = legacySampleStep({ signed: had, held: null }, { kind: 'sign', value });
    if (!s.ok || s.again) return s;
    if (this.signedDb) {
      let ch = 0; try { ch = this.signedDb.put.run(roundHex, String(slot), String(value)).changes; } catch { ch = 0; }
      if (ch !== 1) { this.signed.delete(`${roundHex}:${slot}`); const now = this.#signedOf(roundHex, slot); if (String(now) !== String(value)) return { ok: false, why: 'this seat signed another value for that moment' }; }
    }
    this.signed.set(`${roundHex}:${slot}`, value);
    return s;
  }
  #signAsk(body, { leading }) {
    const rid = typeof body.round === 'string' && /^[0-9a-f]{64}$/.test(body.round) ? fromHex(body.round) : null;
    if (!rid) return refuse('a price ask names its round (64 hex)', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
    if (c.median) return refuse(NO_PROPOSAL);
    const start = Number(c.contract.startTimeMs);
    const me = toHex(this.round.identity.pubkey || this.round.pubkey);
    // THE LEADER'S OWN SIGNATURE ON THE ASK (kanban #1181): checked before anything is signed or written
    const leaderOk = (leader, id) => {
      if (leading) return toHex(leader) === me ? null : refuse('this seat does not lead that moment');
      if (toHex(leader) === me) return refuse('this seat leads that moment: it signs its own reading when it leads, never an ask');
      const sig = typeof body.leaderSig === 'string' && /^[0-9a-f]{128}$/.test(body.leaderSig) ? fromHex(body.leaderSig) : null;
      if (!sig) return refuse('a price ask carries its leader\'s signature (leaderSig, 128 hex)', 400);
      return verify(sig, id, leader) ? null : refuse('that ask is not signed by the leader of its moment', 403);
    };
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
      let id; try { id = priceTapeId({ roundId: rid, tick: 0, prices: body.prices }); } catch (e) { return refuse(e.message, 400); }
      const lead = leaderOk(c.contract.nodes[0], id); if (lead) return lead;
      const st = this.#stepSign(body.round, 'tape', toHex(id));
      if (!st.ok) return refuse('this seat signed another tape for that round');
      return { ok: true, ...this.#sign(id) };
    }
    const k = Number(body.k);
    if (!Number.isInteger(k) || k < 0) return refuse('a sample names its k (0, 1, ... every 5 s of round time)', 400);
    if (!Number.isInteger(body.priceCents) || body.priceCents <= 0) return refuse('a sample names its price in whole cents', 400);
    const sid = priceSampleId({ roundId: rid, tick: sampleTick(k), priceCents: body.priceCents });
    const lead = leaderOk(c.contract.nodes[k % c.contract.nodes.length], sid); if (lead) return lead;
    const at = readingMoment(start, k);
    if (this.now() < at - 1000 || this.now() > at + SIGN_SLACK_MS) return refuse(`sample ${k} reads the price of ${new Date(at).toISOString()}, not now`);
    const own = this.ownAt(at);
    if (own === null) return refuse('this seat has no reading of its own for that moment');
    if (!this.#within(body.priceCents, own)) return refuse(`${body.priceCents} cents is not within ${this.tolerance * 100} % of this seat's reading, ${own}`);
    const st = this.#stepSign(body.round, k, body.priceCents);
    if (!st.ok) return refuse('this seat signed another price for that sample');
    return { ok: true, ...this.#sign(sid) };
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
      // THE FIRST TAPE THAT STANDS IS KEPT (kanban #1181): another is refused, the same is taken again
      const had = this.tapes.get(body.round);
      const step = legacySampleStep({ signed: null, held: had ? toHex(priceTapeId({ roundId: rid, tick: 0, prices: had.prices })) : null }, { kind: 'hold', value: toHex(id) });
      if (!step.ok) return refuse(step.why);
      if (!step.again) this.tapes.set(body.round, { tick: 0, prices: body.prices, sigs: body.sigs });
      return { ok: true };
    }
    const k = Number(body.k);
    const sample = { roundId: rid, tick: sampleTick(k), priceCents: body.priceCents };
    let id; try { id = priceSampleId(sample); } catch (e) { return refuse(e.message, 400); }
    const s = priceAttestationStands({ id, sigs: body.sigs, committee: c.committee, threshold: c.needed, verify });
    if (!s.ok) return refuse(`that sample does not stand: ${s.why}`);
    // THE FIRST SAMPLE THAT STANDS IS KEPT, per (round, k) (kanban #1181): in memory, and an end in the database first-wins
    const had = this.#held(body.round, k);
    const step = legacySampleStep({ signed: null, held: had ? had.priceCents : null }, { kind: 'hold', value: body.priceCents });
    if (!step.ok) return refuse(step.why);
    if (step.again) return { ok: true };
    if (this.ends && (k === 0 || k === closeSampleK(Number(c.contract.blockTicks)))) {
      let ch = 1; try { ch = this.ends.putFirst.run(body.round, k, sample.tick, body.priceCents, JSON.stringify(body.sigs)).changes; } catch { ch = 1; /* kept in memory */ }
      if (ch !== 1) return refuse('another attested value of that moment is held here: the first stands');
    }
    if (!this.samples.has(body.round)) this.samples.set(body.round, new Map());
    this.samples.get(body.round).set(k, { k, tick: sample.tick, priceCents: body.priceCents, sigs: body.sigs });
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
    const own = this.#signAsk({ round: rh, kind: 'sample', k, priceCents }, { leading: true }); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }, ...await this.#ask(roundIdBytes, { round: rh, kind: 'sample', k, priceCents, leaderSig: own.signature })];
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
    const own = this.#signAsk({ round: rh, kind: 'tape', prices }, { leading: true }); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }, ...await this.#ask(roundIdBytes, { round: rh, kind: 'tape', prices, leaderSig: own.signature })];
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
   * or not, and a round no longer open is forgotten. And the list itself is read again only once a round opened, closed or had its
   * contract changed (round.openSeq; kanban #576, profiled 2026-10-21 23:1xZ on a test host seat: reading the ~4,560 open ids every
   * beat was 6.7 % of its main thread, a fifth of its busy time, while the open set had not moved).
   */
  #openPriceRounds() {
    if (!this.kept) this.kept = new Map();       // round hex -> its contract when a price round, else null
    const seq = this.round.openSeq;
    if (seq !== undefined && this.keptSeq === seq && this.keptOut) return this.keptOut;
    // THE STORE'S OWN KEPT OPEN LIST AND DECODED CONTRACTS where it has them (kanban #742): the same id objects and their hex, and no
    // contract decoded a second time beside the one the store keeps
    const shared = typeof this.round.openHeld === 'function' && typeof this.round.contractOf === 'function';
    const ids = shared ? this.round.openHeld() : typeof this.round.openRoundIds === 'function' ? this.round.openRoundIds() : this.round.openRounds().map((r) => r.roundId);
    const open = new Set();
    const out = [];
    for (const id of ids) {
      const rh = shared ? this.round.hexOf(id) : toHex(id);
      open.add(rh);
      if (!this.kept.has(rh)) {
        let contract = null;
        try { if (shared) contract = this.round.contractOf(id); else { const row = this.round.get(id); if (row) contract = decodeRoundContract(new Uint8Array(row.contract)); } } catch { contract = null; }
        this.kept.set(rh, contract && this.priceRound(contract) ? contract : null);
      }
      const c = this.kept.get(rh);
      if (c) out.push({ roundId: id, contract: c });
    }
    for (const rh of this.kept.keys()) if (!open.has(rh)) this.kept.delete(rh);
    this.keptSeq = seq; this.keptOut = out;
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

  /**
   * WHEN A ROUND IS FINISHED FOR THE FEED (kanban #742: every seat's heap reached 1,024 MB about hourly - the per-round maps
   * here kept every price round's samples, readings and signatures forever). Closed on this seat, past its end, and past its
   * objection window after both: max(closed, end) + W, as transcript-prune.js counts a round's close and its window
   * (end: first-mark.js roundEndMs, the end the close sweep closes it at; W: the contract's objectionWindowMs). By then no run
   * plays (a closed round takes no entry and beat leads nothing in it), no sample or reading can be signed (each only within
   * SIGN_SLACK_MS of a moment before the end), and what is still read of it - GET /round-result and GET /price-samples?ks= of
   * its two ends, asked by clients, markets and seats short of an end - comes from the database (price_ends), which #held and
   * #heardAt read back. A round no longer held at all is finished too: every read of it refuses.
   */
  #finished(rh, now) {
    let row;
    try { row = this.round.get(fromHex(rh)); } catch { return false; }
    if (!row) return true;
    if (row.state !== CLOSED || row.closed_ms === null || row.closed_ms === undefined) return false;
    let contract; try { contract = decodeRoundContract(new Uint8Array(row.contract)); } catch { return false; }
    let end = 0; try { end = Number(roundEndMs(contract)); } catch { end = 0; }
    const w = contract.objectionWindowMs !== undefined ? Number(contract.objectionWindowMs) : OBJECTION_WINDOW_MS;
    return now >= Math.max(Number(row.closed_ms), end) + w;
  }

  /** The sizes held now: per map, the rounds in it (and the entries inside, for the maps of maps). */
  heldSizes() {
    const inner = (m) => { let n = 0; for (const x of m.values()) n += x.size; return n; };
    return { samples: this.samples.size, sampleEntries: inner(this.samples), tapes: this.tapes.size, signed: this.signed.size,
      heard: this.heard.size, heardSamples: inner(this.heard), heardTapes: this.heardTapes.size, mine: this.mine.size,
      built: this.built.size, endsAsked: this.endsAsked.size };
  }

  /**
   * LET GO OF THE FINISHED ROUNDS (kanban #742): every entry of a round past #finished leaves every per-round map - samples,
   * tapes, signed, heard, heardTapes, mine, built, endsAsked. Without a database the ends live in memory only, so nothing is let
   * go of. A read after that (an end asked again) is answered from the database and held again until the next tidy. Logs the
   * sizes at most every HELD_LOG_EVERY_MS. Answers the rounds let go of.
   */
  // the per-round maps of the results (kanban #1375, #1693 / #1759 / #1804), made only once a result is asked of
  #resultMaps() { return [this.firstResultAsk, this.peerResults, this.resultSigs].filter(Boolean); }
  tidy() {
    const now = this.now();
    const gone = new Set();
    if (this.ends) {
      const rounds = new Set();
      for (const m of [this.samples, this.tapes, this.heard, this.heardTapes, this.endsAsked, ...this.#resultMaps()]) for (const rh of m.keys()) rounds.add(rh);
      for (const m of [this.signed, this.mine, this.built]) for (const key of m.keys()) rounds.add(key.slice(0, 64));
      for (const rh of rounds) if (this.#finished(rh, now)) gone.add(rh);
      for (const m of [this.samples, this.tapes, this.heard, this.heardTapes, this.endsAsked, ...this.#resultMaps()]) for (const rh of gone) m.delete(rh);
      if (gone.size) for (const m of [this.signed, this.mine, this.built]) for (const key of m.keys()) if (gone.has(key.slice(0, 64))) m.delete(key);
      // a finished round signs nothing more: its signed rows go too (kanban #1181)
      if (gone.size && this.signedDb) for (const rh of gone) { try { this.signedDb.drop.run(rh); } catch { /* kept */ } }
      this.evicted += gone.size;
    }
    if (this.heldLoggedAt === null || now - this.heldLoggedAt >= HELD_LOG_EVERY_MS) {
      const s = this.heldSizes();
      this.log(`[prices] held: samples ${s.samples} (${s.sampleEntries}), tapes ${s.tapes}, signed ${s.signed}, heard ${s.heard} (${s.heardSamples}), `
        + `heardTapes ${s.heardTapes}, mine ${s.mine}, built ${s.built}, endsAsked ${s.endsAsked}; ${this.evicted} finished round(s) let go of since the last line`);
      this.heldLoggedAt = now; this.evicted = 0;
    }
    return [...gone];
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
      // ONLY THE ROUND'S OWN SAMPLES ARE ASKED OF (kanban #1545): a k past the round's last sample (closeSampleK) is no sample, and
      // asking of it held an empty readings map until the round was finished - so a stranger's ?ks= of made-up numbers grew the map
      // without bound and every honest read after sorted and built them all. Such a k is answered with nothing and creates nothing.
      const kMax = closeSampleK(Number(c.contract.blockTicks));
      return { round: rh, samples: ks.filter((k) => Number.isInteger(k) && k >= 0 && k <= kMax).map((k) => {
        const all = this.#allReadings(rh, k);
        if (!all.length) return null;
        const s = this.#sample5(rh, rid, k, c);
        return { k, tick: sampleTick(k), priceCents: s ? s.priceCents : null, readings: all };
      }).filter(Boolean), tape: null, ...this.#keptResultServed(rh) };
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

  /** Every reading of samples `ks` the committee's seats hold, taken as each verifies - asked of every seat until all are in (`every`: of every
   *  seat, all of `ks`, even when a reading of each key is already held - kanban #1516). */
  async #fetchReadings(roundIdBytes, ks, c, every = false) {
    const rh = toHex(roundIdBytes);
    const results = [];   // the results the asked seats already signed (kanban #1693 / #1759 / #1804), as each served one
    for (const base of this.peersFor(roundIdBytes)) {
      const short = every ? ks.slice() : ks.filter((k) => this.#heardAt(rh, k).size < c.committee.length);
      if (!short.length) return results;
      try {
        const r = await this.fetcher(`${String(base).replace(/\/+$/, '')}/price-samples?round=${rh}&ks=${short.join(',')}`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        for (const x of (j && j.samples) || []) {
          if (!short.includes(Number(x.k))) continue;
          for (const y of x.readings || []) this.reading({ round: rh, kind: 'sample', k: Number(x.k), priceCents: y.priceCents, key: y.key, signature: y.signature });
        }
        if (j && j.result && typeof j.result === 'object') results.push(j.result);
      } catch { /* the next seat */ }
    }
    return results;
  }

  /** This seat's kept protocol-5 result, signed, with the readings it counted - served beside the ends (`ks`) so a seat that has not
   *  signed yet can sign the same one (kanban #1693 / #1759 / #1804). A result kept before it carried its readings is not served. */
  #keptResultServed(rh) {
    const kept = this.#signedOf(rh, 'result5');
    if (!kept) return {};
    let r; try { r = JSON.parse(kept, (k, v) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v)); } catch { return {}; }
    if (!r || !r.counted || typeof r.resultId !== 'string') return {};
    if (!this.resultSigs) this.resultSigs = new Map();
    let sig = this.resultSigs.get(rh);
    if (!sig || sig.resultId !== r.resultId) { sig = { resultId: r.resultId, ...this.#sign(fromHex(r.resultId)) }; this.resultSigs.set(rh, sig); }
    return { result: { resultId: r.resultId, counted: r.counted, key: sig.key, signature: sig.signature } };
  }

  /**
   * A RESULT ANOTHER SEAT SIGNED, AS THIS SEAT CHECKS IT (kanban #1693 / #1759 / #1804): signed by a committee key over its id, made of
   * readings that each verify (taken here as they come, so a second reading in it is known here too), and its id the result those
   * readings make at this round's own ends. Answers { signer, id, got, open, close } or null.
   */
  #peerResult(x, rid, rh, c, endTick, kClose) {
    try {
      const signer = typeof x.key === 'string' ? x.key.toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(signer) || !c.committee.some((m) => toHex(m) === signer)) return null;
      if (typeof x.resultId !== 'string' || !/^[0-9a-f]{64}$/.test(x.resultId) || typeof x.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(x.signature)) return null;
      if (!verify(fromHex(x.signature), fromHex(x.resultId), fromHex(signer))) return null;
      const ends = [];
      for (const list of [x.counted && x.counted.open, x.counted && x.counted.close]) {
        if (!Array.isArray(list) || list.length > c.committee.length) return null;
        const seen = new Set(), out = [];
        for (const y of list) {
          const key = y && typeof y.key === 'string' ? y.key.toLowerCase() : '';
          if (seen.has(key)) return null;
          seen.add(key);
          out.push({ key, priceCents: y.priceCents, signature: typeof y.signature === 'string' ? y.signature.toLowerCase() : '' });
        }
        ends.push(out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
      }
      const got = roundResultFromReadings({ roundId: rid, open: { tick: sampleTick(0), readings: ends[0] }, close: { tick: sampleTick(kClose), readings: ends[1] },
        endTick, committee: c.committee, threshold: c.needed, verify });
      if (!got.ok || toHex(roundResultId(got.result)) !== x.resultId) return null;
      ends.forEach((list, i) => { for (const y of list) this.reading({ round: rh, kind: 'sample', k: i ? kClose : 0, priceCents: y.priceCents, key: y.key, signature: y.signature }); });
      return { signer, id: x.resultId, got, open: ends[0], close: ends[1] };
    } catch { return null; }
  }

  /** A checked result this seat may sign too: at each end it counts every key that read ONCE here, with that reading - it may differ
   *  only in a key that read twice (which it counts with either reading or not at all) - so no seat can drop an honest reading by it. */
  #fits(p, rh, kClose) {
    for (const [k, list] of [[0, p.open], [kClose, p.close]]) {
      const theirs = new Map(list.map((y) => [y.key, y]));
      for (const [key, held] of this.#heardAt(rh, k)) {
        if (held.length !== 1) continue;
        const y = theirs.get(key);
        if (!y || y.priceCents !== held[0].priceCents) return false;
      }
    }
    return true;
  }

  async #result5(rid, rh, c, endTick, kClose) {
    // ONE RESULT PER ROUND FROM THIS SEAT (kanban #1375, audit 2 #1204 MKT-2): the first it signed is kept (price_signed, slot 'result5') and is the
    // answer from then on - a result signed again over readings that arrived later could name another close, and two threshold-signed results
    // of one round void or split a market on it
    const kept = this.#signedOf(rh, 'result5');
    if (kept) { try { const { counted, ...r } = JSON.parse(kept, (k, v) => (v && typeof v === 'object' && typeof v.$big === 'string' ? BigInt(v.$big) : v)); return { ...r, ...this.#sign(fromHex(r.resultId)) }; } catch { /* not readable: signed anew below */ } }
    if (!this.firstResultAsk) this.firstResultAsk = new Map();
    if (!this.firstResultAsk.has(rh)) this.firstResultAsk.set(rh, this.now());
    // THE ENDS ARE EXCHANGED BEFORE THE FIRST SIGNATURE (kanban #1516): a seat holding a reading of every key still asks every seat of the
    // committee, for both ends. One seat that signs a second, different end reading and shows it to only some seats makes them count its key
    // for none while the others count it - two closes, neither signed by 5 of 7, and no RoundResult of the round stands.
    // ONE EXCHANGE WAS NOT ENOUGH (kanban #1693, #1759, #1804): the second reading can come after some seats signed (anyone can ask GET
    // /round-result first, and POST /price-reading still takes it), or the seats that hold it miss the one exchange - and a signature is kept
    // for good. So the exchange also brings back the result each asked seat ALREADY signed, with the readings it counted, and is asked again
    // (every ASK_RESULTS_EVERY_MS) for as long as this seat has signed none. This seat signs the result most seats of the committee signed,
    // among those it can check (#peerResult) and that fit what it holds (#fits: they count every key that read once here, with that reading,
    // and differ only in a key that read twice) - its own result counted as one more. A seat that signs later therefore joins the seats that
    // signed first instead of splitting from them, whichever readings came to it late; ties go to the lowest result id, so seats that see
    // the same signed results choose the same one.
    if (!(this.now() - (this.endsAsked.get(rh) ?? -Infinity) < ASK_RESULTS_EVERY_MS)) {
      this.endsAsked.set(rh, this.now());
      const served = await this.#fetchReadings(rid, [0, kClose], c, true);
      if (!this.peerResults) this.peerResults = new Map();
      const m = this.peerResults.get(rh) || new Map();
      for (const x of served) if (x && typeof x.key === 'string') m.set(x.key.toLowerCase(), x);
      this.peerResults.set(rh, m);
    }
    const me = toHex(this.round.identity.pubkey || this.round.pubkey);
    // each checked first: its readings are taken here as they verify, so what fits is judged against everything held
    const peers = [...((this.peerResults && this.peerResults.get(rh)) || new Map()).values()]
      .map((x) => this.#peerResult(x, rid, rh, c, endTick, kClose)).filter((p) => p && p.signer !== me);
    const open = this.#sample5(rh, rid, 0, c), close = this.#sample5(rh, rid, kClose, c);
    let mine = null, why = null;
    if (!open || !close) why = `no ${!open ? 'opening sample (k 0)' : `closing sample (k ${kClose})`} of the round stands: fewer than ${c.needed} of the committee's readings are held here or by its committee`;
    else {
      const got = roundResultFromReadings({ roundId: rid, open: { tick: open.tick, readings: open.readings }, close: { tick: close.tick, readings: close.readings },
        endTick, committee: c.committee, threshold: c.needed, verify });
      if (!got.ok) why = got.why;
      else mine = { signer: me, id: toHex(roundResultId(got.result)), got, open: open.readings, close: close.readings };
    }
    const votes = new Map();
    for (const p of [...(mine ? [mine] : []), ...peers.filter((p) => this.#fits(p, rh, kClose))]) {
      const v = votes.get(p.id) || { signers: new Set(), p };
      v.signers.add(p.signer);
      votes.set(p.id, v);
    }
    if (!votes.size) return refuse(why || 'no result of the round stands here');
    const chosen = [...votes.values()].sort((a, b) => b.signers.size - a.signers.size || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))[0].p;
    const got = chosen.got, x = got.result;
    // SIGNED ONCE THE READINGS ARE ALL IN, or two fetch periods after the first ask (kanban #1375): never over a set that is still filling
    const stillShort = [0, kClose].some((k) => this.#heardAt(rh, k).size < c.committee.length);
    if (stillShort && this.now() - this.firstResultAsk.get(rh) < 2 * ASK_ENDS_EVERY_MS)
      return refuse(`not yet: ${c.committee.length} readings of each end are awaited for ${Math.ceil((2 * ASK_ENDS_EVERY_MS - (this.now() - this.firstResultAsk.get(rh))) / 1000)} s more before this seat signs the round's one result`, 503);
    const id = roundResultId(x);
    const answer = { ok: true, round: rh, openCents: x.openCents, closeCents: x.closeCents, front: frontName(x.front), samples: got.samples, readings: got.readings,
      openTick: got.openTick, closeTick: got.closeTick, committee: c.committee.map(toHex), needed: c.needed, resultId: toHex(id) };
    // the readings it counts are kept with it (served beside the ends, #keptResultServed), never in the answer
    const keep = JSON.stringify({ ...answer, counted: { open: chosen.open, close: chosen.close } }, (k, v) => (typeof v === 'bigint' ? { $big: String(v) } : v));
    // KEPT BEFORE IT IS SIGNED (compare-and-set): a row already there names the one this seat signed
    if (this.signedDb) {
      let ch = 0; try { ch = this.signedDb.put.run(rh, 'result5', keep).changes; } catch { ch = 0; }
      if (ch !== 1) { this.signed.delete(`${rh}:result5`); const again = this.#signedOf(rh, 'result5'); if (again) return this.#result5(rid, rh, c, endTick, kClose); }
    }
    this.signed.set(`${rh}:result5`, keep);
    return { ...answer, ...this.#sign(id) };
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
