// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS' MARKET ORDER BOOK (step 4 + comment 1127; 2026-10-09: "Order batches alle 1s, wenn möglich
// alle 0.5s", and "(a)").
//
//   AN ORDER IS AN ENTRY with a limit price (contracts.js ORDER_MARKER). The player locks first - its stake lock is its budget
//   less 1 %, its fee lock the 1 % - and an order is TRADABLE at this seat once this seat verified both locks with the
//   federation (the entry's own door, /stake-lock and /fee-lock). No seat holds the money: the locks are the federation's,
//   under the round's threshold claim key.
//   A CANCEL (POST /cancel, the entry's session key) or a SELL (POST /sell, the same key) takes effect only inside a batch.
//
//   AGREE. Batch k takes what was tradable or asked at any seat before its cutoff, (k + 1) x the interval. Its LEADER is the
//   round's seat k mod n. At the cutoff it asks every seat for its proposal (GET /batch-proposal): its tradable orders, its
//   cancels and sells, and every batch it signed that is not certified yet.
//    1. Earlier batches first. A pending batch is CERTIFIED once at least the threshold of seats signed its id - the leader
//       of that batch counts by its own signature on the record - and the certificate goes to every seat
//       (POST /batch-certificate). Else the leader asks every seat (POST /batch-void-ask, its own signed ask naming the set k's
//       leader signed, kanban #1167): a seat holding the record answers its signature; a seat that never signed DECLINES - only
//       once the next batch's cutoff has passed (k's leader had its interval to hand its set out), never while k's own set is on its way. Once enough have declined
//       that the threshold can no longer be reached, the batch is VOID everywhere (POST /batch-void) and its orders wait for
//       the next one. Until then it is pending and the book does not move on: no seat can count a batch another dropped.
//    2. The new set: the orders tradable at at least the threshold of seats (they verified the locks), every cancel and sell
//       signed by its entry's key - a sell no more than its entry holds unsold. The leader signs its id and hands it to every
//       seat (POST /batch); each checks the leader, every order (its locks verified here), every cancel and sell, that none is
//       in another batch, that no earlier batch is pending here, and that it signed no other set for (round, k) and declined
//       none - and answers its own signature. With the threshold, the certificate goes to every seat.
//   Only certified batches are in the book (book-ledger.js): a fill moves nothing in the federation, it closes the order's
//   locks to the return door; a cancel of an unfilled order opens it; at resolution every filled lock is claimed whole.
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { bookBatchId, batchDeclineId, batchVoidAskId, cancelId, sellId, BATCH_MS, PRICE_SCALE, TICK } from '../../arena-protocol/src/order-book.js';
import { bookLedger, positionFilled } from '../../arena-protocol/src/book-ledger.js';
import { entryFeeBpsOf, feeBpsOf, donationBpsOf, reserveBpsOf } from '../../arena-protocol/src/fee.js';
import { marketBps } from '../../arena-protocol/src/fee-proposal.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';
import { marketOfRound } from '../../arena-protocol/src/manifest.js';
import { verifySchnorrKept, verifyEd25519Kept } from './verified.js';

const refuse = (why, status = 409) => ({ ok: false, status, why });
const verifyEd = verifyEd25519Kept;   // kept per (sig, msg, key) - verified.js (kanban #576)
const verifySchnorr = verifySchnorrKept;
const isHex = (s, n) => typeof s === 'string' && s.length === 2 * n && /^[0-9a-f]+$/.test(s);
const isOrder = (e) => e && e.limitPrice !== undefined && e.limitPrice !== null;

/**
 * A MARKET'S RATES AT ONE ROUND: one that pays the protocol reserve (its terms name one) at the market rates of the
 * fee set in force there (`fees`, fee-proposal.js marketBps); any other at its own terms. The website share is the set's. Answers
 * { feeBps, nodeBps, donationBps, reserveBps, websitePct? } - feeBps the whole rate an order's fee lock holds.
 */
export function marketRates(manifest, fees = null) {
  if (fees && reserveBpsOf(manifest) > 0) {
    const r = marketBps(fees);
    return { feeBps: r.nodeBps + r.donationBps, nodeBps: r.nodeBps, donationBps: r.donationBps, reserveBps: r.reserveBps, websitePct: fees.websitePct };
  }
  return { feeBps: entryFeeBpsOf(manifest), nodeBps: feeBpsOf(manifest), donationBps: donationBpsOf(manifest) || 0, reserveBps: reserveBpsOf(manifest),
    ...(fees ? { websitePct: fees.websitePct } : {}) };
}

/** How long an order whose replay was refused waits before it is asked again, of any peer (kanban #1087). */
export const REPLAY_RETRY_MS = 10 * 60 * 1000;
/** A refusal no later block can lift: the stake lock is already older than the freshness window at the height it is verified at. */
const REPLAY_NEVER = /blocks below the height \d+ it is verified at/;
/** Which orders may be asked again (kanban #1087): `allow(o)` false while a refusal holds, `refused(o, why)` answers whether it is for good. */
export class ReplayGate {
  constructor({ now = () => Date.now(), retryMs = REPLAY_RETRY_MS, max = 4096 } = {}) { this.now = now; this.retryMs = retryMs; this.max = max; this.held = new Map(); }
  allow(o) { const h = this.held.get(o); return !h || h.until <= this.now(); }
  refused(o, why) {
    const forever = REPLAY_NEVER.test(String(why));
    this.held.delete(o);
    this.held.set(o, { until: forever ? Infinity : this.now() + this.retryMs, why });
    if (this.held.size > this.max) this.held.delete(this.held.keys().next().value);
    return forever;
  }
  taken(o) { this.held.delete(o); }
}

// THE STATE OF ONE BATCH AT THIS SEAT (kanban #1150, the state machine audit of 2026-11-06: the states were implicit - a row with or
// without its own signature or certificate, a decline row - and each door moved them its own way). Read from the store by #state, moved
// only by #move, inside one transaction that reads the state again, checks the move is one of BATCH_MOVES and its guard, and writes:
//   ABSENT     nothing held for (round, k)
//   DECLINED   this seat answered a round seat's signed void ask without having signed, past the next batch's cutoff (kanban #1167): it never
//              signs k (a certificate of k signed by others is still taken)
//   SIGNED     this seat signed the set (its record and own signature held) and no certificate is held yet
//   CERTIFIED  the threshold's certificate is held: in the book, for good
//   VOID       enough seats declined that k can never be certified (POST /batch-void): its orders and events wait again, for good
// MONOTONIC: a seat signs k only above every batch it holds (signed or certified) and never while a batch below k is undecided here, so
// once a seat holds K no k < K gets its signature - with every two thresholds of seats sharing one seat, no batch below a certified one
// can be certified after it; the one below it that a seat takes later was certified before it (the seat had missed it, kanban #740).
export const BATCH = Object.freeze({ ABSENT: 'ABSENT', DECLINED: 'DECLINED', SIGNED: 'SIGNED', CERTIFIED: 'CERTIFIED', VOID: 'VOID' });
export const BATCH_MOVES = Object.freeze({
  [BATCH.ABSENT]: Object.freeze([BATCH.SIGNED, BATCH.DECLINED, BATCH.CERTIFIED, BATCH.VOID]),
  [BATCH.DECLINED]: Object.freeze([BATCH.CERTIFIED, BATCH.VOID]),
  [BATCH.SIGNED]: Object.freeze([BATCH.CERTIFIED, BATCH.VOID]),
  [BATCH.CERTIFIED]: Object.freeze([]),
  [BATCH.VOID]: Object.freeze([]),
});
/**
 * A ROUND'S READ OF THE OTHER SEATS' CERTIFIED BATCHES, AS THIS SEAT KEEPS IT (kanban #1182): UNREAD -> KEPT once a read was complete;
 * KEPT -> STALE when a certificate is stored after it (sync then reads again, whole); a read that saw a certificate stored meanwhile is
 * not kept. In memory: a restart reads again (safe).
 */
export const SYNC_STATE = Object.freeze({ UNREAD: 'UNREAD', KEPT: 'KEPT', STALE: 'STALE' });
/** How many sells of one order a seat keeps waiting for a batch (kanban #1526: unbounded, one order's sells stalled every leader). */
export const MAX_UNBATCHED_SELLS = 16;
/** How long a seat waits for one other seat's answer while it leads a batch (proposals, void asks, sets, certificates). */
export const BATCH_FETCH_MS = 1000;
class Conflict extends Error {}

// kanban #1547: the sells one entry keeps waiting for a batch at a seat, and the verified sells a seat remembers
export const SELL_PENDING_MAX = 16;
const SELL_CHECKED_MAX = 65536;

export class OrderBook {
  constructor(round, { plugins, peersFor = () => [], fetcher = (u, o) => fetch(u, o), now = () => Date.now(), intervalMs = Number(BATCH_MS), feesFor = null,
    syncTimeoutMs = 4000, fetchTimeoutMs = BATCH_FETCH_MS, maxLagMs = null } = {}) {
    this.round = round;
    // A LEADER'S PEER THAT DOES NOT ANSWER does not hold the batch up (kanban #1150: the proposal fetches had no timeout)
    this.fetchTimeoutMs = fetchTimeoutMs;
    // HOW FAR BEHIND NOW A BATCH IS STILL SIGNED (kanban #1150: no bound on k - a leader could post a back-dated free k once the outcome
    // was known): its cutoff no more than this before now - two intervals and one peer's answer (null: from the interval in force)
    this.lagMs = maxLagMs;
    // how long a seat waits for another seat's certified batches before it settles (sync, kanban #740)
    this.syncTimeoutMs = syncTimeoutMs;
    // THE FEES IN FORCE AT A ROUND: `feesFor(contract)` -> the fee set at its census height (server.js, funding-book.js
    // feesAt). A market that pays the protocol reserve (its terms name one) trades at that set's market rates
    this.feesFor = feesFor;
    this.plugins = plugins;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.db = round.db;
  }

  /** The round's market: a two-outcome attested game this seat hosts; its rates and its seats. */
  market(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(contract, this.plugins);
    if (!found.ok || !found.attested) return refuse('that round is not a market this node hosts');
    // a round of a template counts its own outcomes (feature 5)
    if ((marketOfRound(found.plugin.manifest, contract).outcomes || []).length !== 2) return refuse('the order book trades a two-outcome market (Up / Down)');
    // A SCALAR MARKET'S BOOK (§0A.7e): its two sides trade as any two outcomes do; at resolution a LONG share is worth
    // (V - low) / (high - low) of a sat and a SHORT share the rest (book-ledger.js bookSettlement `scalar`)
    const m = found.plugin.manifest;
    return { ok: true, contract, manifest: m, ...marketRates(m, typeof this.feesFor === 'function' ? this.feesFor(contract) : null),
      needed: receiptsNeeded(contract.gameVerifySlots), seats: contract.nodes.map(toHex) };
  }

  /**
   * WHETHER THAT ROUND IS AN ORDER BOOK, THE SAME AT EVERY SEAT (§0A.7b, RULED 2026-11-10 kanban #1417, audit 5 #1411): "a round is a book iff a
   * threshold-certified batch holds an order". It was "an order this seat has seen the stake of" - a fact each seat learns at its own time, so a
   * round holding backed orders and backed plain picks was planned as a book at one seat and a pool at another (no threshold), and one type's
   * stakes waited for their lock timeout. A batch takes only orders whose locks its signers verified (#check), so a lockless order makes no book.
   */
  isBook(roundIdBytes) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return false;
    return this.db.prepare('SELECT record FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL').all(Buffer.from(roundIdBytes))
      .some((r) => { try { return (JSON.parse(r.record).orders || []).length > 0; } catch { return false; } });
  }

  /** Whether that round takes orders at this seat (an order whose stake it saw, kanban #1270): when its book is worth reading from the other seats. */
  takesOrders(roundIdBytes) {
    const m = this.market(roundIdBytes);
    return m.ok && this.round.entriesOf(roundIdBytes).some((x) => isOrder(x.entry) && (x.entry.stakeMsat === 0n || typeof this.round.stakeSeen !== 'function' || !!this.round.stakeSeen(x.entryId)));
  }

  leaderOf(contract, k) { return contract.nodes[Number(BigInt(k) % BigInt(contract.nodes.length))]; }

  leads(roundIdBytes, k) {
    const row = this.round.get(roundIdBytes);
    return !!row && toHex(this.leaderOf(decodeRoundContract(new Uint8Array(row.contract)), k)) === toHex(this.round.pubkey);
  }

  cutoffOf(k) { return (Number(k) + 1) * this.intervalMs; }

  /** How far behind now a batch's cutoff may be when this seat signs it (kanban #1150). */
  get maxLagMs() { return this.lagMs === null || this.lagMs === undefined ? 2 * this.intervalMs + this.fetchTimeoutMs : this.lagMs; }

  /** Batch k's state at this seat (BATCH). */
  batchState(roundIdBytes, k) { return this.#state(Buffer.from(roundIdBytes), Number(k)); }

  #state(rid, k) {
    if (this.db.prepare('SELECT 1 FROM market_batch_voids WHERE round_id = ? AND k = ?').get(rid, k)) return BATCH.VOID;
    const row = this.db.prepare('SELECT own_sig, certificate FROM market_batches WHERE round_id = ? AND k = ?').get(rid, k);
    if (row && row.certificate) return BATCH.CERTIFIED;
    if (row && row.own_sig) return BATCH.SIGNED;
    if (this.db.prepare('SELECT 1 FROM market_batch_declines WHERE round_id = ? AND k = ?').get(rid, k)) return BATCH.DECLINED;
    return BATCH.ABSENT;
  }

  /**
   * THE ONE TRANSITION (kanban #1150): batch k to `to`, compare-and-set - in one transaction the state is read again, the move must be
   * one of BATCH_MOVES from it and `guard(from)` must pass (it answers a refusal or null), then `write(from)` runs. Nothing leaves this
   * seat before its state is committed: a signature, a decline or a void is handed out only after its move answered ok.
   */
  #move(rid, k, to, { guard = () => null, write = () => {} } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const from = this.#state(rid, k);
      if (!BATCH_MOVES[from].includes(to)) { this.db.exec('ROLLBACK'); return { ...refuse(`batch ${k} is ${from} at this seat: it cannot become ${to}`), from }; }
      const no = guard(from);
      if (no) { this.db.exec('ROLLBACK'); return { ...no, from }; }
      write(from);
      this.db.exec('COMMIT');
      return { ok: true, from };
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (e instanceof Conflict) return refuse(e.message);
      throw e;
    }
  }

  /** An order's locks were verified here: it is tradable from now (the lock doors call this). */
  noteTradable(roundIdBytes) { if (this.market(roundIdBytes).ok) this.#syncTradable(roundIdBytes); }

  /** The orders of a round that are tradable here: entries with a limit price whose two locks this seat verified. */
  #syncTradable(roundIdBytes) {
    const put = this.db.prepare('INSERT OR IGNORE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, ?, ?, NULL)');
    // ONLY THE ENTRIES NOT IN THE BOOK YET (kanban #576, profiled 2026-10-23 00:5xZ on test host seat 1: every batch proposal decoded
    // every entry of the round and read both its locks, 2.7 s of processor in 90 s, for rows the insert then ignored)
    const fresh = this.db.prepare('SELECT entry_id, contract FROM entries WHERE round_id = ? AND entry_id NOT IN (SELECT entry_id FROM market_cancels) '
      + 'AND lower(hex(entry_id)) NOT IN (SELECT order_id FROM market_orders WHERE round_id = ?) ORDER BY entry_id').all(roundIdBytes, Buffer.from(roundIdBytes));
    for (const r of fresh) {
      const entryId = new Uint8Array(r.entry_id), entry = decodeEntryContract(new Uint8Array(r.contract));
      if (!isOrder(entry)) continue;
      const stake = this.round.stakeLock(entryId);
      const fee = this.round.feeLock ? this.round.feeLock(entryId) : null;
      if (!stake || (entry.feeMsat > 0n && !fee)) continue;
      put.run(toHex(entryId), Buffer.from(roundIdBytes), '', Math.max(stake.verifiedMs || 0, fee ? fee.verifiedMs || 0 : 0));
    }
  }

  /** The entry an order, cancel or sell names - an order of that round this seat holds - or why not. */
  #orderEntry(roundIdBytes, entryHex) {
    if (!isHex(entryHex, 32)) return refuse('an entry id is 32 hex bytes', 400);
    const raw = this.round.entry(fromHex(entryHex));
    if (!raw) return refuse(`this seat holds no entry ${entryHex.slice(0, 16)}`);
    const entry = decodeEntryContract(raw);
    if (toHex(entry.roundId) !== toHex(roundIdBytes)) return refuse('that entry is in another round');
    if (!isOrder(entry)) return refuse('that entry is not an order (it names no limit price)');
    return { ok: true, entry };
  }

  /** A cancel, checked: signed by its order's session key over cancelId. */
  #cancelStands(roundIdBytes, c) {
    if (!c || !isHex(c.signature, 64)) return refuse('a cancel is { entry, signature }', 400);
    const o = this.#orderEntry(roundIdBytes, c.entry);
    if (!o.ok) return o;
    const id = cancelId({ roundId: roundIdBytes, entryId: fromHex(c.entry) });
    if (!verifyEd(fromHex(c.signature), id, o.entry.sessionPubkey)) return refuse('that cancel is not signed by its order\'s session key', 403);
    return { ok: true, id: toHex(id) };
  }

  // A SELL IS VERIFIED ONCE (kanban #1547): the leader checked every pending sell's Ed25519 signature again for each seat's proposal and
  // again in the ledger - 3000 sells of one entry on seven seats made lead() take 39 s and its own batch past the 2 s signing limit.
  // A sell that stood is kept here by its whole body (round, fields and signature), at most SELL_CHECKED_MAX of them, oldest out first.
  #sellChecked = new Map();
  /** A sell, checked: a whole cent, signed by its entry's session key over sellId (what it holds is the ledger's question). */
  #sellStands(roundIdBytes, s) {
    if (!s || !isHex(s.signature, 64) || !/^[0-9]{1,20}$/.test(String(s.price)) || !/^[0-9]{1,20}$/.test(String(s.sharesMsat)) || !/^[0-9]{1,20}$/.test(String(s.nonce)))
      return refuse('a sell is { entry, outcome, price, sharesMsat, nonce, signature }', 400);
    const key = [toHex(roundIdBytes), s.entry, s.outcome, s.price, s.sharesMsat, s.nonce, s.signature].map(String).join('|');
    const kept = this.#sellChecked.get(key);
    if (kept) return { ok: true, id: kept.id, sell: { ...kept.sell } };
    const x = this.#sellVerify(roundIdBytes, s);
    if (x.ok) { this.#sellChecked.set(key, x); if (this.#sellChecked.size > SELL_CHECKED_MAX) this.#sellChecked.delete(this.#sellChecked.keys().next().value); }
    return x.ok ? { ok: true, id: x.id, sell: { ...x.sell } } : x;
  }
  #sellVerify(roundIdBytes, s) {
    const o = this.#orderEntry(roundIdBytes, s.entry);
    if (!o.ok) return o;
    const price = BigInt(s.price);
    if (price < 1n || price >= PRICE_SCALE || price % TICK !== 0n) return refuse(`a sell price is a whole cent below 1: ${s.price} is not`);
    let id;
    try { id = sellId({ roundId: roundIdBytes, entryId: fromHex(s.entry), outcome: s.outcome, price, sharesMsat: BigInt(s.sharesMsat), nonce: BigInt(s.nonce) }); }
    catch (e) { return refuse(e.message, 400); }
    if (!verifyEd(fromHex(s.signature), id, o.entry.sessionPubkey)) return refuse('that sell is not signed by its entry\'s session key', 403);
    return { ok: true, id: toHex(id), sell: { id: toHex(id), entry: s.entry, outcome: s.outcome, price, sharesMsat: BigInt(s.sharesMsat) } };
  }

  /** POST /cancel or POST /sell of a book entry: kept here until a batch carries it; refused after the market closed. */
  ask(roundIdBytes, kind, body) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    if (BigInt(this.now()) >= m.contract.entryCloseMs) return refuse(`the market closed at ${new Date(Number(m.contract.entryCloseMs)).toISOString()}: no ${kind} after it`);
    const c = kind === 'cancel' ? this.#cancelStands(roundIdBytes, body) : this.#sellStands(roundIdBytes, body);
    if (!c.ok) return c;
    if (kind === 'sell') {
      // A SELL ONLY OF AN ORDER IN THE BOOK HERE, AND A FEW AT A TIME (kanban #1526: a stranger's lockless order - no sat spent - signed
      // thousands of sells, each nonce a new row, and every leader's lead() went quadratic over them): its locks verified at this seat
      // (tradable), and no more than MAX_UNBATCHED_SELLS of its sells waiting for a batch here
      const rid = Buffer.from(roundIdBytes), tradable = this.db.prepare('SELECT 1 FROM market_orders WHERE order_id = ? AND round_id = ?');
      if (!tradable.get(String(body.entry), rid)) { this.#syncTradable(roundIdBytes); if (!tradable.get(String(body.entry), rid)) return refuse('that order is not tradable at this seat: its locks are not verified here, it holds nothing to sell'); }
      const held = this.db.prepare('SELECT 1 FROM market_book_events WHERE event_id = ?').get(c.id);
      const waiting = this.db.prepare("SELECT count(*) AS n FROM market_book_events WHERE round_id = ? AND kind = 'sell' AND entry_id = ? AND batch IS NULL").get(rid, String(body.entry)).n;
      if (!held && waiting >= MAX_UNBATCHED_SELLS) return refuse(`that order has ${waiting} sells waiting for a batch at this seat: at most ${MAX_UNBATCHED_SELLS}`, 429);
      const b = this.#sellBacked(roundIdBytes, c); if (!b.ok) return b;   // kanban #1547: and its entry holds an unsold share of that outcome
    }
    const fresh = this.db.prepare('INSERT OR IGNORE INTO market_book_events (event_id, round_id, kind, entry_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(c.id, Buffer.from(roundIdBytes), kind, String(body.entry), JSON.stringify(body), this.now()).changes === 1;
    return { ok: true, id: c.id, fresh };
  }

  /**
   * A SELL AT THE DOOR (kanban #1547): ask() kept any signed sell - a fresh nonce a fresh sell, no bound per entry - and a sell its
   * entry could not back was left out of every batch by the leader's ledger but stayed unbatched at every seat until the close, handed
   * to the leader again in every proposal (3000 of one entry stalled every later batch of the market). Now a sell is refused here when
   * the certified ledger shows its entry holds no unsold share of that outcome, and one entry keeps at most SELL_PENDING_MAX sells
   * unbatched at this seat. A sell larger than what is unsold is still the leader's question (the ledger leaves it out), as before.
   */
  #sellBacked(roundIdBytes, c) {
    const rid = Buffer.from(roundIdBytes);
    if (this.db.prepare('SELECT 1 FROM market_book_events WHERE event_id = ?').get(c.id)) return { ok: true };
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM market_book_events WHERE round_id = ? AND kind = 'sell' AND entry_id = ? AND batch IS NULL").get(rid, c.sell.entry).n;
    if (pending >= SELL_PENDING_MAX) return refuse(`entry ${c.sell.entry.slice(0, 16)} has ${pending} sells waiting for a batch at this seat: at most ${SELL_PENDING_MAX}`, 429);
    const L = this.ledger(roundIdBytes);
    if (!L.ok) return { ok: true };
    const p = L.positions.get(c.sell.entry);
    const o = Number(c.sell.outcome);
    const unsold = p && (o === 0 || o === 1) ? p.shares[o] - p.shares[1 - o] : 0n;
    if (unsold <= 0n) return refuse(`entry ${c.sell.entry.slice(0, 16)} holds no unsold share of outcome ${c.sell.outcome} in the certified book: nothing to sell`);
    return { ok: true };
  }

  /** GET /batch-proposal: this seat's unbatched orders, cancels and sells before batch k's cutoff, and its pending batches. */
  proposal(roundIdBytes, k) {
    this.#syncTradable(roundIdBytes);
    const cutoff = this.cutoffOf(k);
    const rid = Buffer.from(roundIdBytes);
    // an order tradable here only after the market closed is in no batch (kanban #1150: a late lock filled against resting orders)
    const orders = this.db.prepare('SELECT order_id FROM market_orders WHERE round_id = ? AND batch IS NULL AND received_ms < ? ORDER BY order_id')
      .all(rid, Math.min(cutoff, this.#closeOf(roundIdBytes))).map((r) => r.order_id);
    const events = this.db.prepare('SELECT kind, body FROM market_book_events WHERE round_id = ? AND batch IS NULL AND received_ms < ? ORDER BY event_id').all(rid, cutoff);
    const pending = this.db.prepare('SELECT k, batch_id, record, own_sig FROM market_batches WHERE round_id = ? AND certificate IS NULL ORDER BY k').all(rid)
      .map((r) => ({ k: String(r.k), batchId: r.batch_id, record: JSON.parse(r.record), ownSig: r.own_sig }));
    return { seat: toHex(this.round.pubkey), k: String(k), orders,
      cancels: events.filter((e) => e.kind === 'cancel').map((e) => JSON.parse(e.body)),
      sells: events.filter((e) => e.kind === 'sell').map((e) => JSON.parse(e.body)), pending };
  }

  /** The round's entry close (ms), or Infinity when its contract cannot be read here. */
  #closeOf(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return Infinity;
    try { return Number(decodeRoundContract(new Uint8Array(row.contract)).entryCloseMs); } catch { return Infinity; }
  }

  /** The id of a batch record: its orders, cancels and sells, by their ids. */
  #recordId(roundIdBytes, record) {
    const ids = [...record.orders];
    const events = [];
    for (const c of record.cancels || []) { const x = this.#cancelStands(roundIdBytes, c); if (!x.ok) return x; ids.push(x.id); events.push(x.id); }
    const sells = [];
    for (const s of record.sells || []) { const x = this.#sellStands(roundIdBytes, s); if (!x.ok) return x; ids.push(x.id); sells.push(x.sell); events.push(x.id); }
    let id;
    try { id = bookBatchId({ roundId: roundIdBytes, k: BigInt(record.k), orderIds: ids }); } catch (e) { return refuse(e.message, 400); }
    return { ok: true, id: toHex(id), sells, events };
  }

  /** The ledger of the round's certified batches (book-ledger.js), optionally with one more batch on top. */
  ledger(roundIdBytes, extra = null) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const rows = this.db.prepare('SELECT k, record FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL ORDER BY k').all(Buffer.from(roundIdBytes));
    const records = rows.map((r) => JSON.parse(r.record));
    if (extra) records.push(extra);
    const batches = [];
    for (const rec of records) {
      const orders = [];
      for (const id of rec.orders) {
        const o = this.#orderEntry(roundIdBytes, id);
        if (!o.ok) return refuse(`a batch names an order this seat cannot read: ${o.why}`);
        orders.push({ id, outcome: o.entry.pick, price: BigInt(o.entry.limitPrice), stakeMsat: o.entry.stakeMsat - o.entry.donationMsat, feeMsat: o.entry.feeMsat, expiryMs: o.entry.orderExpiryMs || 0n });
      }
      const sells = (rec.sells || []).map((s) => { const x = this.#sellStands(roundIdBytes, s); return x.ok ? x.sell : null; }).filter(Boolean);
      batches.push({ k: Number(rec.k), cutoffMs: BigInt(this.cutoffOf(rec.k)), orders, cancels: (rec.cancels || []).map((c) => c.entry), sells });
    }
    return { ok: true, ...bookLedger({ batches, feeBps: m.feeBps }), market: m };
  }

  /** A record's checks at this seat: answers { ok, id, k, events } or why it does not stand. `importing`: a certified record. */
  #check(roundIdBytes, m, record, { importing = false } = {}) {
    if (!record || !/^[0-9]{1,15}$/.test(String(record.k)) || !Array.isArray(record.orders)) return refuse('a batch is { k, orders, cancels, sells, leader, leaderSig }', 400);
    const k = BigInt(record.k);
    if (BigInt(this.cutoffOf(k)) > m.contract.entryCloseMs + BigInt(this.intervalMs)) return refuse(`batch ${k} is after the market closed: nothing trades after its close`);
    const leader = toHex(this.leaderOf(m.contract, k));
    if (String(record.leader) !== leader) return refuse(`batch ${k} is led by the round's seat ${k % BigInt(m.contract.nodes.length)}, not ${String(record.leader).slice(0, 16)}`);
    const rid = Buffer.from(roundIdBytes);
    if (!importing) {
      // A BATCH IS SIGNED ONLY AROUND ITS OWN CUTOFF (kanban #1150): not ahead of it - a far k signed now would hold every batch below it
      // up - and not more than maxLagMs after it - a back-dated k, posted once the outcome is known, took orders and fills into the past
      const now = this.now(), cutoff = this.cutoffOf(k);
      if (cutoff > now + this.intervalMs) return refuse(`batch ${k}'s cutoff is ${cutoff - now} ms ahead: a batch is signed at its cutoff, not before`);
      if (now - cutoff > this.maxLagMs) return refuse(`batch ${k}'s cutoff was ${now - cutoff} ms ago: a batch is signed no later than ${this.maxLagMs} ms after its cutoff`);
      this.#syncTradable(roundIdBytes);
      // AN ORDER IN BATCH k WAS TRADABLE HERE BEFORE k'S CUTOFF AND BEFORE THE MARKET CLOSED (kanban #1150: a late lock filled against
      // resting orders; the batch after the close took what was locked in its last interval)
      const close = Number(m.contract.entryCloseMs);
      for (const id of record.orders) {
        const row = isHex(id, 32) ? this.db.prepare('SELECT received_ms FROM market_orders WHERE order_id = ? AND round_id = ?').get(id, rid) : null;
        if (!row) return refuse(`order ${String(id).slice(0, 16)}: this seat has not verified its locks`);
        if (Number(row.received_ms) >= cutoff) return refuse(`order ${id.slice(0, 16)} was tradable here only ${Number(row.received_ms) - cutoff} ms after batch ${k}'s cutoff: it is in a later batch`);
        if (Number(row.received_ms) >= close) return refuse(`order ${id.slice(0, 16)} was tradable here only after the market closed: it never trades`);
      }
    } else for (const id of record.orders) { const o = this.#orderEntry(roundIdBytes, id); if (!o.ok) return o; }
    const rec = this.#recordId(roundIdBytes, record);
    if (!rec.ok) return rec;
    if (!isHex(String(record.leaderSig), 64) || !verifySchnorr(fromHex(String(record.leaderSig)), fromHex(rec.id), fromHex(leader))) return refuse('that batch is not signed by its leader', 403);
    // A SELL NO MORE THAN ITS ENTRY HOLDS UNSOLD, by the certified book and this batch on top
    if (!importing) {
      const L = this.ledger(roundIdBytes, record);
      if (!L.ok) return L;
      const bad = L.refused.filter((r) => rec.sells.some((s) => s.id === r.id));
      if (bad.length) return refuse(`a sell of that batch does not stand: ${bad[0].why}`);
      // A CANCEL ONLY OF AN ORDER THE BOOK HOLDS (kanban #1489): a leader carrying a cancel before its order got the batch signed - the
      // ledger skipped the cancel, the cancel was marked batched for good (one id per entry), and the order filled in the next batch
      const lost = L.refused.find((r) => r.why.startsWith('a cancel') && (record.cancels || []).some((c) => c.entry === r.id));
      if (lost) return refuse(`a cancel of that batch does not stand: ${lost.why}`);
    }
    return { ok: true, id: rec.id, k, events: rec.events };
  }

  /**
   * THE GUARD OF -> SIGNED (kanban #1150), read inside the move's transaction: no batch held here above k (a seat signs upward only),
   * none below k undecided, and no order, cancel or sell of the set in another batch here (one signed sell executed twice).
   */
  #signGuard(rid, k, c, record) {
    const above = this.db.prepare('SELECT k, certificate FROM market_batches WHERE round_id = ? AND k > ? ORDER BY k DESC LIMIT 1').get(rid, k);
    if (above) return refuse(`this seat holds batch ${above.k} (${above.certificate ? 'certified' : 'signed'}): it signs no batch below one it holds`);
    const pendingBefore = this.db.prepare('SELECT k FROM market_batches WHERE round_id = ? AND k < ? AND certificate IS NULL').get(rid, k);
    if (pendingBefore) return refuse(`batch ${pendingBefore.k} is not decided at this seat: the book does not move on before it is`);
    const orderAt = this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ?');
    for (const id of record.orders) { const r = orderAt.get(id); if (r && r.batch !== null && Number(r.batch) !== k) return refuse(`order ${id.slice(0, 16)} is in batch ${r.batch} at this seat`); }
    const eventAt = this.db.prepare('SELECT kind, batch FROM market_book_events WHERE event_id = ?');
    for (const id of c.events) { const r = eventAt.get(id); if (r && r.batch !== null && Number(r.batch) !== k) return refuse(`that ${r.kind} ${id.slice(0, 16)} is in batch ${r.batch} at this seat: a signed cancel or sell is in one batch only`); }
    return null;
  }

  /** POST /batch: the leader's set for batch k - held here and signed, or refused by name. */
  accept(roundIdBytes, record) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const c = this.#check(roundIdBytes, m, record);
    if (!c.ok) return c;
    const rid = Buffer.from(roundIdBytes), k = Number(c.k), seat = toHex(this.round.pubkey);
    const state = this.#state(rid, k);
    if (state === BATCH.DECLINED || state === BATCH.VOID) return refuse(`this seat declined batch ${c.k}: it never signs it`);
    const held = this.db.prepare('SELECT batch_id, own_sig, certificate, stored_ms FROM market_batches WHERE round_id = ? AND k = ?').get(rid, k);
    if (held && held.batch_id !== c.id) return refuse(`this seat already signed another set for batch ${c.k}: ${held.batch_id.slice(0, 16)}`);
    if (held && held.own_sig) return { ok: true, seat, signature: held.own_sig, storedAtMs: Number(held.stored_ms), fresh: false };
    // the same set certified here already (taken on its certificate): signing it again changes nothing
    if (held && held.certificate) return { ok: true, seat, signature: toHex(schnorr.sign(fromHex(c.id), this.round.identity.secret)), storedAtMs: Number(held.stored_ms), fresh: false };
    const storedAtMs = this.now();
    let signature = null;
    const moved = this.#move(rid, k, BATCH.SIGNED, {
      guard: () => this.#signGuard(rid, k, c, record),
      write: () => { signature = toHex(schnorr.sign(fromHex(c.id), this.round.identity.secret)); this.#store(rid, roundIdBytes, k, c.id, record, signature, null, storedAtMs); },
    });
    if (!moved.ok) return moved;
    return { ok: true, seat, signature, storedAtMs, fresh: true };
  }

  /**
   * The rows of batch k, inside its move's transaction. An order, cancel or sell already in another batch here is a CONFLICT (kanban
   * #1150: the event was moved to the later batch and its sell executed twice) and the move is rolled back - except that a certificate
   * takes it from a batch only signed here: that one can no longer be certified (its other signers hold this one, or its void).
   */
  #store(rid, roundIdBytes, k, id, record, ownSig, certificate, at) {
    this.db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (round_id, k) DO UPDATE SET certificate = COALESCE(excluded.certificate, certificate)')
      .run(rid, k, id, JSON.stringify(record), ownSig, certificate, at);
    const claim = (what, row, x) => {
      if (!row || row.batch === null || Number(row.batch) === k) return;
      const other = this.#state(rid, Number(row.batch));
      if (!certificate || other === BATCH.CERTIFIED) throw new Conflict(`${what} ${String(x).slice(0, 16)} is in batch ${row.batch} at this seat (${other}): it is in one batch only`);
    };
    const orderAt = this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ?');
    const putOrder = this.db.prepare('INSERT INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, \'\', ?, ?) ON CONFLICT (order_id) DO UPDATE SET batch = excluded.batch');
    for (const o of record.orders) { claim('order', orderAt.get(o), o); putOrder.run(o, rid, at, k); }
    const eventAt = this.db.prepare('SELECT batch FROM market_book_events WHERE event_id = ?');
    const putEvent = this.db.prepare('INSERT INTO market_book_events (event_id, round_id, kind, entry_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET batch = excluded.batch');
    for (const c of record.cancels || []) { const e = this.#cancelStands(roundIdBytes, c).id; claim('cancel', eventAt.get(e), e); putEvent.run(e, rid, 'cancel', c.entry, JSON.stringify(c), at, k); }
    for (const s of record.sells || []) { const e = this.#sellStands(roundIdBytes, s).id; claim('sell', eventAt.get(e), e); putEvent.run(e, rid, 'sell', s.entry, JSON.stringify(s), at, k); }
  }

  /** Signatures over a batch id that count: distinct seats of the round, each verifying. */
  #counted(m, id, sigs) {
    const ok = new Map();
    for (const s of sigs) {
      if (!s || !isHex(s.seat, 32) || !isHex(s.signature, 64) || !m.seats.includes(s.seat) || ok.has(s.seat)) continue;
      if (verifySchnorr(fromHex(s.signature), fromHex(id), fromHex(s.seat))) ok.set(s.seat, s.signature);
    }
    return [...ok].map(([seat, signature]) => ({ seat, signature }));
  }

  /**
   * POST /batch-certificate: a batch with at least the threshold of the round's seats' signatures - in the book from now. A certificate
   * stored fresh outside a read of the other seats (`reading`: the read's own takes) makes the round's kept read STALE (kanban #1182):
   * the book moved after it, so the next settlement reads the other seats again, whole.
   */
  certify(roundIdBytes, cert, { reading = false } = {}) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    // A CERTIFICATE THIS SEAT HOLDS ALREADY (kanban #576): carry() hands every peer's certificates of the round to every settlement,
    // and the same set held certified here was verified when it was stored - not its signatures again. Measured 2026-10-23 00:2xZ on
    // test host seat 1: this re-verification was 10.1 s of processor in 90 s, a third of all the seat did.
    if (cert && cert.record && /^[0-9]{1,15}$/.test(String(cert.record.k)) && Array.isArray(cert.record.orders)) {
      const held = this.db.prepare('SELECT batch_id, certificate FROM market_batches WHERE round_id = ? AND k = ?').get(Buffer.from(roundIdBytes), Number(cert.record.k));
      if (held && held.certificate) { const rec = this.#recordId(roundIdBytes, cert.record); if (rec.ok && rec.id === held.batch_id) return { ok: true, fresh: false }; }
    }
    const c = this.#check(roundIdBytes, m, cert && cert.record, { importing: true });
    if (!c.ok) return c;
    const sigs = this.#counted(m, c.id, (cert && cert.sigs) || []);
    if (sigs.length < m.needed) return refuse(`that certificate carries ${sigs.length} seats' signatures and batch ${c.k} needs ${m.needed}`, 403);
    const rid = Buffer.from(roundIdBytes), k = Number(c.k);
    const heldQ = this.db.prepare('SELECT batch_id, own_sig, certificate FROM market_batches WHERE round_id = ? AND k = ?');
    const another = () => { const h = heldQ.get(rid, k); return h && h.batch_id !== c.id ? refuse(`this seat holds another set for batch ${c.k}: two certified sets for one batch cannot be`) : null; };
    { const no = another(); if (no) return no; }
    // ABSENT, DECLINED or SIGNED -> CERTIFIED; a VOID batch is never certified
    const moved = this.#move(rid, k, BATCH.CERTIFIED, {
      guard: another,
      write: () => { const h = heldQ.get(rid, k); this.#store(rid, roundIdBytes, k, c.id, cert.record, h ? h.own_sig : null, JSON.stringify(sigs), this.now()); },
    });
    if (!moved.ok) return moved.from === BATCH.CERTIFIED ? { ok: true, fresh: false } : moved;
    if (!reading) this.#syncStep(toHex(roundIdBytes), { kind: 'certified', k });
    return { ok: true, fresh: true };
  }

  /**
   * The ids a batch record names - its orders, and its cancels' and sells' ids from their bodies (no check of them here): the list its
   * id is the hash of (bookBatchId). Answers null for a record whose fields do not read.
   */
  #idsOf(roundIdBytes, record) {
    try {
      return [...record.orders.map(String),
        ...(record.cancels || []).map((c) => toHex(cancelId({ roundId: roundIdBytes, entryId: fromHex(c.entry) }))),
        ...(record.sells || []).map((x) => toHex(sellId({ roundId: roundIdBytes, entryId: fromHex(x.entry), outcome: x.outcome, price: BigInt(x.price), sharesMsat: BigInt(x.sharesMsat), nonce: BigInt(x.nonce) })))];
    } catch { return null; }
  }

  /**
   * THIS SEAT'S VOID ASK FOR BATCH k (kanban #1167): the set k's leader signed (`record`), by the ids it hashes, and this seat's
   * signature over (round, k, that set) - what the other seats answer, and nothing else.
   */
  voidAskFor(roundIdBytes, k, record) {
    const ids = record && Array.isArray(record.orders) ? this.#idsOf(roundIdBytes, record) : null;
    if (!ids || !isHex(String(record.leaderSig), 64)) return null;
    let batchId;
    try { batchId = bookBatchId({ roundId: roundIdBytes, k: BigInt(k), orderIds: ids }); } catch { return null; }
    return { seat: toHex(this.round.pubkey), batchId: toHex(batchId), ids, leaderSig: String(record.leaderSig),
      signature: toHex(schnorr.sign(batchVoidAskId({ roundId: roundIdBytes, k: BigInt(k), batchId }), this.round.identity.secret)) };
  }

  /**
   * THE DOOR OF A VOID ASK (kanban #1167: anyone could post one for any k of any round, and every seat declined it for good): a seat of
   * this market's round signed it over (round, k, set); the set hashes from the ids it names and k's leader signed it - so k is pending
   * somewhere - and k is a batch of the round's life (its cutoff no earlier than the committee and no later than one interval after the
   * close: a decline row only for a batch that can be).
   */
  #askStands(roundIdBytes, m, k, ask) {
    if (!ask || !isHex(ask.seat, 32) || !isHex(ask.signature, 64) || !isHex(ask.batchId, 32) || !isHex(ask.leaderSig, 64) || !Array.isArray(ask.ids)
      || ask.ids.length > 100000 || !ask.ids.every((x) => isHex(x, 32)))
      return refuse('a void ask is { seat, batchId, ids, leaderSig, signature }: a seat of the round signs it over the set k\'s leader signed', 400);
    if (!m.seats.includes(ask.seat)) return refuse('that void ask is not from a seat of this round', 403);
    const cutoff = BigInt(this.cutoffOf(k));
    if (cutoff < m.contract.committeeTimeMs || cutoff > m.contract.entryCloseMs + BigInt(this.intervalMs)) return refuse(`batch ${k} is outside this round's book: nothing to decline`);
    let id;
    try { id = bookBatchId({ roundId: roundIdBytes, k: BigInt(k), orderIds: ask.ids }); } catch (e) { return refuse(e.message, 400); }
    if (toHex(id) !== ask.batchId) return refuse(`those ids are not the set ${ask.batchId.slice(0, 16)} of batch ${k}`, 400);
    if (!verifySchnorr(fromHex(ask.leaderSig), id, this.leaderOf(m.contract, k))) return refuse(`batch ${k}'s leader did not sign that set: nothing of it is pending`, 403);
    if (!verifySchnorr(fromHex(ask.signature), batchVoidAskId({ roundId: roundIdBytes, k: BigInt(k), batchId: id }), fromHex(ask.seat))) return refuse('that void ask is not signed by its seat', 403);
    return { ok: true };
  }

  /**
   * POST /batch-void-ask: this seat's signature if it signed batch k (or the certificate, if it holds k certified without having signed
   * it), else its decline - ABSENT -> DECLINED, committed before the decline is handed out - and it never signs k after. Only a round
   * seat's signed ask is answered (#askStands), and a seat declines only once the next batch's cutoff has passed (kanban #1167): k's leader
   * hands its set out in its own interval, and the void ask comes from a later batch's leader - so no ask raced to the seats while k's set is
   * on its way voids it (the next leader decides it at once, as #1150's tests ask: a void at the very next batch, its orders in that one).
   */
  voidAsk(roundIdBytes, k, ask = null) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const rid = Buffer.from(roundIdBytes), seat = toHex(this.round.pubkey);
    k = Number(k);
    const stands = this.#askStands(roundIdBytes, m, k, ask);
    if (!stands.ok) return stands;
    const declined = () => ({ ok: true, seat, declined: toHex(schnorr.sign(batchDeclineId({ roundId: roundIdBytes, k: BigInt(k) }), this.round.identity.secret)) });
    let state = this.#state(rid, k);
    if (state === BATCH.ABSENT) {
      const late = this.now() - this.cutoffOf(k);
      if (late < this.intervalMs) return refuse(`batch ${k}'s cutoff was ${late} ms ago and its set may still be on its way: this seat declines it only from the next cutoff, ${this.intervalMs} ms after`);
      const moved = this.#move(rid, k, BATCH.DECLINED, { write: () => this.db.prepare('INSERT OR IGNORE INTO market_batch_declines (round_id, k) VALUES (?, ?)').run(rid, k) });
      state = moved.ok ? BATCH.DECLINED : this.#state(rid, k);
    }
    if (state === BATCH.DECLINED || state === BATCH.VOID) return declined();
    const held = this.db.prepare('SELECT batch_id, own_sig, certificate, record FROM market_batches WHERE round_id = ? AND k = ?').get(rid, k);
    if (held.own_sig) return { ok: true, seat, signed: held.own_sig, batchId: held.batch_id };
    // the certified record goes with the certificate (kanban #1886): the asker checks it is a set OF BATCH k before it takes k as decided
    return { ok: true, seat, batchId: held.batch_id, certificate: JSON.parse(held.certificate), record: JSON.parse(held.record) };
  }

  /**
   * POST /batch-void: enough seats can never sign batch k that the threshold can no longer be reached - its orders wait again.
   * A SEAT THAT SIGNED ANOTHER SET OF k CAN NEVER SIGN THIS ONE (kanban #2026, #1489; refute of #1519/#1697/#1886): k's leader signed two
   * sets and split the honest seats between them 3/3 - neither set reached the threshold, nobody declined (every honest seat had signed
   * one), k stayed PENDING at every leader and #signGuard kept every seat from signing a later batch: the book froze for good. A void now
   * also carries `sets`: [{ batchId, ids, sigs: [{ seat, signature }] }], each set's ids hashing under (round, k) to its batchId and each
   * signature that seat's over that id. For EVERY set (the ones named and any other), the seats that cannot sign it - its decliners, and
   * the seats that signed a set of k other than it (never a seat that signed it) - must be at least n - needed + 1: no set of k can then
   * be certified (an honest seat signs one set per batch and never declines one it signed, #voidAsk). Declines alone are the same rule as before.
   */
  applyVoid(roundIdBytes, body) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    if (!body || !/^[0-9]{1,15}$/.test(String(body.k))) return refuse('a void is { k, declines, sets }', 400);
    const k = BigInt(body.k);
    const msg = batchDeclineId({ roundId: roundIdBytes, k });
    const ok = new Set();
    for (const d of Array.isArray(body.declines) ? body.declines : []) if (d && isHex(d.seat, 32) && isHex(d.signature, 64) && m.seats.includes(d.seat) && verifySchnorr(fromHex(d.signature), msg, fromHex(d.seat))) ok.add(d.seat);
    const enough = m.contract.nodes.length - m.needed + 1;
    // the seats that signed each set of k, from `sets` (anything that does not read or verify is ignored)
    const signedBy = new Map();
    for (const x of (Array.isArray(body.sets) ? body.sets : []).slice(0, m.seats.length + 1)) {
      if (!x || !isHex(x.batchId, 32) || !Array.isArray(x.ids) || x.ids.length > 100000 || !x.ids.every((i) => isHex(i, 32)) || !Array.isArray(x.sigs)) continue;
      let id;
      try { id = toHex(bookBatchId({ roundId: roundIdBytes, k, orderIds: x.ids })); } catch { continue; }
      if (id !== x.batchId) continue;
      const seats = signedBy.get(id) || new Set();
      for (const s of this.#counted(m, id, x.sigs)) seats.add(s.seat);
      if (seats.size) signedBy.set(id, seats);
    }
    if (signedBy.size) {
      // the seats that cannot sign set `id` (null: a set nobody here signed)
      const blockers = (id) => {
        const no = new Set(ok);
        for (const [other, seats] of signedBy) if (other !== id) for (const s of seats) no.add(s);
        if (id !== null) for (const s of signedBy.get(id)) no.delete(s);
        return no.size;
      };
      const worst = [...signedBy.keys()].map((id) => [id, blockers(id)]).sort((a, b) => a[1] - b[1])[0];
      if (worst[1] < enough)
        return refuse(`${worst[1]} seats can never sign set ${worst[0].slice(0, 16)} of batch ${k} (${ok.size} declined, the others signed another set of it) and it is void only once ${enough} cannot: ${m.needed} could still sign it`, 403);
    } else if (ok.size < enough) return refuse(`${ok.size} seats declined batch ${k} and it is void only once ${enough} have: ${m.needed} could still sign it`, 403);
    const rid = Buffer.from(roundIdBytes), kn = Number(k);
    // ABSENT, DECLINED or SIGNED -> VOID, for good
    const moved = this.#move(rid, kn, BATCH.VOID, {
      write: () => {
        this.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, kn);
        this.db.prepare('UPDATE market_orders SET batch = NULL WHERE round_id = ? AND batch = ?').run(rid, kn);
        this.db.prepare('UPDATE market_book_events SET batch = NULL WHERE round_id = ? AND batch = ?').run(rid, kn);
        this.db.prepare('INSERT OR IGNORE INTO market_batch_declines (round_id, k) VALUES (?, ?)').run(rid, kn);
        this.db.prepare('INSERT OR IGNORE INTO market_batch_voids (round_id, k) VALUES (?, ?)').run(rid, kn);
      },
    });
    if (!moved.ok) {
      if (moved.from === BATCH.VOID) return { ok: true, voided: true, fresh: false };
      if (moved.from === BATCH.CERTIFIED) return refuse(`batch ${k} is certified here: it cannot be void`);
      return moved;
    }
    return { ok: true, voided: true };
  }

  /**
   * One request to another seat, given up after fetchTimeoutMs (kanban #1150: a peer that never answered held the leader - and every
   * batch after it - up). Answers { ok, body } or { ok: false, why }.
   */
  async #ask(url, opts = {}) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { if (ac) ac.abort(); reject(new Error(`no answer in ${this.fetchTimeoutMs} ms`)); }, this.fetchTimeoutMs); });
    late.catch(() => {});
    try {
      const r = await Promise.race([this.fetcher(url, ac ? { ...opts, signal: ac.signal } : opts), late]);
      if (!r.ok) return { ok: false, why: String(await Promise.race([r.text(), late])).trim() };
      return { ok: true, body: await Promise.race([r.json(), late]) };
    } catch (e) { return { ok: false, why: e.message }; } finally { clearTimeout(timer); }
  }

  async #post(base, path, body) {
    const a = await this.#ask(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return a.ok ? { ok: true, ...a.body } : a;
  }

  async #proposalOf(base, rid, k) { const a = await this.#ask(`${base}/batch-proposal?round=${rid}&k=${k}`); return a.ok ? a.body : null; }

  /** A pending batch decided, from the proposals and if need be the seats' answers: certified, void, or still pending. */
  async #decide(roundIdBytes, m, k, record, id, sigs, peers, known = { sigs: [], records: new Map() }) {
    const rid = toHex(roundIdBytes);
    let counted = this.#counted(m, id, sigs);
    if (counted.length < m.needed) {
      // this seat's own signed ask, naming the set k's leader signed (kanban #1167: the seats answer nothing else)
      const ask = this.voidAskFor(roundIdBytes, k, record);
      if (!ask) return { state: 'PENDING', why: `the set of batch ${k} does not read: no void ask for it` };
      const answers = await Promise.all(peers.map((b) => this.#post(b, `/batch-void-ask?round=${rid}&k=${k}`, ask)));
      const own = this.voidAsk(roundIdBytes, k, ask);
      const all = [own, ...answers.filter((a) => a.ok)];
      // a seat that holds the batch certified without having signed it answers the certificate (kanban #1150: it used to decline it)
      counted = this.#counted(m, id, [...counted, ...all.filter((a) => a.signed && a.batchId === id).map((a) => ({ seat: a.seat, signature: a.signed })),
        ...all.filter((a) => Array.isArray(a.certificate) && a.batchId === id).flatMap((a) => a.certificate)]);
      // A CERTIFICATE FOR ANOTHER SET DECIDES k (kanban #1697, #1762): k's leader signed two sets and the threshold signed the other one -
      // this set can never be certified (an honest seat signs one set per batch) and k is not pending: the book moves on
      // ONLY A CERTIFICATE OF BATCH k (kanban #1886, refute of #1697/#1762): a seat answered the void ask for a half-signed k with the
      // genuine certificate of an earlier batch - k was taken as decided, never voided, the seats that signed it held it pending for good
      // and signed no later batch. The answer carries the certified record: it is batch k's (record.k), led and signed by k's leader, its
      // ids hash to the batchId named under (round, k), and the threshold signed that id. Anything else is ignored and k goes on to void.
      if (counted.length < m.needed) {
        const other = all.find((a) => Array.isArray(a.certificate) && isHex(String(a.batchId), 32) && a.batchId !== id && this.#certificateOfK(roundIdBytes, m, k, a));
        if (other) {
          // stored here if it can be (this seat may hold the other set signed: two sets for one batch are not stored, k is decided still)
          this.certify(roundIdBytes, { record: other.record, sigs: other.certificate });
          return { state: 'DECIDED', batchId: other.batchId, why: `batch ${k} is certified under ${String(other.batchId).slice(0, 16)}` };
        }
      }
      if (counted.length < m.needed) {
        const declines = all.filter((a) => a.declined).map((a) => ({ seat: a.seat, signature: a.declined }));
        // EVERY SET OF k A SEAT SIGNED, with its ids (kanban #2026): this set's signatures, and each other set k's leader signed that a
        // seat holds signed - from the proposals' pending items and the void-ask answers. A seat holding another set never signs this one.
        const sets = new Map();
        const add = (bid, seat, signature) => {
          if (!sets.has(bid)) {
            const rec = bid === id ? record : known.records.get(bid);
            const ids = rec && Array.isArray(rec.orders) ? this.#idsOf(roundIdBytes, rec) : null;
            if (!ids) return;
            sets.set(bid, { batchId: bid, ids, sigs: [] });
          }
          sets.get(bid).sigs.push({ seat, signature });
        };
        for (const s of counted) add(id, s.seat, s.signature);
        for (const s of known.sigs) if (s && s.batchId !== id) add(s.batchId, s.seat, s.signature);
        for (const a of all) if (a.signed && isHex(String(a.batchId), 32)) add(a.batchId, a.seat, a.signed);
        const signedSets = [...sets.values()].map((x) => ({ ...x, sigs: this.#counted(m, x.batchId, x.sigs) })).filter((x) => x.sigs.length);
        // two sets or more are the leader's equivocation proof; one set alone adds nothing to its declines (the void it always was)
        const body = signedSets.length >= 2 ? { k: String(k), declines, sets: signedSets } : { k: String(k), declines };
        const voided = this.applyVoid(roundIdBytes, body);
        if (!voided.ok) return { state: 'PENDING', why: voided.why };
        await Promise.all(peers.map((b) => this.#post(b, `/batch-void?round=${rid}`, body)));
        return { state: 'VOID', declined: declines.length, sets: body.sets ? body.sets.length : 0 };
      }
    }
    const cert = { record, sigs: counted };
    const mine = this.certify(roundIdBytes, cert);
    if (!mine.ok) return { state: 'PENDING', why: mine.why };
    await Promise.all(peers.map((b) => this.#post(b, `/batch-certificate?round=${rid}`, cert)));
    return { state: 'CERTIFIED', sigs: counted.length };
  }

  /**
   * A void-ask answer's certificate is a certificate OF BATCH k (kanban #1886): its record is k's, led by k's leader, the ids it names
   * hash under (round, k) to the batchId named, k's leader signed that id and the threshold of the round's seats did.
   */
  #certificateOfK(roundIdBytes, m, k, a) {
    try {
      const r = a.record;
      if (!r || typeof r !== 'object' || !Array.isArray(r.orders) || String(r.k) !== String(k) || !isHex(String(r.leaderSig), 64)) return false;
      const leader = toHex(this.leaderOf(m.contract, k));
      if (String(r.leader) !== leader) return false;
      const ids = this.#idsOf(roundIdBytes, r);
      if (!ids || !ids.every((x) => isHex(x, 32))) return false;
      const id = toHex(bookBatchId({ roundId: roundIdBytes, k: BigInt(k), orderIds: ids }));
      if (id !== String(a.batchId) || !verifySchnorr(fromHex(String(r.leaderSig)), fromHex(id), fromHex(leader))) return false;
      return this.#counted(m, id, a.certificate).length >= m.needed;
    } catch { return false; }
  }

  /** A proposal's pending item a leader may decide (kanban #1519): k in the round's book, the record reads to batchId, k's leader signed it. */
  #pendingStands(roundIdBytes, m, x) {
    try {
      if (!x || typeof x !== 'object' || !x.record || typeof x.record !== 'object' || !Array.isArray(x.record.orders)) return false;
      if (!/^[0-9]{1,15}$/.test(String(x.k)) || String(x.record.k) !== String(x.k) || !isHex(String(x.batchId), 32) || !isHex(String(x.record.leaderSig), 64)) return false;
      const k = BigInt(x.k), cutoff = BigInt(this.cutoffOf(k));
      if (cutoff < m.contract.committeeTimeMs || cutoff > m.contract.entryCloseMs + BigInt(this.intervalMs)) return false;
      const leader = toHex(this.leaderOf(m.contract, k));
      if (String(x.record.leader) !== leader) return false;
      const rec = this.#recordId(roundIdBytes, x.record);
      if (!rec.ok || rec.id !== String(x.batchId)) return false;
      return verifySchnorr(fromHex(String(x.record.leaderSig)), fromHex(rec.id), fromHex(leader));
    } catch { return false; }
  }

  /**
   * LEAD BATCH k (the round's seat k mod n, at its cutoff). `dropCertificate` (a test of a leader that stops after collecting
   * the signatures): the certificate is not handed out. Answers { ok, batchId, orderIds, heldBy, certified, decided, timings }.
   */
  async lead(roundIdBytes, k, { dropCertificate = false } = {}) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    if (!this.leads(roundIdBytes, k)) return refuse(`batch ${k} is led by the round's seat ${BigInt(k) % BigInt(m.contract.nodes.length)}, not this one`);
    // A CLOSED MARKET ASKS NOBODY (kanban #576, measured 2026-10-23 02:1xZ on test host seat 1: 2,346 batch-proposal requests a minute,
    // every one for one of the 23 book rounds it held - all closed, none with an undecided batch): nothing trades after the close
    // (#check refuses such a batch), so only a batch still pending here is decided; the seats holding one pending lead it in turn
    if (BigInt(this.cutoffOf(k)) > m.contract.entryCloseMs + BigInt(this.intervalMs) && !this.pending(roundIdBytes).length) return { ok: true, empty: true, decided: [] };
    const rid = toHex(roundIdBytes);
    const t0 = this.now();
    const peers = this.peersFor(roundIdBytes);
    const asked = await Promise.all(peers.map((base) => this.#proposalOf(base, rid, k)));
    const proposals = [this.proposal(roundIdBytes, k), ...asked.filter(Boolean)];
    const tProposals = this.now();
    // 1. EVERY PENDING BATCH FIRST: certified, void, or the book waits
    const pending = new Map();
    // A PENDING ITEM COUNTS ONLY IF ITS LEADER SIGNED IT (kanban #1519: one seat listing an invented batch - junk leaderSig, or no
    // record at all - made every leader's lead() refuse "still undecided" or throw, for every batch after: no seat signs it and none can
    // decline it, #askStands refusing an unsigned set). Checked as #askStands checks a void ask: k inside the round's book, the record
    // reads, its id is the batchId named, and k's leader signed that id; anything else is skipped, never thrown on.
    // ONLY A BATCH THAT CAN BE DECIDED NOW HOLDS THE BOOK (kanban #1697, #1762: a seat leads every n-th batch, so it signed a record for a
    // later batch k' it leads and listed it pending - no seat can decline k' before cutoff(k') + interval, and every leader before k'
    // refused "still undecided"; a past leader signed a second set for its own batch already certified - every seat answers the
    // certificate under the other id, nobody declines, and the book froze for good). A pending k' above the batch led here is skipped:
    // its own leader decides it in its turn (it is k there). A k this seat holds CERTIFIED under another id is decided: skipped too.
    const ridBuf = Buffer.from(roundIdBytes);
    const certifiedHere = (kn) => { const r = this.db.prepare('SELECT batch_id, certificate FROM market_batches WHERE round_id = ? AND k = ?').get(ridBuf, kn); return r && r.certificate ? String(r.batch_id) : null; };
    for (const p of proposals) for (const x of Array.isArray(p.pending) ? p.pending : []) {
      if (!this.#pendingStands(roundIdBytes, m, x)) continue;
      if (Number(x.k) > Number(k)) continue;
      const held = certifiedHere(Number(x.k));
      if (held !== null && held !== String(x.batchId)) continue;
      if (!pending.has(String(x.k))) pending.set(String(x.k), { ids: new Map(), sigs: [] });
      const q = pending.get(String(x.k));
      if (x.ownSig) q.sigs.push({ seat: p.seat, signature: x.ownSig, batchId: x.batchId });
      q.sigs.push({ seat: x.record.leader, signature: x.record.leaderSig, batchId: x.batchId });
      q.ids.set(x.batchId, x.record);
    }
    const decided = [];
    for (const [pk, q] of [...pending].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      // the set most seats signed (an honest seat signs one set per batch)
      const tally = (bid) => q.sigs.filter((s) => s.batchId === bid).length;
      const [id, record] = [...q.ids].sort((a, b) => tally(b[0]) - tally(a[0]))[0];
      const d = await this.#decide(roundIdBytes, m, pk, record, id, q.sigs.filter((s) => s.batchId === id), peers, { sigs: q.sigs, records: q.ids });
      decided.push({ k: pk, ...d });
      if (d.state === 'PENDING') return refuse(`batch ${pk} is still undecided (${d.why}): the book does not move on before it is`);
    }
    // A VOID BATCH'S ORDERS ARE UNBATCHED AGAIN at every seat now: the proposals are asked once more, so they count
    if (decided.some((d) => d.state === 'VOID')) {
      const again = await Promise.all(peers.map((base) => this.#proposalOf(base, rid, k)));
      proposals.splice(0, proposals.length, this.proposal(roundIdBytes, k), ...again.filter(Boolean));
    }
    // 2. THE NEW SET: orders tradable at at least the threshold of seats; every cancel and sell that stands
    const seen = new Map();
    for (const p of proposals) for (const o of p.orders || []) seen.set(o, (seen.get(o) || 0) + 1);
    // an order the leader itself holds tradable, unbatched, from before the cutoff and the close (its own #check asks the same)
    const limit = Math.min(this.cutoffOf(k), Number(m.contract.entryCloseMs));
    const readyHere = (o) => { const r = this.db.prepare('SELECT batch, received_ms FROM market_orders WHERE order_id = ?').get(o); return !!r && r.batch === null && Number(r.received_ms) < limit; };
    const orders = [...seen].filter(([o, n]) => n >= m.needed && readyHere(o)).map(([o]) => o).sort();
    const cancels = new Map();
    const sells = new Map();
    const eventBatched = (id) => { const r = this.db.prepare('SELECT batch FROM market_book_events WHERE event_id = ?').get(id); return !!r && r.batch !== null; };
    for (const p of proposals) {
      for (const c of p.cancels || []) { const x = this.#cancelStands(roundIdBytes, c); if (x.ok && !cancels.has(x.id) && !eventBatched(x.id)) cancels.set(x.id, c); }
      for (const s of p.sells || []) { const x = this.#sellStands(roundIdBytes, s); if (x.ok && !sells.has(x.id) && !eventBatched(x.id)) sells.set(x.id, s); }
    }
    const record = { k: String(k), orders, cancels: [...cancels.values()], sells: [...sells.values()], leader: toHex(this.round.pubkey) };
    // a sell beyond what its entry holds unsold is left out (the seats would refuse the whole set over it) - by its id, once (kanban #1526:
    // the refused list was searched with a fresh #sellStands per sell, quadratic in the sells)
    // and a cancel whose order neither the book nor this set holds waits for a later batch (kanban #1489: the seats refuse the set over it)
    { const L = this.ledger(roundIdBytes, record); if (L.ok && L.refused.length) {
      const no = new Set(L.refused.map((r) => r.id));
      record.sells = [...sells].filter(([id]) => !no.has(id)).map(([, s]) => s);
      record.cancels = record.cancels.filter((c) => !L.refused.some((r) => r.id === c.entry && r.why.startsWith('a cancel')));
    } }
    if (!record.orders.length && !record.cancels.length && !record.sells.length) return { ok: true, empty: true, decided };
    const idc = this.#recordId(roundIdBytes, record);
    if (!idc.ok) return idc;
    record.leaderSig = toHex(schnorr.sign(fromHex(idc.id), this.round.identity.secret));
    const own = this.accept(roundIdBytes, record);
    if (!own.ok) return own;
    const answers = await Promise.all(peers.map((b) => this.#post(b, `/batch?round=${rid}`, record)));
    const tSigned = this.now();
    const sigs = this.#counted(m, idc.id, [{ seat: own.seat, signature: own.signature }, ...answers.filter((a) => a.ok).map((a) => ({ seat: a.seat, signature: a.signature }))]);
    let certified = false;
    if (sigs.length >= m.needed && !dropCertificate) {
      const cert = { record, sigs };
      const mine = this.certify(roundIdBytes, cert);
      if (!mine.ok) return mine;
      await Promise.all(peers.map((b) => this.#post(b, `/batch-certificate?round=${rid}`, cert)));
      certified = true;
    }
    return { ok: true, batchId: idc.id, orderIds: orders, cancels: record.cancels.length, sells: record.sells.length, heldBy: sigs.length, of: m.contract.nodes.length,
      certified, decided, refused: answers.filter((a) => !a.ok).map((a) => a.why),
      timings: { proposalsMs: tProposals - t0, signedMs: tSigned - t0, certifiedMs: this.now() - t0 } };
  }

  /**
   * Every certified batch of the round with its certificate (GET /book-certificates), for a seat that missed one - with `after`, only
   * those numbered after it (the reader's cursor, kanban #740).
   */
  certificates(roundIdBytes, after = null) {
    const rows = after === null
      ? this.db.prepare('SELECT k, record, certificate FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL ORDER BY k').all(Buffer.from(roundIdBytes))
      : this.db.prepare('SELECT k, record, certificate FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL AND k > ? ORDER BY k').all(Buffer.from(roundIdBytes), Number(after));
    return rows
      .map((r) => ({ k: String(r.k), record: JSON.parse(r.record), sigs: JSON.parse(r.certificate) }));
  }

  /** An order whole at this seat: its entry, its stake lock, and the handout its entry names (kanban #620). */
  #orderWhole(entryHex) {
    const id = fromHex(entryHex);
    const raw = this.round.entry(id);
    if (!raw || !this.round.stakeLock(id)) return false;
    const ref = decodeEntryContract(raw).vssSharesRef;
    return !ref || ref.every((b) => b === 0) || typeof this.round.handout !== 'function' || !!this.round.handout(ref);
  }

  /** Before a settlement: every certified batch another seat holds and this one does not, imported on its certificate - read again now. */
  async carry(roundIdBytes) { return this.sync(roundIdBytes, { force: true }); }

  /**
   * THE ROUND'S CERTIFIED BATCHES FROM THE OTHER SEATS, ONCE PER ROUND (kanban #740, measured 2026-10-28 00:2xZ, Up/Down round 5d4cbd41,
   * 7 seats, threshold 5: five seats held batches 3586289144 (one Up order) and 3586289193 (one Down order), 193 filled at 40c; two
   * overloaded seats never received 144's record or certificate, cleared 193 alone - price null, no fill - and answered the settlement
   * "no order filled: nothing is claimed", so 3 of the 5 signer nodes needed committed and nothing settled. Batch numbers are time
   * slots: a seat cannot see that a batch it never heard of exists, and "the book does not move on before an earlier batch is decided"
   * covers only the batches it knows). Every other signer seat of the round is asked GET /book-certificates at once, each with a short
   * timeout, and every certificate this seat lacks is taken through certify - the door POST /batch-certificate uses, signatures checked.
   * The read ends once the threshold of seats (this one counted) answered, or at the timeout; an answer that comes later is still
   * taken. The threshold matters: any batch the seats certified carries that many signatures, so any threshold of seats holds at least
   * one that signed it. Answers { ok, heard, needed, fresh } - not ok while fewer than the threshold answered (the settlement then says
   * "not yet", never "no order filled"). KEPT PER ROUND once the threshold answered, every certificate offered was taken, every order
   * is whole here and no seat named a batch still pending there: one read per round per seat (the seats that hit this are the
   * overloaded ones), not one per settle pass. `force` reads again (a settlement whose fills another seat rebuilt otherwise).
   */
  async sync(roundIdBytes, { force = false } = {}) {
    const key = toHex(roundIdBytes);
    const kept = this.#synced.get(key);
    if (kept && kept.state === SYNC_STATE.KEPT && !force) return { ok: true, heard: kept.heard, needed: kept.needed, fresh: 0, kept: true };
    if (this.#syncing.has(key)) return this.#syncing.get(key);
    const p = this.#syncOnce(roundIdBytes).finally(() => this.#syncing.delete(key));
    this.#syncing.set(key, p);
    return p;
  }
  #synced = new Map();    // round id hex -> { state, epoch, heard, needed } (SYNC_STATE, kanban #1182)
  /**
   * THE ONE TRANSITION OF A ROUND'S READ (kanban #1182), compare-and-set on its epoch:
   *   'kept' { epoch, heard, needed }  -> KEPT, only when no certificate was stored since the read began (its epoch is the round's still)
   *   'certified' { k }                -> STALE, the epoch moves on; a k at or below a seat's cursor (a lower k certified late) drops the
   *                                       round's cursors too, so the next read lists every batch again
   * A read is kept no longer than the book it read: a later certificate (a lower k another seat certified late) is read again.
   */
  #syncStep(rid, ev) {
    const was = this.#synced.get(rid) || { state: SYNC_STATE.UNREAD, epoch: 0 };
    if (ev.kind === 'kept') {
      if (ev.epoch !== was.epoch) return { ok: false, why: 'a certificate was stored during the read' };
      this.#synced.delete(rid);
      this.#synced.set(rid, { state: SYNC_STATE.KEPT, epoch: was.epoch, heard: ev.heard, needed: ev.needed });
      if (this.#synced.size > 4096) this.#synced.delete(this.#synced.keys().next().value);
      return { ok: true };
    }
    if (ev.kind === 'certified') {
      const cursors = this.#after.get(rid);
      if (cursors && [...cursors.values()].some((c) => Number(ev.k) <= Number(c))) this.#after.delete(rid);
      // nothing kept or in flight: nothing to move (no entry is made for a round never read)
      if (!this.#synced.has(rid) && !this.#syncing.has(rid)) return { ok: true };
      this.#synced.set(rid, { state: SYNC_STATE.STALE, epoch: was.epoch + 1 });
      return { ok: true };
    }
    return { ok: false, why: 'no such step' };
  }
  /** The state of a round's read of the other seats here (SYNC_STATE). */
  syncState(roundIdBytes) { const x = this.#synced.get(toHex(roundIdBytes)); return x ? x.state : SYNC_STATE.UNREAD; }
  // A REPLAY THAT FAILED IS NOT ASKED AGAIN AT ONCE (kanban #1087, measured 2026-11-03 on a live seat: 108 refusals a minute, the same 6
  // orders of old rounds asked of 18 peers each settle pass, each refused because the stake lock is older than the freshness window - a
  // refusal no later block can lift). An order refused for that reason is not replayed again; any other refusal waits REPLAY_RETRY_MS,
  // across every peer, before the order is asked again. The batch stays incomplete as before.
  #replayGate = null;
  #syncing = new Map();   // round id hex -> the read in flight
  // THE CURSOR PER ROUND AND SEAT (kanban #740 ruling, 2026-10-28: the seats ran out of memory): round id hex -> Map(seat base -> k),
  // the last batch of that seat's list this seat holds with every earlier one it listed - the next read asks only for later batches
  #after = new Map();

  async #syncOnce(roundIdBytes) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const rid = toHex(roundIdBytes);
    const epoch = (this.#synced.get(rid) || { epoch: 0 }).epoch;   // the read is kept only if no certificate is stored meanwhile
    const peers = this.peersFor(roundIdBytes);
    // A BATCH CERTIFIED HERE ALREADY IS NOT LOOKED AT AGAIN (kanban #576, profiled 2026-10-24 12:4xZ on test host seat 1: every peer hands
    // every certified batch of the round, and certify() read and decoded the round's contract and hashed the batch for each one - ~3 % of
    // the main thread - to answer "held already" or refuse)
    const held = new Set(this.db.prepare('SELECT k FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL').all(Buffer.from(roundIdBytes)).map((r) => String(r.k)));
    const state = { answered: 0, fresh: 0, complete: true, unheard: [] };
    if (!this.#after.has(rid)) this.#after.set(rid, new Map());
    if (this.#after.size > 4096) this.#after.delete(this.#after.keys().next().value);
    const cursors = this.#after.get(rid);
    let reached = () => {};
    const enough = new Promise((resolve) => { reached = resolve; });
    const ask = async (base) => {
      let body;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      try {
        const late = new Promise((_, reject) => { timer = setTimeout(() => { if (ac) ac.abort(); reject(new Error(`no answer in ${this.syncTimeoutMs} ms`)); }, this.syncTimeoutMs); });
        late.catch(() => {});
        // ONLY THE BATCHES AFTER THE CURSOR (an older seat ignores `after` and lists them all; what is held here is skipped)
        const after = cursors.get(base);
        const r = await Promise.race([this.fetcher(`${base}/book-certificates?round=${rid}${after === undefined ? '' : `&after=${after}`}`, ac ? { signal: ac.signal } : undefined), late]);
        if (!r.ok) throw new Error(`answered ${r.status}`);
        body = await Promise.race([r.json(), late]);
        if (!body || !Array.isArray(body.certificates)) throw new Error('answered no list of certificates');
      } catch (e) { state.unheard.push(`${base}: ${e.message}`); return; } finally { clearTimeout(timer); }
      const next = await this.#take(roundIdBytes, rid, base, body, held, state, cursors.get(base));
      if (next !== undefined) cursors.set(base, next);
      state.answered += 1;
      if (1 + state.answered >= m.needed) reached();
    };
    const all = Promise.all(peers.map(ask));
    if (1 >= m.needed) reached();
    await Promise.race([enough, all]);
    const heard = 1 + state.answered;
    if (heard < m.needed)
      return { ok: false, status: 409, heard, needed: m.needed, fresh: state.fresh,
        why: `${heard} of the ${m.needed} seats' certified batches heard here${state.unheard.length ? ` (${state.unheard.slice(0, 3).join('; ')})` : ''}` };
    if (state.complete) this.#syncStep(rid, { kind: 'kept', epoch, heard, needed: m.needed });
    if (state.fresh) console.log(`[orders] ${rid.slice(0, 16)}: ${state.fresh} certified batch(es) this seat had missed taken from the other seats (${heard} of ${m.needed} heard)`);
    return { ok: true, heard, needed: m.needed, fresh: state.fresh };
  }

  /**
   * One seat's GET /book-certificates answer taken here: what this seat lacks certified, and the orders a held batch lacks. Answers that
   * seat's next cursor: the last batch it listed up to which every listed batch is held and whole here, below any batch still pending
   * there - a batch refused or an order not replayed is listed again on the next read (undefined: no batch to move the cursor to).
   */
  async #take(roundIdBytes, rid, base, body, held, state, after) {
    const done = new Map();   // k -> whether the batch is held here with every order whole
    let below = Infinity;     // the cursor stays below a batch still pending at that seat
    // A BATCH STILL PENDING AT THAT SEAT (its answer's `pending`, absent from an older seat): it may be certified after this read, so
    // the read is not kept and the next settle pass asks again
    for (const k of Array.isArray(body.pending) ? body.pending : []) {
      if (!held.has(String(k))) state.complete = false;
      if (/^[0-9]{1,15}$/.test(String(k))) below = Math.min(below, Number(k));
    }
    for (const cert of body.certificates) {
      const k = cert && cert.record ? String(cert.record.k) : null;
      if (k === null || !/^[0-9]{1,15}$/.test(k)) continue;
      done.set(k, false);
      // A BATCH HELD HERE WHOSE ORDER IS NOT WHOLE HERE (kanban #620, fed2-3 16:51Z: the entry and locks replayed, then "a loser's P could
      // not be opened: this node accepted no handout for that entry"): what is missing is replayed from this peer
      if (k !== null && held.has(k)) {
        if (typeof this.replayOrder === 'function' && Array.isArray(cert.record.orders))
          for (const o of cert.record.orders) if (isHex(String(o), 32) && !this.#orderWhole(String(o)))
            if (!(await this.#replay(rid, k, String(o), base))) { state.complete = false; done.set(k, null); }
        if (done.get(k) === false) done.set(k, true);
        continue;
      }
      let got = this.certify(roundIdBytes, cert, { reading: true });
      // A CERTIFIED BATCH NAMING AN ORDER THAT NEVER REACHED THIS SEAT (kanban #620: round 42835aaa never settled - two seats lacked
      // one order of batch 3585700432, refused its certificate here without a word, and rebuilt another settlement): the batch's orders
      // this seat lacks are replayed from the seat that handed it (replayOrder: the entry checked by its hash, its locks by the
      // federation), then the certificate is taken again. A refusal that stands is said.
      if (!got.ok && /holds no entry/.test(String(got.why)) && typeof this.replayOrder === 'function' && Array.isArray(cert.record.orders)) {
        for (const o of cert.record.orders) if (isHex(String(o), 32) && !this.#orderWhole(String(o))) await this.#replay(rid, k, String(o), base);
        got = this.certify(roundIdBytes, cert, { reading: true });
      }
      if (got.ok) { held.add(k); done.set(k, true); if (got.fresh) state.fresh += 1; }
      else { state.complete = false; console.log(`[orders] ${rid.slice(0, 16)} batch ${k}: the certificate ${base} holds is not taken here: ${got.why}`); }
    }
    let next = after;
    for (const k of [...done.keys()].map(Number).sort((x, y) => x - y)) {
      if (k >= below || done.get(String(k)) !== true) break;
      if (next === undefined || k > next) next = k;
    }
    return next;
  }

  async #replay(rid, k, o, base) {
    if (!this.#replayGate) this.#replayGate = new ReplayGate({ now: () => this.now() });
    if (!this.#replayGate.allow(o)) return false;
    const refused = (why) => {
      const forever = this.#replayGate.refused(o, why);
      console.log(`[orders] ${rid.slice(0, 16)} batch ${k}: order ${o.slice(0, 16)} not replayed from ${base}: ${why}${forever ? ' (not asked again)' : ''}`);
      return false;
    };
    try {
      const r = await this.replayOrder(o, base);
      if (!r.ok) return refused(r.why);
      this.#replayGate.taken(o);
      return true;
    } catch (e) { return refused(e.message); }
  }

  /** The batches of the round this seat signed and nobody certified or voided yet. */
  pending(roundIdBytes) {
    return this.db.prepare('SELECT k FROM market_batches WHERE round_id = ? AND certificate IS NULL ORDER BY k').all(Buffer.from(roundIdBytes)).map((r) => Number(r.k));
  }

  /**
   * WHAT THE RETURN DOOR MAY DO WITH AN ORDER'S LOCKS (comment 1127): { book, filled, cancelled, inPending } - a filled order's
   * locks are closed until settlement (a whole return would hand back filled money); an unfilled order whose cancel a
   * certified batch carried comes back at once; an order in a batch not yet decided waits for it.
   */
  standing(roundIdBytes, entryIdBytes) {
    const raw = this.round.entry(entryIdBytes);
    if (!raw) return { book: false };
    // A PLAIN PICK IN A ROUND THAT BECAME A BOOK (§0A.7b, kanban #1411/#1417): not an entry of that round - its lock comes back at once, whole
    if (!isOrder(decodeEntryContract(raw))) return { book: false, wrongType: this.isBook(roundIdBytes) ? 'a plain pick in a round that is an order book (§0A.7b): not an entry of that round, its stake comes back' : null };
    const L = this.ledger(roundIdBytes);
    if (!L.ok) return { book: true, filled: true, cancelled: false, inPending: false, why: L.why };
    const p = L.positions.get(toHex(entryIdBytes));
    // ANY BATCH OF THE ROUND UNDECIDED HERE, not only the order's own (kanban #1150: a batch this seat signed below a certified cancel can
    // still be certified and fill the order; "cancelled, unfilled" was said before it was decided). Every seat that signed a batch holds it
    // signed or certified, and any threshold of seats holds one of them: no threshold of seats returns a lock a certified batch filled.
    const inPending = this.pending(roundIdBytes).length > 0;
    return { book: true, filled: positionFilled(p), cancelled: !!(p && p.cancelled), inPending };
  }

  /** GET /market-rounds: the rounds that took orders here since `sinceMs` (at most 2 days back), newest first, at
   *  most 200 - where a player's own orders are read back from after a reload, open or closed. Ids only: each round's contract
   *  is fetched by its id and hashes to it. */
  recentRounds(sinceMs, nowMs = Date.now()) {
    const from = Math.max(Number(sinceMs) || 0, nowMs - 2 * 24 * 3600 * 1000);
    return this.db.prepare('SELECT round_id, MAX(received_ms) AS last FROM market_orders WHERE received_ms >= ? GROUP BY round_id ORDER BY last DESC LIMIT 200')
      .all(from).map((r) => ({ round: toHex(new Uint8Array(r.round_id)), lastOrderMs: r.last }));
  }

  /** GET /book: the certified batches as this seat clears them, and every position. */
  cleared(roundIdBytes) {
    const L = this.ledger(roundIdBytes);
    if (!L.ok) return L;
    const ids = this.db.prepare('SELECT k, batch_id FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL ORDER BY k').all(Buffer.from(roundIdBytes));
    return { ok: true, batches: L.batches.map((b, i) => ({ ...b, batchId: ids[i] && ids[i].batch_id })), refused: L.refused, resting: L.resting, levels: L.levels, pending: this.pending(roundIdBytes),
      positions: [...L.positions.values()].map((p) => ({ entry: p.entry, outcome: p.outcome, shares: p.shares, cost: p.cost, buyFee: p.buyFee, sellDebt: p.sellDebt, sellFee: p.sellFee, cancelled: p.cancelled })) };
  }
}
