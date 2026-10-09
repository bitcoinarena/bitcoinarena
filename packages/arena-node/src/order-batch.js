// THE SEATS TAKE MARKET ORDERS AND AGREE EACH BATCH'S SET (kanban #278 step 4; the owner 2026-10-09: "Order batches alle 1s,
// wenn möglich alle 0.5s").
//
//   INGEST. POST /order: a player's signed limit order (order-book.js orderStands - its key's signature, a whole cent, at least
//           5 shares, the market's fee), for a two-outcome market this seat hosts, before the round's entry close. Kept once,
//           with the time it reached THIS seat. The page posts it to every seat.
//   AGREE.  Batch k takes what reached any seat before its cutoff, (k + 1) x the interval (ms since the epoch: every seat names
//           the same k from its clock). Its LEADER is the round's seat k mod n - the leadership rotates, so a seat that is down
//           only delays its own batches' orders into the next. At the cutoff the leader asks every seat for its unbatched
//           orders (GET /batch-proposal), takes their union - each order checked again, whoever handed it over - and hands
//           the set, with its own signature over batchId, to every seat (POST /batch). Each seat checks the leader is the
//           round's seat k mod n, every order, that none of them is in another batch here and that it signed no other set
//           for (round, k); it keeps the orders it lacked, marks the set as batch k, and answers its own signature over the
//           same batchId. Every seat that answered holds the same set, so each clears it the same way (bookBatch is pure).
//   NOT YET (later slices): orders backed by locks (positions), cancel of a standing order, a leader that is down for a
//           batch it was due to lead (its orders wait for the next leader's batch, which takes everything before its cutoff).
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { orderId, orderStands, orderToJson, orderFromJson, batchId, bookBatch, BATCH_MS } from '../../arena-protocol/src/order-book.js';
import { entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pluginForRound } from './plugins.js';

const refuse = (why, status = 409) => ({ ok: false, status, why });
const verifyEd = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };

export class OrderBook {
  /**
   * `plugins`: the games this seat hosts; `peersFor(rid)`: the other seats' bases; `intervalMs`: the batch interval (BATCH_MS,
   * 1 s; 0.5 s where measured to hold); `fetcher` and `now` as every daemon part takes them.
   */
  constructor(round, { plugins, peersFor = () => [], fetcher = (u, o) => fetch(u, o), now = () => Date.now(), intervalMs = Number(BATCH_MS) } = {}) {
    this.round = round;
    this.plugins = plugins;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    this.now = now;
    this.intervalMs = intervalMs;
    this.db = round.db;
  }

  /** The round's market, or why there is none: a two-outcome attested game this seat hosts. */
  #market(roundIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const found = pluginForRound(contract, this.plugins);
    if (!found.ok || !found.attested) return refuse('that round is not a market this node hosts');
    if ((found.plugin.manifest.outcomes || []).length !== 2) return refuse('the order book trades a two-outcome market (Up / Down)');
    return { ok: true, contract, manifest: found.plugin.manifest, feeBps: entryFeeBpsOf(found.plugin.manifest) };
  }

  /** One order, checked against its round's market: answers { ok, order, id } or why not. */
  #check(json, roundIdBytes = null) {
    let o;
    try { o = orderFromJson(json); } catch (e) { return refuse(e.message, 400); }
    if (roundIdBytes && toHex(o.roundId) !== toHex(roundIdBytes)) return refuse('that order is for another round');
    const m = this.#market(o.roundId);
    if (!m.ok) return m;
    const stands = orderStands(o, { verify: verifyEd, roundId: o.roundId, feeBps: m.feeBps });
    if (!stands.ok) return refuse(stands.why);
    return { ok: true, order: o, id: toHex(stands.id), market: m };
  }

  /** POST /order: kept once, with the time it reached this seat; refused after the round's entry close. */
  ingest(json) {
    const c = this.#check(json);
    if (!c.ok) return c;
    const at = this.now();
    if (BigInt(at) >= c.market.contract.entryCloseMs) return refuse(`the market closed at ${new Date(Number(c.market.contract.entryCloseMs)).toISOString()}: no order after it`);
    const fresh = this.db.prepare('INSERT OR IGNORE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, ?, ?, NULL)')
      .run(c.id, Buffer.from(c.order.roundId), JSON.stringify(orderToJson(c.order)), at).changes === 1;
    return { ok: true, id: c.id, fresh, batchAfterMs: (Math.floor(at / this.intervalMs) + 1) * this.intervalMs };
  }

  /** GET /batch-proposal: this seat's orders not in any batch yet that reached it before batch k's cutoff. */
  proposal(roundIdBytes, k) {
    const cutoff = (Number(k) + 1) * this.intervalMs;
    return this.db.prepare('SELECT order_id, body FROM market_orders WHERE round_id = ? AND batch IS NULL AND received_ms < ? ORDER BY order_id')
      .all(Buffer.from(roundIdBytes), cutoff).map((r) => JSON.parse(r.body));
  }

  /** The round's seat that leads batch k: its seat k mod n, in the contract's order. */
  leaderOf(contract, k) { return contract.nodes[Number(BigInt(k) % BigInt(contract.nodes.length))]; }

  /** Whether this seat leads batch k of that round, by the contract it holds. */
  leads(roundIdBytes, k) {
    const row = this.round.get(roundIdBytes);
    return !!row && toHex(this.leaderOf(decodeRoundContract(new Uint8Array(row.contract)), k)) === toHex(this.round.pubkey);
  }

  /**
   * LEAD BATCH k (the round's seat k mod n, at its cutoff): every seat's proposal, their union, the set handed to every seat.
   * Answers { ok, batchId, orderIds, signed: [{ seat, at }], heldBy, timings } - `heldBy` the seats that hold the set and
   * signed it, this one included.
   */
  async lead(roundIdBytes, k) {
    const m = this.#market(roundIdBytes);
    if (!m.ok) return m;
    if (toHex(this.leaderOf(m.contract, k)) !== toHex(this.round.pubkey)) return refuse(`batch ${k} is led by the round's seat ${BigInt(k) % BigInt(m.contract.nodes.length)}, not this one`);
    const rid = toHex(roundIdBytes);
    const t0 = this.now();
    const peers = this.peersFor(roundIdBytes);
    const asked = await Promise.all(peers.map(async (base) => {
      try {
        const r = await this.fetcher(`${base}/batch-proposal?round=${rid}&k=${k}`);
        return r.ok ? (await r.json()).orders || [] : [];
      } catch { return []; }
    }));
    const tProposals = this.now();
    const union = new Map();
    for (const json of [...this.proposal(roundIdBytes, k), ...asked.flat()]) {
      const c = this.#check(json, roundIdBytes);
      if (c.ok && !union.has(c.id) && !this.#batchedElsewhere(c.id, k)) union.set(c.id, json);
    }
    const orderIds = [...union.keys()].sort();
    const id = batchId({ roundId: roundIdBytes, k: BigInt(k), orderIds });
    const record = { k: String(k), orders: orderIds.map((x) => union.get(x)), leader: toHex(this.round.pubkey), leaderSig: toHex(schnorr.sign(id, this.round.identity.secret)) };
    const own = this.accept(roundIdBytes, record);
    if (!own.ok) return own;
    const answers = await Promise.all(peers.map(async (base) => {
      try {
        const r = await this.fetcher(`${base}/batch?round=${rid}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) });
        if (!r.ok) return { base, ok: false, why: (await r.text()).trim() };
        return { base, ok: true, ...(await r.json()) };
      } catch (e) { return { base, ok: false, why: e.message }; }
    }));
    const tDone = this.now();
    const signed = [{ seat: own.seat, signature: own.signature, at: own.storedAtMs }];
    for (const a of answers) {
      if (!a.ok || !/^[0-9a-f]{64}$/.test(String(a.seat)) || !/^[0-9a-f]{128}$/.test(String(a.signature))) continue;
      if (!m.contract.nodes.some((n) => toHex(n) === a.seat)) continue;
      let good = false;
      try { good = schnorr.verify(fromHex(a.signature), id, fromHex(a.seat)); } catch { good = false; }
      if (good) signed.push({ seat: a.seat, signature: a.signature, at: a.storedAtMs });
    }
    return { ok: true, batchId: toHex(id), orderIds, signed, heldBy: signed.length, of: m.contract.nodes.length,
      refused: answers.filter((a) => !a.ok).map((a) => `${a.base}: ${a.why}`),
      timings: { proposalsMs: tProposals - t0, agreedMs: tDone - t0, lastStoredAtMs: Math.max(...signed.map((s) => Number(s.at))) } };
  }

  #batchedElsewhere(orderIdHex, k) {
    const r = this.db.prepare('SELECT batch FROM market_orders WHERE order_id = ?').get(orderIdHex);
    return !!r && r.batch !== null && Number(r.batch) !== Number(k);
  }

  /**
   * POST /batch: the leader's set for batch k - held here if every check stands, and this seat's signature over its id.
   * The same set twice is answered the same; another set for a (round, k) this seat already signed is refused.
   */
  accept(roundIdBytes, record) {
    const m = this.#market(roundIdBytes);
    if (!m.ok) return m;
    if (!record || !/^[0-9]{1,15}$/.test(String(record.k)) || !Array.isArray(record.orders)) return refuse('a batch is { k, orders, leader, leaderSig }', 400);
    const k = BigInt(record.k);
    const leader = toHex(this.leaderOf(m.contract, k));
    if (String(record.leader) !== leader) return refuse(`batch ${k} is led by the round's seat ${k % BigInt(m.contract.nodes.length)} (${leader.slice(0, 16)}), not ${String(record.leader).slice(0, 16)}`);
    const checked = [];
    for (const json of record.orders) {
      const c = this.#check(json, roundIdBytes);
      if (!c.ok) return refuse(`an order of that batch does not stand: ${c.why}`);
      if (this.#batchedElsewhere(c.id, k)) return refuse(`order ${c.id.slice(0, 16)} is in another batch at this seat`);
      checked.push(c);
    }
    const ids = checked.map((c) => c.id).sort();
    const id = batchId({ roundId: roundIdBytes, k, orderIds: ids });
    let good = false;
    try { good = schnorr.verify(fromHex(String(record.leaderSig)), id, fromHex(leader)); } catch { good = false; }
    if (!good) return refuse('that batch is not signed by its leader', 403);
    const held = this.db.prepare('SELECT batch_id, own_sig, stored_ms FROM market_batches WHERE round_id = ? AND k = ?').get(Buffer.from(roundIdBytes), Number(k));
    if (held && held.batch_id !== toHex(id)) return refuse(`this seat already signed another set for batch ${k}: ${held.batch_id.slice(0, 16)}`);
    if (held) return { ok: true, seat: toHex(this.round.pubkey), signature: held.own_sig, storedAtMs: Number(held.stored_ms), fresh: false };
    const signature = toHex(schnorr.sign(id, this.round.identity.secret));
    const storedAtMs = this.now();
    const put = this.db.prepare('INSERT OR IGNORE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?)');
    const mark = this.db.prepare('UPDATE market_orders SET batch = ? WHERE order_id = ?');
    // ONE TRANSACTION: the set and its orders are held together or not at all
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of checked) { put.run(c.id, Buffer.from(roundIdBytes), JSON.stringify(orderToJson(c.order)), storedAtMs, Number(k)); mark.run(Number(k), c.id); }
      this.db.prepare('INSERT INTO market_batches (round_id, k, batch_id, order_ids, leader, leader_sig, own_sig, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Buffer.from(roundIdBytes), Number(k), toHex(id), JSON.stringify(ids), leader, String(record.leaderSig), signature, storedAtMs);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ok: true, seat: toHex(this.round.pubkey), signature, storedAtMs, fresh: true };
  }

  /**
   * THE BOOK AS THIS SEAT CLEARS IT (GET /batch): every agreed batch of the round in order, through `bookBatch` - standing
   * orders carried from batch to batch. Answers [{ k, batchId, orderIds, price, fills }] - the same at every seat that holds
   * the same batches.
   */
  cleared(roundIdBytes) {
    const m = this.#market(roundIdBytes);
    if (!m.ok) return m;
    const batches = this.db.prepare('SELECT k, batch_id, order_ids FROM market_batches WHERE round_id = ? ORDER BY k').all(Buffer.from(roundIdBytes));
    const bodies = new Map(this.db.prepare('SELECT order_id, body FROM market_orders WHERE round_id = ?').all(Buffer.from(roundIdBytes)).map((r) => [r.order_id, JSON.parse(r.body)]));
    let resting = [];
    const out = [];
    for (const b of batches) {
      const ids = JSON.parse(b.order_ids);
      const incoming = ids.map((id) => { const o = orderFromJson(bodies.get(id)); return { id, outcome: o.outcome, price: o.price, stakeMsat: o.stakeMsat, expiryMs: o.expiryMs }; });
      const got = bookBatch({ resting, incoming, nowMs: BigInt((Number(b.k) + 1) * this.intervalMs), feeBps: m.feeBps });
      resting = got.resting;
      out.push({ k: Number(b.k), batchId: b.batch_id, orderIds: ids, price: got.price, fills: got.fills });
    }
    return { ok: true, batches: out, resting };
  }
}

export { orderId };
