// THE COMMITTEE'S PRICE FEED (§11, kanban #311): "the committee nodes publish one attested sample every 5 s of round time
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
// What a client does with them (the batch carries each attested sample at its tick; a run with none is SIM) is slice 2.
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { priceSampleId, priceTapeId, priceAttestationStands, sampleTick, PRICE_SAMPLE_EVERY_MS, PRICE_TAPE_LENGTH } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const EVERY = PRICE_SAMPLE_EVERY_MS;
export const SIGN_SLACK_MS = 15000;
export const DEFAULT_TOLERANCE = 0.005;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const refuse = (why, status = 409) => ({ ok: false, status, why });
const grid = (ms) => Math.floor(ms / EVERY) * EVERY;
/** Sample k is applied at round time k x 5 s and reads the price one period before: round time (k - 1) x 5 s. */
export const readingMoment = (startMs, k) => startMs + (k - 1) * EVERY;

/** BTC/USD in whole cents from Coinbase's spot price - the default feed. */
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
  constructor(round, { priceRound = () => false, readPrice = () => coinbaseCents(), peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    now = () => Date.now(), tolerance = DEFAULT_TOLERANCE } = {}) {
    Object.assign(this, { round, priceRound, readPrice, peersFor, fetcher, now, tolerance });
    this.readings = new Map();   // grid ms -> cents, this seat's own
    this.samples = new Map();    // round hex -> Map(k -> { tick, priceCents, sigs })
    this.tapes = new Map();      // round hex -> { tick, prices, sigs }
    this.signed = new Map();     // `${round}:${k}` -> price this seat signed (one price per sample)
  }

  /** This seat's own reading for the grid moment `ms` (or the one beside it), or null. */
  ownAt(ms) {
    const g = grid(ms);
    for (const at of [g, g - EVERY, g + EVERY]) if (this.readings.has(at)) return this.readings.get(at);
    return null;
  }

  async read() {
    const at = grid(this.now());
    if (this.readings.has(at)) return this.readings.get(at);
    let c = null;
    try { c = await this.readPrice(); } catch { c = null; }
    if (Number.isInteger(c) && c > 0) this.readings.set(at, c);
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
    return { ok: true, contract, needed, committee: contract.nodes };
  }
  #sign(id) { return { key: toHex(this.round.identity.pubkey || this.round.pubkey), signature: toHex(schnorr.sign(id, this.round.identity.secret)) }; }

  /** POST /price-sign: { round, kind: 'sample', k, priceCents } or { round, kind: 'tape', prices } - this seat's signature, or why not. */
  sign(body) {
    const rid = typeof body.round === 'string' && /^[0-9a-f]{64}$/.test(body.round) ? fromHex(body.round) : null;
    if (!rid) return refuse('a price ask names its round (64 hex)', 400);
    const c = this.#contract(rid); if (!c.ok) return c;
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
    return { ok: true };
  }

  /** GET /price-samples?round=&since=<tick>: the attested samples this seat holds for a round, and its tape. */
  list(roundHex, sinceTick = 0) {
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
    // a moment this seat did not read takes the nearest reading before it (or after, at the very first)
    for (let i = 0; i < prices.length; i++) if (prices[i] === null) prices[i] = prices.slice(0, i).reverse().find((x) => x !== null) ?? prices.slice(i).find((x) => x !== null) ?? null;
    if (prices.some((p) => p === null)) return refuse('this seat holds no readings before the start');
    const own = this.sign({ round: rh, kind: 'tape', prices }); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }, ...await this.#ask(roundIdBytes, { round: rh, kind: 'tape', prices })];
    const held = this.hold({ round: rh, kind: 'tape', prices, sigs });
    if (!held.ok) return held;
    await this.#handOut(roundIdBytes, { round: rh, kind: 'tape', prices, sigs });
    return { ok: true, signed: sigs.length };
  }

  /** One beat of the timer (every 5 s): read the feed; lead the samples (and the tape) this seat leads in its open price rounds. */
  async beat() {
    await this.read();
    const now = this.now();
    const out = [];
    for (const r of this.round.openRounds()) {
      let contract; try { contract = decodeRoundContract(r.contract); } catch { continue; }
      if (!this.priceRound(contract)) continue;
      const start = Number(contract.startTimeMs);
      if (now < start - EVERY) continue;   // the tape and sample 0 go out a period before the start
      const rh = toHex(r.roundId);
      const n = contract.nodes.length;
      const me = toHex(this.round.identity.pubkey || this.round.pubkey);
      if (!this.tapes.has(rh) && toHex(contract.nodes[0]) === me) out.push(['tape', await this.leadTape(r.roundId).catch((e) => refuse(e.message))]);
      const k = Math.floor((now - start) / EVERY) + 1;   // the next sample: one period ahead of its tick
      const m = this.samples.get(rh);
      if (!(m && m.has(k)) && toHex(contract.nodes[k % n]) === me) out.push([k, await this.leadSample(r.roundId, k).catch((e) => refuse(e.message))]);
    }
    return out;
  }
}
