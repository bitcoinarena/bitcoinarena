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
//       (POST /batch-certificate). Else the leader asks every seat (POST /batch-void-ask): a seat holding the record answers
//       its signature; a seat that never signed DECLINES - it never signs that batch afterwards. Once enough have declined
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
import { bookBatchId, batchDeclineId, cancelId, sellId, BATCH_MS, PRICE_SCALE, TICK } from '../../arena-protocol/src/order-book.js';
import { bookLedger, positionFilled } from '../../arena-protocol/src/book-ledger.js';
import { entryFeeBpsOf, feeBpsOf, donationBpsOf, reserveBpsOf } from '../../arena-protocol/src/fee.js';
import { marketBps } from '../../arena-protocol/src/fee-proposal.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';
import { marketOfRound } from '../../arena-protocol/src/manifest.js';

const refuse = (why, status = 409) => ({ ok: false, status, why });
const verifyEd = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
const verifySchnorr = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
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

export class OrderBook {
  constructor(round, { plugins, peersFor = () => [], fetcher = (u, o) => fetch(u, o), now = () => Date.now(), intervalMs = Number(BATCH_MS), feesFor = null } = {}) {
    this.round = round;
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
      needed: receiptsNeeded(contract.nodes.length), seats: contract.nodes.map(toHex) };
  }

  /** Whether that round is an order book at this seat: a market whose entries are orders. */
  isBook(roundIdBytes) {
    const m = this.market(roundIdBytes);
    return m.ok && this.round.entriesOf(roundIdBytes).some((x) => isOrder(x.entry));
  }

  leaderOf(contract, k) { return contract.nodes[Number(BigInt(k) % BigInt(contract.nodes.length))]; }

  leads(roundIdBytes, k) {
    const row = this.round.get(roundIdBytes);
    return !!row && toHex(this.leaderOf(decodeRoundContract(new Uint8Array(row.contract)), k)) === toHex(this.round.pubkey);
  }

  cutoffOf(k) { return (Number(k) + 1) * this.intervalMs; }

  /** An order's locks were verified here: it is tradable from now (the lock doors call this). */
  noteTradable(roundIdBytes) { if (this.market(roundIdBytes).ok) this.#syncTradable(roundIdBytes); }

  /** The orders of a round that are tradable here: entries with a limit price whose two locks this seat verified. */
  #syncTradable(roundIdBytes) {
    const put = this.db.prepare('INSERT OR IGNORE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, ?, ?, NULL)');
    for (const { entryId, entry } of this.round.entriesOf(roundIdBytes)) {
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

  /** A sell, checked: a whole cent, signed by its entry's session key over sellId (what it holds is the ledger's question). */
  #sellStands(roundIdBytes, s) {
    if (!s || !isHex(s.signature, 64) || !/^[0-9]{1,20}$/.test(String(s.price)) || !/^[0-9]{1,20}$/.test(String(s.sharesMsat)) || !/^[0-9]{1,20}$/.test(String(s.nonce)))
      return refuse('a sell is { entry, outcome, price, sharesMsat, nonce, signature }', 400);
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
    const fresh = this.db.prepare('INSERT OR IGNORE INTO market_book_events (event_id, round_id, kind, entry_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(c.id, Buffer.from(roundIdBytes), kind, String(body.entry), JSON.stringify(body), this.now()).changes === 1;
    return { ok: true, id: c.id, fresh };
  }

  /** GET /batch-proposal: this seat's unbatched orders, cancels and sells before batch k's cutoff, and its pending batches. */
  proposal(roundIdBytes, k) {
    this.#syncTradable(roundIdBytes);
    const cutoff = this.cutoffOf(k);
    const rid = Buffer.from(roundIdBytes);
    const orders = this.db.prepare('SELECT order_id FROM market_orders WHERE round_id = ? AND batch IS NULL AND received_ms < ? ORDER BY order_id').all(rid, cutoff).map((r) => r.order_id);
    const events = this.db.prepare('SELECT kind, body FROM market_book_events WHERE round_id = ? AND batch IS NULL AND received_ms < ? ORDER BY event_id').all(rid, cutoff);
    const pending = this.db.prepare('SELECT k, batch_id, record, own_sig FROM market_batches WHERE round_id = ? AND certificate IS NULL ORDER BY k').all(rid)
      .map((r) => ({ k: String(r.k), batchId: r.batch_id, record: JSON.parse(r.record), ownSig: r.own_sig }));
    return { seat: toHex(this.round.pubkey), k: String(k), orders,
      cancels: events.filter((e) => e.kind === 'cancel').map((e) => JSON.parse(e.body)),
      sells: events.filter((e) => e.kind === 'sell').map((e) => JSON.parse(e.body)), pending };
  }

  /** The id of a batch record: its orders, cancels and sells, by their ids. */
  #recordId(roundIdBytes, record) {
    const ids = [...record.orders];
    for (const c of record.cancels || []) { const x = this.#cancelStands(roundIdBytes, c); if (!x.ok) return x; ids.push(x.id); }
    const sells = [];
    for (const s of record.sells || []) { const x = this.#sellStands(roundIdBytes, s); if (!x.ok) return x; ids.push(x.id); sells.push(x.sell); }
    let id;
    try { id = bookBatchId({ roundId: roundIdBytes, k: BigInt(record.k), orderIds: ids }); } catch (e) { return refuse(e.message, 400); }
    return { ok: true, id: toHex(id), sells };
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

  /** A record's checks at this seat: answers { ok, id, k } or why it does not stand. `importing`: a certified record. */
  #check(roundIdBytes, m, record, { importing = false } = {}) {
    if (!record || !/^[0-9]{1,15}$/.test(String(record.k)) || !Array.isArray(record.orders)) return refuse('a batch is { k, orders, cancels, sells, leader, leaderSig }', 400);
    const k = BigInt(record.k);
    if (BigInt(this.cutoffOf(k)) > m.contract.entryCloseMs + BigInt(this.intervalMs)) return refuse(`batch ${k} is after the market closed: nothing trades after its close`);
    const leader = toHex(this.leaderOf(m.contract, k));
    if (String(record.leader) !== leader) return refuse(`batch ${k} is led by the round's seat ${k % BigInt(m.contract.nodes.length)}, not ${String(record.leader).slice(0, 16)}`);
    const rid = Buffer.from(roundIdBytes);
    if (!importing) {
      this.#syncTradable(roundIdBytes);
      for (const id of record.orders) {
        const row = isHex(id, 32) ? this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ? AND round_id = ?').get(id, rid) : null;
        if (!row) return refuse(`order ${String(id).slice(0, 16)}: this seat has not verified its locks`);
        if (row.batch !== null && Number(row.batch) !== Number(k)) return refuse(`order ${id.slice(0, 16)} is in batch ${row.batch} at this seat`);
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
    }
    return { ok: true, id: rec.id, k };
  }

  /** POST /batch: the leader's set for batch k - held here and signed, or refused by name. */
  accept(roundIdBytes, record) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const c = this.#check(roundIdBytes, m, record);
    if (!c.ok) return c;
    const rid = Buffer.from(roundIdBytes);
    if (this.db.prepare('SELECT 1 FROM market_batch_declines WHERE round_id = ? AND k = ?').get(rid, Number(c.k))) return refuse(`this seat declined batch ${c.k}: it never signs it`);
    const held = this.db.prepare('SELECT batch_id, own_sig, stored_ms FROM market_batches WHERE round_id = ? AND k = ?').get(rid, Number(c.k));
    if (held && held.batch_id !== c.id) return refuse(`this seat already signed another set for batch ${c.k}: ${held.batch_id.slice(0, 16)}`);
    if (held && held.own_sig) return { ok: true, seat: toHex(this.round.pubkey), signature: held.own_sig, storedAtMs: Number(held.stored_ms), fresh: false };
    const pendingBefore = this.db.prepare('SELECT k FROM market_batches WHERE round_id = ? AND k < ? AND certificate IS NULL').get(rid, Number(c.k));
    if (pendingBefore) return refuse(`batch ${pendingBefore.k} is not decided at this seat: the book does not move on before it is`);
    const signature = toHex(schnorr.sign(fromHex(c.id), this.round.identity.secret));
    const storedAtMs = this.now();
    this.#store(roundIdBytes, c.k, c.id, record, signature, null, storedAtMs);
    return { ok: true, seat: toHex(this.round.pubkey), signature, storedAtMs, fresh: true };
  }

  #store(roundIdBytes, k, id, record, ownSig, certificate, at) {
    const rid = Buffer.from(roundIdBytes);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (round_id, k) DO UPDATE SET certificate = COALESCE(excluded.certificate, certificate)')
        .run(rid, Number(k), id, JSON.stringify(record), ownSig, certificate, at);
      const putOrder = this.db.prepare('INSERT INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, \'\', ?, ?) ON CONFLICT (order_id) DO UPDATE SET batch = excluded.batch');
      for (const o of record.orders) putOrder.run(o, rid, at, Number(k));
      const putEvent = this.db.prepare('INSERT INTO market_book_events (event_id, round_id, kind, entry_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET batch = excluded.batch');
      for (const c of record.cancels || []) putEvent.run(this.#cancelStands(roundIdBytes, c).id, rid, 'cancel', c.entry, JSON.stringify(c), at, Number(k));
      for (const s of record.sells || []) putEvent.run(this.#sellStands(roundIdBytes, s).id, rid, 'sell', s.entry, JSON.stringify(s), at, Number(k));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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

  /** POST /batch-certificate: a batch with at least the threshold of the round's seats' signatures - in the book from now. */
  certify(roundIdBytes, cert) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    const c = this.#check(roundIdBytes, m, cert && cert.record, { importing: true });
    if (!c.ok) return c;
    const sigs = this.#counted(m, c.id, (cert && cert.sigs) || []);
    if (sigs.length < m.needed) return refuse(`that certificate carries ${sigs.length} seats' signatures and batch ${c.k} needs ${m.needed}`, 403);
    const rid = Buffer.from(roundIdBytes);
    const held = this.db.prepare('SELECT batch_id, own_sig, certificate FROM market_batches WHERE round_id = ? AND k = ?').get(rid, Number(c.k));
    if (held && held.batch_id !== c.id) return refuse(`this seat holds another set for batch ${c.k}: two certified sets for one batch cannot be`);
    if (held && held.certificate) return { ok: true, fresh: false };
    this.#store(roundIdBytes, c.k, c.id, cert.record, held ? held.own_sig : null, JSON.stringify(sigs), this.now());
    return { ok: true, fresh: true };
  }

  /** POST /batch-void-ask: this seat's signature if it signed batch k, else its decline - and it never signs k after. */
  voidAsk(roundIdBytes, k) {
    const rid = Buffer.from(roundIdBytes);
    const held = this.db.prepare('SELECT batch_id, own_sig FROM market_batches WHERE round_id = ? AND k = ?').get(rid, Number(k));
    const seat = toHex(this.round.pubkey);
    if (held && held.own_sig) return { ok: true, seat, signed: held.own_sig, batchId: held.batch_id };
    this.db.prepare('INSERT OR IGNORE INTO market_batch_declines (round_id, k) VALUES (?, ?)').run(rid, Number(k));
    return { ok: true, seat, declined: toHex(schnorr.sign(batchDeclineId({ roundId: roundIdBytes, k: BigInt(k) }), this.round.identity.secret)) };
  }

  /** POST /batch-void: enough seats declined batch k that the threshold can no longer be reached - its orders wait again. */
  applyVoid(roundIdBytes, body) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    if (!body || !/^[0-9]{1,15}$/.test(String(body.k))) return refuse('a void is { k, declines }', 400);
    const k = BigInt(body.k);
    const msg = batchDeclineId({ roundId: roundIdBytes, k });
    const ok = new Set();
    for (const d of body.declines || []) if (d && isHex(d.seat, 32) && isHex(d.signature, 64) && m.seats.includes(d.seat) && verifySchnorr(fromHex(d.signature), msg, fromHex(d.seat))) ok.add(d.seat);
    const enough = m.contract.nodes.length - m.needed + 1;
    if (ok.size < enough) return refuse(`${ok.size} seats declined batch ${k} and it is void only once ${enough} have: ${m.needed} could still sign it`, 403);
    const rid = Buffer.from(roundIdBytes);
    const held = this.db.prepare('SELECT certificate FROM market_batches WHERE round_id = ? AND k = ?').get(rid, Number(k));
    if (held && held.certificate) return refuse(`batch ${k} is certified here: it cannot be void`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM market_batches WHERE round_id = ? AND k = ?').run(rid, Number(k));
      this.db.prepare('UPDATE market_orders SET batch = NULL WHERE round_id = ? AND batch = ?').run(rid, Number(k));
      this.db.prepare('UPDATE market_book_events SET batch = NULL WHERE round_id = ? AND batch = ?').run(rid, Number(k));
      this.db.prepare('INSERT OR IGNORE INTO market_batch_declines (round_id, k) VALUES (?, ?)').run(rid, Number(k));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ok: true, voided: true };
  }

  async #post(base, path, body) {
    try {
      const r = await this.fetcher(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return { ok: false, why: (await r.text()).trim() };
      return { ok: true, ...(await r.json()) };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  /** A pending batch decided, from the proposals and if need be the seats' answers: certified, void, or still pending. */
  async #decide(roundIdBytes, m, k, record, id, sigs, peers) {
    const rid = toHex(roundIdBytes);
    let counted = this.#counted(m, id, sigs);
    if (counted.length < m.needed) {
      const answers = await Promise.all(peers.map((b) => this.#post(b, `/batch-void-ask?round=${rid}&k=${k}`, {})));
      const own = this.voidAsk(roundIdBytes, k);
      const all = [own, ...answers.filter((a) => a.ok)];
      counted = this.#counted(m, id, [...counted, ...all.filter((a) => a.signed && a.batchId === id).map((a) => ({ seat: a.seat, signature: a.signed }))]);
      if (counted.length < m.needed) {
        const declines = all.filter((a) => a.declined).map((a) => ({ seat: a.seat, signature: a.declined }));
        const voided = this.applyVoid(roundIdBytes, { k: String(k), declines });
        if (!voided.ok) return { state: 'PENDING', why: voided.why };
        await Promise.all(peers.map((b) => this.#post(b, `/batch-void?round=${rid}`, { k: String(k), declines })));
        return { state: 'VOID', declined: declines.length };
      }
    }
    const cert = { record, sigs: counted };
    const mine = this.certify(roundIdBytes, cert);
    if (!mine.ok) return { state: 'PENDING', why: mine.why };
    await Promise.all(peers.map((b) => this.#post(b, `/batch-certificate?round=${rid}`, cert)));
    return { state: 'CERTIFIED', sigs: counted.length };
  }

  /**
   * LEAD BATCH k (the round's seat k mod n, at its cutoff). `dropCertificate` (a test of a leader that stops after collecting
   * the signatures): the certificate is not handed out. Answers { ok, batchId, orderIds, heldBy, certified, decided, timings }.
   */
  async lead(roundIdBytes, k, { dropCertificate = false } = {}) {
    const m = this.market(roundIdBytes);
    if (!m.ok) return m;
    if (!this.leads(roundIdBytes, k)) return refuse(`batch ${k} is led by the round's seat ${BigInt(k) % BigInt(m.contract.nodes.length)}, not this one`);
    const rid = toHex(roundIdBytes);
    const t0 = this.now();
    const peers = this.peersFor(roundIdBytes);
    const asked = await Promise.all(peers.map(async (base) => {
      try { const r = await this.fetcher(`${base}/batch-proposal?round=${rid}&k=${k}`); return r.ok ? await r.json() : null; } catch { return null; }
    }));
    const proposals = [this.proposal(roundIdBytes, k), ...asked.filter(Boolean)];
    const tProposals = this.now();
    // 1. EVERY PENDING BATCH FIRST: certified, void, or the book waits
    const pending = new Map();
    for (const p of proposals) for (const x of p.pending || []) {
      if (!pending.has(x.k)) pending.set(x.k, { ids: new Map(), sigs: [] });
      const q = pending.get(x.k);
      if (x.ownSig) q.sigs.push({ seat: p.seat, signature: x.ownSig, batchId: x.batchId });
      q.sigs.push({ seat: x.record.leader, signature: x.record.leaderSig, batchId: x.batchId });
      q.ids.set(x.batchId, x.record);
    }
    const decided = [];
    for (const [pk, q] of [...pending].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      // the set most seats signed (an honest seat signs one set per batch)
      const tally = (bid) => q.sigs.filter((s) => s.batchId === bid).length;
      const [id, record] = [...q.ids].sort((a, b) => tally(b[0]) - tally(a[0]))[0];
      const d = await this.#decide(roundIdBytes, m, pk, record, id, q.sigs.filter((s) => s.batchId === id), peers);
      decided.push({ k: pk, ...d });
      if (d.state === 'PENDING') return refuse(`batch ${pk} is still undecided (${d.why}): the book does not move on before it is`);
    }
    // A VOID BATCH'S ORDERS ARE UNBATCHED AGAIN at every seat now: the proposals are asked once more, so they count
    if (decided.some((d) => d.state === 'VOID')) {
      const again = await Promise.all(peers.map(async (base) => {
        try { const r = await this.fetcher(`${base}/batch-proposal?round=${rid}&k=${k}`); return r.ok ? await r.json() : null; } catch { return null; }
      }));
      proposals.splice(0, proposals.length, this.proposal(roundIdBytes, k), ...again.filter(Boolean));
    }
    // 2. THE NEW SET: orders tradable at at least the threshold of seats; every cancel and sell that stands
    const seen = new Map();
    for (const p of proposals) for (const o of p.orders || []) seen.set(o, (seen.get(o) || 0) + 1);
    const batchedHere = (o) => { const r = this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ?').get(o); return !!r && r.batch !== null; };
    const orders = [...seen].filter(([o, n]) => n >= m.needed && !batchedHere(o)).map(([o]) => o).sort();
    const cancels = new Map();
    const sells = new Map();
    const eventBatched = (id) => { const r = this.db.prepare('SELECT batch FROM market_book_events WHERE event_id = ?').get(id); return !!r && r.batch !== null; };
    for (const p of proposals) {
      for (const c of p.cancels || []) { const x = this.#cancelStands(roundIdBytes, c); if (x.ok && !cancels.has(x.id) && !eventBatched(x.id)) cancels.set(x.id, c); }
      for (const s of p.sells || []) { const x = this.#sellStands(roundIdBytes, s); if (x.ok && !sells.has(x.id) && !eventBatched(x.id)) sells.set(x.id, s); }
    }
    const record = { k: String(k), orders, cancels: [...cancels.values()], sells: [...sells.values()], leader: toHex(this.round.pubkey) };
    // a sell beyond what its entry holds unsold is left out (the seats would refuse the whole set over it)
    { const L = this.ledger(roundIdBytes, record); if (L.ok && L.refused.length) record.sells = record.sells.filter((s) => !L.refused.some((r) => r.id === this.#sellStands(roundIdBytes, s).id)); }
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

  /** Every certified batch of the round with its certificate (GET /book-certificates), for a seat that missed one. */
  certificates(roundIdBytes) {
    return this.db.prepare('SELECT k, record, certificate FROM market_batches WHERE round_id = ? AND certificate IS NOT NULL ORDER BY k').all(Buffer.from(roundIdBytes))
      .map((r) => ({ k: String(r.k), record: JSON.parse(r.record), sigs: JSON.parse(r.certificate) }));
  }

  /** Before a settlement: every certified batch another seat holds and this one does not, imported on its certificate. */
  async carry(roundIdBytes) {
    const rid = toHex(roundIdBytes);
    for (const base of this.peersFor(roundIdBytes)) {
      let body;
      try { const r = await this.fetcher(`${base}/book-certificates?round=${rid}`); if (!r.ok) continue; body = await r.json(); } catch { continue; }
      for (const cert of (body && body.certificates) || []) this.certify(roundIdBytes, cert);
    }
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
    if (!raw || !isOrder(decodeEntryContract(raw))) return { book: false };
    const L = this.ledger(roundIdBytes);
    if (!L.ok) return { book: true, filled: true, cancelled: false, inPending: false, why: L.why };
    const p = L.positions.get(toHex(entryIdBytes));
    const row = this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ?').get(toHex(entryIdBytes));
    const inPending = !!row && row.batch !== null && this.pending(roundIdBytes).includes(Number(row.batch));
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
