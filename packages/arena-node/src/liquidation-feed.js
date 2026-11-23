// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE'S LIQUIDATION FEED (kanban #2694, follow-up of #2655 option 2). A Next Block strike is a forced liquidation on the
// exchange. The player named each strike's tick and size and nobody checked them, so a staked run took none at all (#2655). Now the
// committee attests each one, as it attests prices (price-feed.js):
//   READ. Every seat holds the exchange's forceOrder stream itself (FORCE_ORDER_URL, reconnecting) and keeps what it saw (15 min).
//   MAP.  An event is (tick, size) of a round from the exchange's own fields: tick = the round tick LIQ_DELAY_MS after the trade time
//         T (the strike lands one sample period later, so the attestation reaches the page before its tick), size = q x ap in millions
//         of USD, Q16.16 - the liquidation word the core takes. Several events at one tick are one strike of their summed size. Honest
//         seats read the same frames, so they sign the same pair.
//   LEAD. The event's leader is the round's seat tick mod n: it signs (round, tick, size) (price-sample.js liquidationEventId) and asks
//         every other seat (POST /liquidation-sign). A seat that saw the event and holds no attestation FALLBACK_MS later leads it
//         itself - the id is the same whoever collects it, so two leaders make one attestation.
//   SIGN. A seat signs only a round it holds and sits on, only a (tick, size) its own stream saw (waiting up to signWaitMs for the
//         frame), and one size a tick - written to its database before the signature leaves it, so a restart signs no second one.
//   HOLD. With receiptsNeeded signatures the leader hands the attestation to every seat (POST /liquidation-attested); each checks it
//         stands and keeps the first per (round, tick). GET /liquidation-strikes?round=&since= serves them; the page puts each into its
//         batch as attestation kind 4, and Round.batch requires them in a staked run of a version that takes them.
import { durably } from './store.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { liquidationEventId, liquidationAttestationStands } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** The exchange's forced-liquidation stream for the round's market. */
export const FORCE_ORDER_URL = 'wss://fstream.binance.com/ws/btcusdt@forceOrder';
export const FORCE_ORDER_SYMBOL = 'BTCUSDT';
/** A strike lands this long after the exchange's trade time: one price sample period. */
export const LIQ_DELAY_MS = 5000;
/** How long a seat asked to sign waits for the frame on its own stream. */
export const SIGN_WAIT_MS = 3000;
/** A seat that saw an event and holds no attestation this long after leads it itself. */
export const FALLBACK_MS = 4000;
/** What a seat keeps of its own stream. */
export const EVENTS_KEPT_MS = 15 * 60 * 1000;
export const EVENTS_KEPT_MAX = 4096;
/** At most this many attested liquidations a GET answers. */
export const HELD_PAGE = 512;

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const refuse = (why, status = 409) => ({ ok: false, status, why });
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

/** A forceOrder frame of the round's market as { atMs (the exchange's trade time), usd (q x average price) }, or null. */
export function parseForceOrder(text) {
  let j; try { j = typeof text === 'string' ? JSON.parse(text) : JSON.parse(Buffer.from(text).toString('utf8')); } catch { return null; }
  const o = j && j.e === 'forceOrder' ? j.o : null;
  if (!o || o.s !== FORCE_ORDER_SYMBOL) return null;
  const atMs = Number(o.T), q = Number(o.z || o.q), p = Number(o.ap || o.p);
  if (!Number.isSafeInteger(atMs) || atMs <= 0 || !(q > 0) || !(p > 0) || !Number.isFinite(q * p)) return null;
  return { atMs, usd: q * p };
}
/** Millions of USD in Q16.16, at least 1 (a liquidation is never size 0), at most the i32 the batch carries. */
export const liquidationSizeOf = (usd) => Math.min(0x7fffffff, Math.max(1, Math.round(usd * 65536 / 1e6)));
/** The round tick a liquidation at the exchange's time `atMs` strikes at. */
export const liquidationTick = (startMs, atMs) => Number(ticksForMs(BigInt(Math.round(atMs - startMs + LIQ_DELAY_MS))).ticks);

export class LiquidationFeed {
  /**
   * `round`: the seat's Round (db, identity, get, openRounds). `liqRound(contract)`: whether that round's run takes attested strikes.
   * `peersFor(roundIdBytes)`: the other seats' base URLs.
   */
  constructor(round, { liqRound = () => false, peersFor = () => [], fetcher = (u, o) => fetch(u, o), now = () => Date.now(),
    signWaitMs = SIGN_WAIT_MS, later = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); }, log = (line) => console.log(line) } = {}) {
    Object.assign(this, { round, liqRound, peersFor, fetcher, now, signWaitMs, later, log });
    this.events = [];             // this seat's own stream: { atMs, usd, seenMs }
    this.signed = new Map();      // `${round}:${tick}` -> size this seat signed
    this.attested = new Map();    // round hex -> Map(tick -> { size, sigs })
    this.db = null;
    try {
      round.db.exec('CREATE TABLE IF NOT EXISTS liquidation_signed (round TEXT NOT NULL, tick INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (round, tick))');
      round.db.exec('CREATE TABLE IF NOT EXISTS liquidation_attested (round TEXT NOT NULL, tick INTEGER NOT NULL, size INTEGER NOT NULL, sigs TEXT NOT NULL, PRIMARY KEY (round, tick))');
      const putSigned = round.db.prepare('INSERT OR IGNORE INTO liquidation_signed (round, tick, size) VALUES (?, ?, ?)');
      this.db = {
        signed: round.db.prepare('SELECT size FROM liquidation_signed WHERE round = ? AND tick = ?'),
        // what this seat signed is on the disk before the signature leaves it (as price_signed, kanban #1243)
        putSigned: { run: (...a) => durably(round.db, () => putSigned.run(...a)) },
        putHeld: round.db.prepare('INSERT OR IGNORE INTO liquidation_attested (round, tick, size, sigs) VALUES (?, ?, ?, ?)'),
        heldAt: round.db.prepare('SELECT size FROM liquidation_attested WHERE round = ? AND tick = ?'),
        held: round.db.prepare('SELECT tick, size, sigs FROM liquidation_attested WHERE round = ? AND tick >= ? ORDER BY tick LIMIT ?'),
      };
    } catch { this.db = null; }   // a stand-in store without SQL: memory only
  }

  #me() { return toHex(this.round.identity.pubkey || this.round.pubkey); }
  #contract(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this seat holds no such round', 404);
    let contract; try { contract = decodeRoundContract(new Uint8Array(row.contract)); } catch { return refuse('that round does not parse'); }
    if (!this.liqRound(contract)) return refuse('that round takes no attested liquidations');
    const committee = contract.nodes.map(toHex);
    if (!committee.includes(this.#me())) return refuse('this seat does not sit on that round');
    let needed; try { needed = receiptsNeeded(contract.gameVerifySlots); } catch { needed = contract.nodes.length; }
    let endMs; try { endMs = Number(roundEndMs(contract)); } catch { endMs = Infinity; }
    return { ok: true, contract, committee, needed, startMs: Number(contract.startTimeMs), endMs };
  }
  /** The strike this seat's own stream saw at `tick` of a round: the summed size of its events there, or null. */
  #ownAt(c, tick) {
    let usd = 0, any = false;
    for (const e of this.events) {
      if (e.atMs < c.startMs || e.atMs > c.endMs || liquidationTick(c.startMs, e.atMs) !== tick) continue;
      usd += e.usd; any = true;
    }
    return any ? liquidationSizeOf(usd) : null;
  }
  #signedOf(rh, tick) {
    const key = `${rh}:${tick}`;
    if (this.signed.has(key)) return this.signed.get(key);
    let r = null; try { r = this.db ? this.db.signed.get(rh, tick) : null; } catch { r = null; }
    if (!r) return null;
    this.signed.set(key, Number(r.size));
    return Number(r.size);
  }
  /** Sign (round, tick, size), once per tick: the size is kept (compare-and-set) before the signature is made. */
  #signOnce(rid, rh, tick, size) {
    const had = this.#signedOf(rh, tick);
    if (had !== null && had !== size) return refuse('this seat signed another size for that tick');
    if (had === null && this.db) {
      let ch = 0; try { ch = this.db.putSigned.run(rh, tick, size).changes; } catch { ch = 0; }
      if (ch !== 1) { this.signed.delete(`${rh}:${tick}`); if (this.#signedOf(rh, tick) !== size) return refuse('this seat signed another size for that tick'); }
    }
    this.signed.set(`${rh}:${tick}`, size);
    const id = liquidationEventId({ roundId: rid, tick, size });
    return { ok: true, key: this.#me(), signature: toHex(schnorr.sign(id, this.round.identity.secret)) };
  }

  /** POST /liquidation-sign: { round, tick, size } - this seat's signature, when its own stream saw that strike. */
  async sign(body) {
    if (!body || !isHex(body.round, 64)) return refuse('a liquidation ask names its round (64 hex)', 400);
    if (!Number.isInteger(body.tick) || body.tick < 0 || body.tick > 0xffffffff) return refuse('a liquidation ask names its tick', 400);
    if (!Number.isInteger(body.size) || body.size <= 0 || body.size > 0x7fffffff) return refuse('a liquidation ask names its size (Q16.16, positive)', 400);
    const rid = fromHex(body.round);
    const c = this.#contract(rid); if (!c.ok) return c;
    // the frame may reach this seat a moment after the leader's: wait for it, a little
    const until = Date.now() + this.signWaitMs;
    let own = this.#ownAt(c, body.tick);
    while (own === null && Date.now() < until) { await new Promise((r) => setTimeout(r, 100)); own = this.#ownAt(c, body.tick); }
    if (own === null) return refuse('this seat\'s stream did not see a liquidation at that tick');
    if (own !== body.size) return refuse(`this seat's stream saw size ${own} at that tick`);
    return this.#signOnce(rid, body.round, body.tick, body.size);
  }

  /** POST /liquidation-attested: { round, tick, size, sigs: [{ key, signature }] } - kept when it stands, first per tick. */
  hold(body) {
    if (!body || !isHex(body.round, 64)) return refuse('an attested liquidation names its round (64 hex)', 400);
    const rid = fromHex(body.round);
    const row = this.round.get(rid);
    if (!row) return refuse('this seat holds no such round', 404);
    let contract; try { contract = decodeRoundContract(new Uint8Array(row.contract)); } catch { return refuse('that round does not parse'); }
    let needed; try { needed = receiptsNeeded(contract.gameVerifySlots); } catch { needed = contract.nodes.length; }
    let id; try { id = liquidationEventId({ roundId: rid, tick: body.tick, size: body.size }); } catch (e) { return refuse(e.message, 400); }
    const sigs = Array.isArray(body.sigs) ? body.sigs.slice(0, contract.nodes.length * 2) : [];
    const s = liquidationAttestationStands({ id, sigs, committee: contract.nodes, threshold: needed, verify });
    if (!s.ok) return refuse(`that liquidation is not attested: ${s.why}`);
    const kept = sigs.filter((x) => x && typeof x.key === 'string' && s.signed.includes(x.key.toLowerCase()))
      .filter((x, i, a) => a.findIndex((y) => y.key.toLowerCase() === x.key.toLowerCase()) === i)
      .map((x) => ({ key: x.key.toLowerCase(), signature: String(x.signature).toLowerCase() }));
    const rh = body.round;
    const had = this.#heldSize(rh, body.tick);
    if (had !== null) return had === body.size ? { ok: true, again: true } : refuse('this seat holds another attested liquidation at that tick');
    if (this.db) { try { this.db.putHeld.run(rh, body.tick, body.size, JSON.stringify(kept)); } catch { /* memory below */ } }
    if (!this.attested.has(rh)) this.attested.set(rh, new Map());
    this.attested.get(rh).set(body.tick, { size: body.size, sigs: kept });
    return { ok: true, tick: body.tick, size: body.size };
  }
  #heldSize(rh, tick) {
    const m = this.attested.get(rh);
    if (m && m.has(tick)) return m.get(tick).size;
    let r = null; try { r = this.db ? this.db.heldAt.get(rh, tick) : null; } catch { r = null; }
    return r ? Number(r.size) : null;
  }

  /** The attested liquidations held of a round from tick `since` on: [[tick, size, [[key, sig], ...]], ...] in tick order. */
  held(rh, since = 0) {
    if (this.db) {
      let rows = []; try { rows = this.db.held.all(rh, since, HELD_PAGE); } catch { rows = []; }
      return rows.map((r) => { let s = []; try { s = JSON.parse(r.sigs); } catch { s = []; } return [Number(r.tick), Number(r.size), s.map((x) => [x.key, x.signature])]; });
    }
    const m = this.attested.get(rh);
    return m ? [...m].filter(([t]) => t >= since).sort((a, b) => a[0] - b[0]).slice(0, HELD_PAGE).map(([t, x]) => [t, x.size, x.sigs.map((y) => [y.key, y.signature])]) : [];
  }

  /**
   * LET GO OF FINISHED ROUNDS (kanban #2694, as price-feed.js tidy, #742): a round no longer held, or past its end and its objection window
   * (first-mark.js roundEndMs + objectionWindowMs), has its signed and attested rows dropped - by then no run plays and no batch is taken.
   * Its stored batches keep their attestations. Answers how many rounds were let go of.
   */
  tidy() {
    const now = this.now();
    let rounds = [];
    if (this.db) { try { rounds = this.round.db.prepare('SELECT round FROM liquidation_signed UNION SELECT round FROM liquidation_attested LIMIT 4096').all().map((r) => r.round); } catch { rounds = []; } }
    rounds = [...new Set([...rounds, ...this.attested.keys(), ...[...this.signed.keys()].map((k) => k.split(':')[0])])];
    let gone = 0;
    for (const rh of rounds) {
      let finished = true;
      try {
        const row = this.round.get(fromHex(rh));
        if (row) { const c = decodeRoundContract(new Uint8Array(row.contract)); finished = now > Number(roundEndMs(c)) + Number(c.objectionWindowMs || 0n); }
      } catch { finished = true; }
      if (!finished) continue;
      if (this.db) { try { this.round.db.prepare('DELETE FROM liquidation_signed WHERE round = ?').run(rh); this.round.db.prepare('DELETE FROM liquidation_attested WHERE round = ?').run(rh); } catch { /* next time */ } }
      this.attested.delete(rh);
      for (const k of [...this.signed.keys()]) if (k.startsWith(`${rh}:`)) this.signed.delete(k);
      gone++;
    }
    return gone;
  }

  /** Lead one strike: this seat's signature, the others', held and handed out. */
  async lead(roundIdBytes, tick, size) {
    const rh = toHex(roundIdBytes);
    const c = this.#contract(roundIdBytes); if (!c.ok) return c;
    if (this.#ownAt(c, tick) !== size) return refuse('this seat\'s stream did not see that strike');
    const own = this.#signOnce(roundIdBytes, rh, tick, size); if (!own.ok) return own;
    const sigs = [{ key: own.key, signature: own.signature }];
    await Promise.all(this.peersFor(roundIdBytes).map(async (base) => {
      try {
        const r = await this.fetcher(`${String(base).replace(/\/+$/, '')}/liquidation-sign`, { method: 'POST', body: JSON.stringify({ round: rh, tick, size }), signal: AbortSignal.timeout(this.signWaitMs + 3000) });
        if (!r.ok) return;
        const j = await r.json();
        if (j && isHex(j.key, 64) && isHex(j.signature, 128)) sigs.push({ key: j.key, signature: j.signature });
      } catch { /* that seat counts nothing */ }
    }));
    const kept = this.hold({ round: rh, tick, size, sigs });
    if (!kept.ok) return kept;
    const out = this.held(rh, tick).find((x) => x[0] === tick);
    const body = JSON.stringify({ round: rh, tick, size, sigs: (out ? out[2] : []).map(([key, signature]) => ({ key, signature })) });
    await Promise.all(this.peersFor(roundIdBytes).map((base) => this.fetcher(`${String(base).replace(/\/+$/, '')}/liquidation-attested`,
      { method: 'POST', body, signal: AbortSignal.timeout(5000) }).catch(() => null)));
    return { ok: true, tick, size, signed: sigs.length };
  }

  /**
   * One frame of this seat's own stream: kept, and for every open round it falls in, led now (this seat leads its tick) or after
   * FALLBACK_MS when no attestation came. `lead: false` only keeps it. Answers the leads made now.
   */
  async see(ev, { lead = true } = {}) {
    if (!ev || !Number.isSafeInteger(ev.atMs) || !(ev.usd > 0)) return [];
    const now = this.now();
    // one frame once: a stream that reconnects may hand the same frame again
    if (!this.events.some((e) => e.atMs === ev.atMs && e.usd === ev.usd)) this.events.push({ atMs: ev.atMs, usd: ev.usd, seenMs: now });
    this.events = this.events.filter((e) => now - e.seenMs <= EVENTS_KEPT_MS).slice(-EVENTS_KEPT_MAX);
    if (!lead) return [];
    const out = [];
    let open = []; try { open = this.round.openRounds(); } catch { open = []; }
    for (const r of open) {
      const c = this.#contract(r.roundId); if (!c.ok) continue;
      if (ev.atMs < c.startMs || ev.atMs > c.endMs) continue;
      const tick = liquidationTick(c.startMs, ev.atMs);
      const size = this.#ownAt(c, tick);
      if (size === null) continue;
      const rh = toHex(r.roundId);
      if (c.committee[tick % c.committee.length] === this.#me()) out.push(await this.lead(r.roundId, tick, size).catch((e) => refuse(e.message)));
      else this.later(() => { if (this.#heldSize(rh, tick) === null) this.lead(r.roundId, tick, this.#ownAt(c, tick)).catch(() => null); }, FALLBACK_MS);
    }
    return out;
  }

  /** Hold the exchange's stream, reconnecting (1 s doubling to 30 s). Answers a function that closes it. */
  connect({ url = FORCE_ORDER_URL, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== 'function') { this.log('[liquidations] no WebSocket in this runtime: no liquidation feed'); return () => {}; }
    let ws = null, closed = false, wait = 1000, loggedAt = 0;
    const open = () => {
      if (closed) return;
      try { ws = new WebSocketImpl(url); } catch (e) { return again(e.message); }
      ws.onopen = () => { wait = 1000; };
      ws.onmessage = (m) => { this.see(parseForceOrder(m.data)).then((got) => { for (const g of got) if (!g.ok) this.log(`[liquidations] ${g.why}`); }).catch(() => {}); };
      ws.onerror = () => {};
      ws.onclose = () => again('the stream closed');
    };
    const again = (why) => {
      if (closed) return;
      if (Date.now() - loggedAt > 60000) { this.log(`[liquidations] ${why}; again in ${wait / 1000} s`); loggedAt = Date.now(); }
      this.later(open, wait); wait = Math.min(30000, wait * 2);
    };
    open();
    return () => { closed = true; try { ws && ws.close(); } catch { /* closed */ } };
  }
}
