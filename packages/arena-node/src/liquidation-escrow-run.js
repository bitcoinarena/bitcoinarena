// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CENSUS-KEY LIQUIDATION ESCROW PAYS THE CLAIMS (kanban #1093 part 2, ruling #1111, 2026-11-03; #1085's mechanics with claims in place of entries).
//
// A theft's or an abandonment's start has no round: its fallback pays the whole hold, less the fee and the filer, to ONE census-key escrow output per bond (slash-release-run.js
// buildRoundless). That escrow belongs to the liquidating federation's note holders. Every seat reads such escrows once their fallback is confirmed:
//
//   A CARRIER (a holder of the census key, less the slashed nodes) publishes one signed CarrierPegIn per escrow outpoint and SAFE federation it holds a client of - OPEN, not the
//   liquidating one - at POST /slash/<payout_table_id>/carriers, as for a round's escrow.
//   A HOLDER, slash_fallback_blocks after the escrow confirmed, builds the spend from the one claims ledger it reads at a height it names (`claimsOf`: the claims accepted, at face,
//   and what the arbitration set's escrow pays each - template 1 and 2 escrows first), less what earlier census-key escrow spends of the same federation carry, and files it in a
//   turn by a hash of the proof; the other holders sign only their own bytes (kind `liquidation-escrow`). One escrow of a federation is spent at a time: the oldest start's first.
//   The carriers are the holders in descending shares, each with its peg-in into the safe federation of lowest load at that height, none above its own bond.
//   A CARRIER, once the spend is mined, claims its peg-in and pays each claim it carries at face, a payout contract to the claim's key, and the rest to that federation's reserve key.
//
// After the claim window closes (3 months from the halt), what no claim takes goes to the protocol reserves by §27A.9.2, through the same carriers.
import { schnorr } from '@noble/curves/secp256k1.js';
import { carrierEscrowPegInId } from '../../arena-protocol/src/census-key.js';
import { escrowWitness, slashEscrowOutput } from '../../arena-protocol/src/slash-release.js';
import { claimsOwed, decodeLiquidationClaims, decodeLiquidationEscrowOutputs, encodeLiquidationClaims, liquidationClaimsId, liquidationEscrowSpend, liquidationSlices, liquidationTxOf } from '../../arena-protocol/src/liquidation-escrow.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { gatherCensusSignature } from './census-sign.js';
import { keyedPay, payoutOf, PAYOUT } from './keyed-payout.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const display = (internalHex) => toHex(fromHex(internalHex).reverse());
const same = (a, b) => toHex(a) === toHex(b);
const ALREADY = /already in (the )?(mempool|block ?chain)|txn-already-known|txn-already-in-mempool|already known/i;
const outpointOf = (s) => { const [txid, vout] = String(s).split(':'); return { txid: fromHex(txid).reverse(), vout: Number(vout) }; };
const nameOf = (txidDisplay, vout) => `${txidDisplay}:${vout}`;
/** Load: what a federation's reserve holds of its cap (§27A.9.2); the lowest is the safest. */
const loadOf = (f) => { const cap = BigInt(f.exposureCapSats || 0); return cap > 0n ? Number((BigInt(f.reserveSats || 0) * 1000000n) / cap) : Number.MAX_SAFE_INTEGER; };

/**
 * A CLAIM'S CARRIER AS ONE HOLDER SEES IT, AND THE ONE WAY IT MOVES (kanban #1189). free -> held (by one start: this holder agreed to sign a spend of that start's escrow carrying the
 * claim, written before its nonce is drawn) -> carried (a spend on the chain carries it; terminal) | free (the escrow output that spend named is spent on the chain without it).
 * Held -> held again by the same start only. A holder signs no spend of another start carrying a claim held here, and builds none: so two escrows of a federation never both get a
 * threshold of signatures for one claim, whatever each seat's walk says is "first" (the census key's threshold, floor(2n/3) + 1 of its shares, makes any two signing sets meet).
 */
export const CLAIM_LOCK = Object.freeze({ FREE: 'free', HELD: 'held', CARRIED: 'carried' });

/**
 * Made by slash-release-run.js with its reads. `claimsOf(fid hex)` -> { accepted: [{ nonce, amountMsat, payoutPk, height }], coveredMsat: Map(nonce -> msat), afterWindow } or null:
 * the one claims ledger of a liquidating federation (the claims door's plan: what the arbitration set's escrow pays each, and whether the claim window has closed).
 * `federationsAt(height)` the reserves' view on the records in force there; `reserveKeyOf(fid)`; `portFor(fid)` a client { peginAddress, peginClaim, payouts, ecashBalance? } or null.
 * `marginMsat` the network's carrier margin each claims_carrier output holds; `payoutFeeMsat` the part of it a carrier keeps back for its payout's fee (kanban #1093).
 */
export function createLiquidationEscrow({ asker = null, secret, me, networkId, clocks, db, tweakPoint, tipHeight, entriesAtTip, txOut, fetchProof, judge, holdersOf, heldKey, thresholdOf, signer, urlOf,
  fetchFn = fetch, send, portFor = async () => null, scriptOf, federationsAt = async () => [], reserveKeyOf = () => null, claimsOf = async () => null, now = Date.now, stepMs = 600000,
  log = () => {}, confirmedOf, fallbackRank, getJson, marginMsat = 0n, payoutFeeMsat = marginMsat }) {
  db.exec(`CREATE TABLE IF NOT EXISTS liq_escrow_chain (table_id TEXT NOT NULL, seq INTEGER NOT NULL, start TEXT NOT NULL, federation TEXT NOT NULL, escrow_in TEXT NOT NULL, value INTEGER NOT NULL,
      outputs BLOB NOT NULL, claims BLOB NOT NULL, txid TEXT NOT NULL, PRIMARY KEY (table_id, seq));
    CREATE TABLE IF NOT EXISTS liq_escrow_props (escrow TEXT NOT NULL, outputs_id TEXT NOT NULL, table_id TEXT NOT NULL, start TEXT NOT NULL, load_height INTEGER NOT NULL, outputs BLOB NOT NULL,
      claims BLOB NOT NULL, txid TEXT NOT NULL, sent TEXT, made_ms INTEGER NOT NULL, PRIMARY KEY (escrow, outputs_id));
    CREATE TABLE IF NOT EXISTS liq_carried (escrow TEXT NOT NULL, out_index INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (escrow, out_index));
    CREATE TABLE IF NOT EXISTS slash_carrier_pegins (table_id TEXT NOT NULL, escrow TEXT NOT NULL, federation TEXT NOT NULL, node TEXT NOT NULL, script BLOB NOT NULL, signature BLOB NOT NULL,
      PRIMARY KEY (table_id, escrow, federation, node));
    CREATE TABLE IF NOT EXISTS slash_pegins (start TEXT NOT NULL, federation TEXT NOT NULL, use TEXT NOT NULL, address TEXT NOT NULL, script BLOB NOT NULL, PRIMARY KEY (start, federation, use));
    CREATE TABLE IF NOT EXISTS liq_claim_locks (federation TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL, start TEXT, escrow TEXT, outputs_id TEXT, load_height INTEGER, at_ms INTEGER NOT NULL,
      PRIMARY KEY (federation, nonce))`);

  // ---- WHAT AN ESCROW IS: a confirmed roundless table's escrow output, its federation the proof's ----
  const contexts = new Map();
  async function contextOf(start) {
    if (contexts.has(start)) return contexts.get(start);
    const h = db.prepare('SELECT * FROM slash_holds WHERE start = ?').get(start);
    if (!h || h.round_id || !h.census_key || !h.proof_id || h.rate === null || h.rate === undefined) return null;
    const conf = await confirmedOf(start);
    if (!conf) return null;
    const at = conf.table.outputs.findIndex((o) => o.pays === 'escrow');
    const bytes = await fetchProof(fromHex(h.proof_id));
    const read = bytes ? judge.read(bytes) : null;
    if (!read || !read.ok || read.roundId || !read.federationId || at < 0) { contexts.set(start, null); return null; }
    const censusKey = fromHex(h.census_key);
    const output = slashEscrowOutput({ censusKey, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
    if (!same(output.script, conf.table.outputs[at].script)) { log(`[liquidation] the escrow of ${start.slice(0, 16)} is under a script this seat cannot rebuild`); contexts.set(start, null); return null; }
    const ctx = { start, h, conf, tableId: conf.tableId, output, censusKey, proofId: fromHex(h.proof_id), federation: toHex(read.federationId), kind: read.kind,
      first: { txid: conf.txid, vout: at + 1, value: conf.table.outputs[at].value } };
    contexts.set(start, ctx);
    return ctx;
  }
  const startOfTable = (tableId) => { for (const [s, c] of contexts) if (c && c.tableId === String(tableId).toLowerCase()) return s; return null; };
  const chainOf = (tableId) => db.prepare('SELECT * FROM liq_escrow_chain WHERE table_id = ? ORDER BY seq').all(tableId);

  /** What earlier census-key escrow spends of `federation` already carry, by claim nonce. */
  function assignedOf(federation) {
    const m = new Map();
    for (const r of db.prepare('SELECT claims FROM liq_escrow_chain WHERE federation = ?').all(federation)) for (const c of decodeLiquidationClaims(new Uint8Array(r.claims))) m.set(c.nonce, (m.get(c.nonce) || 0n) + c.msat);
    return m;
  }

  // ---- WHO CARRIES A CLAIM (kanban #1189) ----
  const lockRow = (federation, nonce) => db.prepare('SELECT * FROM liq_claim_locks WHERE federation = ? AND nonce = ?').get(federation, nonce) || null;
  const carriedOnChain = (federation, nonce) => db.prepare('SELECT claims FROM liq_escrow_chain WHERE federation = ?').all(federation)
    .some((r) => decodeLiquidationClaims(new Uint8Array(r.claims)).some((c) => c.nonce === nonce));
  /** THE ONE TRANSITION: compare and set on the row. False when `from` is not the claim's state now, or a hold names another start. */
  function lockMove(federation, nonce, from, to, data = {}) {
    const row = lockRow(federation, nonce), now_ = (row && row.state) || CLAIM_LOCK.FREE;
    if (now_ !== from) return false;
    const ok = { [CLAIM_LOCK.FREE]: [CLAIM_LOCK.HELD, CLAIM_LOCK.CARRIED], [CLAIM_LOCK.HELD]: [CLAIM_LOCK.HELD, CLAIM_LOCK.FREE, CLAIM_LOCK.CARRIED], [CLAIM_LOCK.CARRIED]: [] }[from];
    if (!ok.includes(to)) return false;
    if (from === CLAIM_LOCK.HELD && to === CLAIM_LOCK.HELD && row.start !== data.start) return false;
    db.prepare(`INSERT INTO liq_claim_locks (federation, nonce, state, start, escrow, outputs_id, load_height, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (federation, nonce) DO UPDATE SET state = excluded.state, start = excluded.start, escrow = excluded.escrow, outputs_id = excluded.outputs_id, load_height = excluded.load_height, at_ms = excluded.at_ms`)
      .run(federation, nonce, to, data.start ?? null, data.escrow ?? null, data.outputsId ?? null, data.loadHeight ?? null, now());
    return true;
  }
  /** A claim's state now, its row brought up to what this seat's walk of the chain holds: carried where a spend carries it, free where the held escrow output went without it. */
  function claimState(federation, nonce) {
    const row = lockRow(federation, nonce);
    const st = (row && row.state) || CLAIM_LOCK.FREE;
    if (st === CLAIM_LOCK.CARRIED) return { state: st };
    if (carriedOnChain(federation, nonce)) { lockMove(federation, nonce, st, CLAIM_LOCK.CARRIED); return { state: CLAIM_LOCK.CARRIED }; }
    if (st === CLAIM_LOCK.HELD && db.prepare('SELECT 1 FROM liq_escrow_chain WHERE escrow_in = ?').get(row.escrow)) { lockMove(federation, nonce, st, CLAIM_LOCK.FREE); return { state: CLAIM_LOCK.FREE }; }
    return st === CLAIM_LOCK.HELD ? { state: st, start: row.start, escrow: row.escrow } : { state: st };
  }
  /** Whether another start than `start` holds that claim here. */
  const heldByOther = (federation, nonce, start) => { const c = claimState(federation, nonce); return c.state === CLAIM_LOCK.HELD && c.start !== start; };

  /** A spend of `inName` the chain holds: this seat's own proposal, or one a holder serves, whose txid has a confirmed output. */
  async function findSpend(ctx, inName, value) {
    const cands = db.prepare('SELECT outputs, claims FROM liq_escrow_props WHERE escrow = ?').all(inName).map((r) => ({ bytes: new Uint8Array(r.outputs), claims: new Uint8Array(r.claims) }));
    for (const k of (await holdersFor(ctx)).map((x) => x.key).filter((x) => x !== me).slice(0, 32)) {
      try { const s = await getJson(`${urlOf(k)}/slash-release?start=${ctx.start}`); for (const p of (s.liquidation && s.liquidation.proposals) || []) if (p.escrow === inName) cands.push({ bytes: fromHex(p.outputs), claims: fromHex(p.claims) }); } catch { /* the next */ }
    }
    const tip = await tipHeight();
    for (const c of cands) {
      let d; try { d = decodeLiquidationEscrowOutputs(c.bytes); } catch { continue; }
      if (toHex(d.tableId) !== ctx.tableId || toHex(liquidationClaimsId(decodeLiquidationClaims(c.claims))) !== toHex(d.claimsId)) continue;
      const tx = liquidationTxOf({ escrow: { ...outpointOf(inName), value }, output: ctx.output, decoded: d, fallbackBlocks: clocks.fallbackBlocks });
      if (!tx) continue;
      const txid = display(toHex(parseTransaction(serializeSpend({ ...tx, witnesses: [[new Uint8Array(64)]] })).txid));
      for (let i = 1; i < tx.outputs.length; i++) {
        const got = await txOut(txid, i).catch(() => null);
        if (got && got.confirmations > 0) return { ...c, decoded: d, txid, height: tip - got.confirmations + 1 };
      }
    }
    return null;
  }

  /** Where the escrow stands: its spends on the chain (kept once found) and the output it is now, with its confirmation height. */
  async function walk(ctx) {
    const tip = await tipHeight();
    let rows = chainOf(ctx.tableId), cur = ctx.first;
    const backOf = (d) => d.outputs.findIndex((x) => x.pays === 'escrow');
    if (rows.length) {
      const last = rows[rows.length - 1], d = decodeLiquidationEscrowOutputs(new Uint8Array(last.outputs)), back = backOf(d);
      if (back < 0) return { done: true, rows };
      cur = { txid: last.txid, vout: back + 1, value: d.outputs[back].value };
    }
    for (let step = 0; step < 16; step++) {
      const inName = nameOf(cur.txid, cur.vout);
      const got = await txOut(cur.txid, cur.vout).catch(() => null);
      if (got && got.confirmations > 0) return { rows, cur: { ...cur, name: inName, confHeight: tip - got.confirmations + 1 } };
      const next = await findSpend(ctx, inName, cur.value);
      if (!next) return { rows, wait: `the escrow ${inName.slice(0, 16)} is not confirmed here and no spend of it is known` };
      db.prepare('INSERT OR IGNORE INTO liq_escrow_chain (table_id, seq, start, federation, escrow_in, value, outputs, claims, txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.tableId, rows.length, ctx.start, ctx.federation, inName, Number(cur.value), next.bytes, next.claims, next.txid);
      rows = chainOf(ctx.tableId);
      const back = backOf(next.decoded);
      if (back < 0) return { done: true, rows };
      cur = { txid: next.txid, vout: back + 1, value: next.decoded.outputs[back].value };
    }
    return { rows, wait: 'more escrow spends than one pass reads' };
  }

  // ---- WHO SIGNS AND WHO CARRIES ----
  const holdersCache = new Map();
  async function holdersFor(ctx) {
    if (!holdersCache.has(ctx.start)) holdersCache.set(ctx.start, await holdersOf(toHex(ctx.censusKey), ctx.h.height));
    return holdersCache.get(ctx.start) || [];
  }
  /** The slashed nodes: every node whose bond a slash with no round started. They carry nothing. */
  const slashedNodes = () => new Set(db.prepare('SELECT DISTINCT node FROM slash_holds WHERE round_id IS NULL').all().map((r) => r.node));
  /** The carriers, in carrying order: the holders in descending shares, less the slashed nodes. */
  async function carrierKeys(ctx) {
    const out = slashedNodes();
    return [...await holdersFor(ctx)].sort((a, b) => b.shares - a.shares || (a.key < b.key ? -1 : 1)).map((x) => x.key).filter((k) => !out.has(k));
  }
  /** The safe federations at a height: OPEN, not the liquidating one, lowest load first. */
  async function safeAt(ctx, height) {
    return ((await federationsAt(height)) || []).filter((f) => f && f.status === 'OPEN' && String(f.federation).toLowerCase() !== ctx.federation)
      .sort((a, b) => loadOf(a) - loadOf(b) || (String(a.federation) < String(b.federation) ? -1 : 1));
  }
  /** Each carrier with its peg-in into the safest federation it published one of for this escrow, and its bond at the tip; a key out of the census skipped. */
  async function carriersFor(ctx, inName, loadHeight) {
    const entries = (await entriesAtTip()) || [];
    const bonds = new Map();
    for (const e of entries) bonds.set(toHex(e.pubkey), (bonds.get(toHex(e.pubkey)) || 0n) + BigInt(e.bondSats));
    const rank = new Map((await safeAt(ctx, loadHeight)).map((f, i) => [String(f.federation).toLowerCase(), i]));
    const rows = db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ? AND escrow = ?').all(ctx.tableId, inName);
    const out = [];
    for (const k of await carrierKeys(ctx)) {
      if (!bonds.has(k)) continue;
      const best = rows.filter((r) => r.node === k && rank.has(r.federation)).sort((a, b) => rank.get(a.federation) - rank.get(b.federation))[0];
      if (best) out.push({ key: k, federation: best.federation, script: new Uint8Array(best.script), bondSats: bonds.get(k) });
    }
    return out;
  }

  // ---- CarrierPegIn ----
  const pegInRecord = (r) => ({ node: r.node, tableId: r.table_id, escrow: r.escrow, federation: r.federation, script: toHex(new Uint8Array(r.script)), signature: toHex(new Uint8Array(r.signature)) });
  async function takeCarrierPegIn(tableId, rec) {
    const tid = String(tableId).toLowerCase();
    const start = startOfTable(tid);
    if (!start) return { ok: false, status: 503, why: 'this seat has not read a confirmed liquidation table with that id' };
    const ctx = contexts.get(start);
    let script, signature, fid, at;
    try { script = fromHex(String(rec.script)); signature = fromHex(String(rec.signature)); fid = String(rec.federation).toLowerCase(); at = outpointOf(rec.escrow); if (fromHex(fid).length !== 32 || at.txid.length !== 32 || !Number.isInteger(at.vout)) throw new Error('bad'); }
    catch { return { ok: false, status: 400, why: 'a CarrierPegIn is { node, tableId, escrow, federation, script, signature }' }; }
    const name = String(rec.escrow).toLowerCase();
    const known = name === nameOf(ctx.first.txid, ctx.first.vout) || chainOf(tid).some((r) => { const o = decodeLiquidationEscrowOutputs(new Uint8Array(r.outputs)).outputs; const b = o.findIndex((x) => x.pays === 'escrow'); return b >= 0 && nameOf(r.txid, b + 1) === name; });
    if (!known) return { ok: false, status: 409, why: 'that is no escrow outpoint of this table here' };
    if (fid === ctx.federation) return { ok: false, status: 409, why: 'a carrier pegs into a safe federation, never the liquidating one' };
    if (!(await carrierKeys(ctx)).includes(String(rec.node))) return { ok: false, status: 409, why: 'that node carries no part of this escrow by the carrier rule' };
    if (!verifySig(signature, carrierEscrowPegInId({ tableId: fromHex(tid), outpoint: at, federationId: fromHex(fid), script }), fromHex(String(rec.node)))) return { ok: false, status: 409, why: 'that CarrierPegIn is not signed by its node' };
    if (db.prepare('SELECT 1 FROM slash_carrier_pegins WHERE table_id = ? AND escrow = ? AND federation = ? AND node = ?').get(tid, name, fid, String(rec.node))) return { ok: true, kept: false };
    db.prepare('INSERT INTO slash_carrier_pegins (table_id, escrow, federation, node, script, signature) VALUES (?, ?, ?, ?, ?, ?)').run(tid, name, fid, String(rec.node), script, signature);
    const out = { node: String(rec.node), tableId: tid, escrow: name, federation: fid, script: toHex(script), signature: toHex(signature) };
    for (const k of (await holdersFor(ctx)).map((x) => x.key)) {
      if (k === me || k === out.node || !urlOf(k)) continue;
      fetchFn(`${urlOf(k)}/slash/${tid}/carriers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out), signal: AbortSignal.timeout(20000) }).catch(() => {});
    }
    return { ok: true, kept: true };
  }
  const servedCarriers = (tableId) => ({ tableId: String(tableId).toLowerCase(), carriers: db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ?').all(String(tableId).toLowerCase()).map(pegInRecord) });

  const published = new Set();
  async function publish(ctx, cur) {
    for (const f of await safeAt(ctx, cur.confHeight)) {
      const fid = String(f.federation).toLowerCase(), name = `${cur.name}:${fid}`;
      if (published.has(name)) continue;
      const start = `liq:${cur.name}`;
      let row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, 'liquidation');
      if (!row) {
        let port = null; try { port = await portFor(fid); } catch { port = null; }
        if (!port || typeof port.peginAddress !== 'function') continue;
        let address; try { address = await port.peginAddress(); } catch (e) { log(`[liquidation] no peg-in into ${fid.slice(0, 16)}: ${e.message}`); continue; }
        db.prepare('INSERT OR IGNORE INTO slash_pegins (start, federation, use, address, script) VALUES (?, ?, ?, ?, ?)').run(start, fid, 'liquidation', address, scriptOf(address));
        row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, 'liquidation');
      }
      const script = new Uint8Array(row.script);
      const signature = schnorr.sign(carrierEscrowPegInId({ tableId: fromHex(ctx.tableId), outpoint: outpointOf(cur.name), federationId: fromHex(fid), script }), secret);
      published.add(name);
      await takeCarrierPegIn(ctx.tableId, { node: me, tableId: ctx.tableId, escrow: cur.name, federation: fid, script: toHex(script), signature: toHex(signature) });
    }
  }
  async function pull(ctx) {
    for (const k of (await holdersFor(ctx)).map((x) => x.key)) {
      if (k === me || !urlOf(k)) continue;
      let got; try { got = await getJson(`${urlOf(k)}/slash/${ctx.tableId}/carriers`); } catch { continue; }
      for (const rec of (got && got.carriers) || []) await takeCarrierPegIn(ctx.tableId, rec);
    }
  }

  // ---- BUILDING, AT A NAMED HEIGHT ----
  /** This seat's spend of the escrow now, from the ledger it reads, at `loadHeight`. */
  async function buildAt(ctx, w, loadHeight) {
    const ledger = await claimsOf(ctx.federation);
    if (!ledger) return { ok: false, due: false, why: `no claims ledger of federation ${ctx.federation.slice(0, 16)} is read here` };
    // A CLAIM ANOTHER START'S SPEND HOLDS HERE IS NOT OWED BY THIS ONE (kanban #1189): that spend may still be mined, and two escrows would carry it
    const owed = claimsOwed({ accepted: (ledger.accepted || []).filter((c) => Number(c.height) <= loadHeight), coveredMsat: ledger.coveredMsat || new Map(), assigned: assignedOf(ctx.federation) })
      .filter((c) => !heldByOther(ctx.federation, c.nonce, ctx.start) && claimState(ctx.federation, c.nonce).state !== CLAIM_LOCK.CARRIED);
    // AFTER THE CLAIM WINDOW THE REST IS SPREAD OVER THE SAFE FEDERATIONS WITH A RESERVE KEY (§27A.9.2): one whose guardian seats stand and whose key this seat has not
    // read yet (reservePending, kanban #1129) would get no part in this seat's outputs and a part in those of a seat that read it. It waits, by name, as the slash table does
    if (ledger.afterWindow) {
      const unread = (await safeAt(ctx, loadHeight)).filter((f) => !f.reserveKey && f.reservePending && BigInt(f.exposureCapSats || 0) > 0n);
      if (unread.length) return { ok: false, why: `the reserve key of federation ${unread.map((f) => String(f.federation).slice(0, 16)).join(', ')} is not read here yet: no liquidation spend is built without its reserves' part`, wait: true };
    }
    return liquidationEscrowSpend({ escrow: { ...outpointOf(w.cur.name), value: w.cur.value }, output: ctx.output, tableId: fromHex(ctx.tableId), loadHeight, owed,
      carriers: await carriersFor(ctx, w.cur.name, loadHeight), marginMsat, rate: BigInt(ctx.h.rate), fallbackBlocks: clocks.fallbackBlocks,
      remainder: ledger.afterWindow ? { federations: await safeAt(ctx, loadHeight), retired: [] } : null });
  }
  const propOf = (inName, oid) => db.prepare('SELECT * FROM liq_escrow_props WHERE escrow = ? AND outputs_id = ?').get(inName, oid) || null;
  function keepProp(ctx, w, b, loadHeight) {
    const oid = toHex(b.outputsId);
    const txid = display(toHex(parseTransaction(serializeSpend({ ...b.spend.tx, witnesses: [[new Uint8Array(64)]] })).txid));
    db.prepare('INSERT OR IGNORE INTO liq_escrow_props (escrow, outputs_id, table_id, start, load_height, outputs, claims, txid, sent, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(w.cur.name, oid, ctx.tableId, ctx.start, loadHeight, b.bytes, encodeLiquidationClaims(b.claims), txid, now());
    return propOf(w.cur.name, oid);
  }
  /**
   * ONE ESCROW OF A FEDERATION AT A TIME: this one only when no older start's escrow of the same federation, read at the same height, has a spend due itself, so an older escrow whose
   * change cannot pay the next claim does not hold back a younger one that can. This is who tries first, by this seat's own walk, and two seats can read it apart (kanban #1189): that
   * two escrows never carry one claim is the claim lock's (CLAIM_LOCK), which a holder writes before it signs.
   */
  async function firstOfFederation(ctx, loadHeight) {
    for (const r of db.prepare('SELECT start FROM slash_holds WHERE round_id IS NULL AND census_key IS NOT NULL ORDER BY height, start').all()) {
      if (r.start === ctx.start) return true;
      const other = await contextOf(r.start).catch(() => null);
      if (!other || other.federation !== ctx.federation) continue;
      const w = await walk(other).catch(() => null);
      if (!w || !w.cur) continue;
      const b = await buildAt(other, w, Math.max(loadHeight, w.cur.confHeight)).catch(() => null);
      if (b && b.ok) return false;
    }
    return true;
  }

  // ---- THE CENSUS KEY'S LEAF ----
  const since = new Map();
  async function spendOne(ctx, w, tip) {
    const loadHeight = Math.max(w.cur.confHeight, tip);
    const b = await buildAt(ctx, w, loadHeight);
    if (!b.ok) return b;
    const prop = keepProp(ctx, w, b, loadHeight);
    const holders = (await holdersFor(ctx)).map((x) => x.key);
    if (!since.has(w.cur.name)) since.set(w.cur.name, now());
    const rank = fallbackRank(ctx.proofId, holders, me);
    if (rank < 0 || now() - since.get(w.cur.name) < rank * stepMs) return { ok: false, why: `not this holder's turn to file yet (rank ${rank})`, quiet: true };
    const keyHex = toHex(ctx.censusKey);
    const threshold = thresholdOf(keyHex);
    if (!threshold) return { ok: false, why: `this seat reads no threshold for key ${keyHex.slice(0, 16)}` };
    const request = { kind: 'liquidation-escrow', start: ctx.start, tableId: ctx.tableId, escrow: w.cur.name, loadHeight, outputsId: prop.outputs_id };
    const own = heldKey(ctx.censusKey) ? signer() : null;
    const got = await gatherCensusSignature({ asker, request, digest: b.digest, publicKey: ctx.censusKey, threshold, urls: holders.filter((k) => k !== me).map(urlOf).filter(Boolean), own, fetchFn });
    if (!got.ok) return got;
    const raw = serializeSpend({ ...b.spend.tx, witnesses: [escrowWitness({ escrow: ctx.output, path: 'fallback', signature: got.signature })] });
    let sent;
    try { sent = String(await send(toHex(raw))); } catch (e) { if (!ALREADY.test(e.message)) return { ok: false, why: `the liquidation escrow spend was not taken: ${e.message}` }; sent = display(toHex(parseTransaction(raw).txid)); }
    db.prepare('UPDATE liq_escrow_props SET sent = ? WHERE escrow = ? AND outputs_id = ?').run(sent, w.cur.name, prop.outputs_id);
    return { ok: true, txid: sent, outputsId: prop.outputs_id, claims: b.claims.length, loadHeight, signers: got.signers, feeSats: b.feeSats };
  }

  /** A HOLDER ASKED TO SIGN (kind `liquidation-escrow`): the escrow is the one it reads now, the leaf has opened, the height lies between its confirmation and the tip, and its own outputs there are the ones named. */
  async function checkLiquidationEscrow(request) {
    const ctx = await contextOf(String(request.start || '').toLowerCase());
    if (!ctx) return { ok: false, why: 'this seat reads no confirmed liquidation escrow for that start' };
    if (ctx.tableId !== String(request.tableId).toLowerCase()) return { ok: false, why: 'that is not the table this seat reads confirmed' };
    await holdersFor(ctx);
    const w = await walk(ctx);
    if (!w.cur) return { ok: false, why: w.done ? 'that escrow is spent to the end' : w.wait };
    if (w.cur.name !== String(request.escrow).toLowerCase()) return { ok: false, why: `this seat's escrow is ${w.cur.name.slice(0, 16)}, not that one` };
    const tip = await tipHeight();
    if (tip < w.cur.confHeight + clocks.fallbackBlocks - 1) return { ok: false, why: 'that escrow\'s census key leaf has not opened yet' };
    const h = Number(request.loadHeight);
    if (!Number.isInteger(h) || h < w.cur.confHeight || h > tip) return { ok: false, why: `a liquidation spend names a height from ${w.cur.confHeight} to ${tip}, not ${request.loadHeight}` };
    if (!(await firstOfFederation(ctx, h))) return { ok: false, why: 'an older escrow of that federation pays first' };
    const b = await buildAt(ctx, w, h);
    if (!b.ok) return b;
    if (toHex(b.outputsId) !== String(request.outputsId).toLowerCase()) return { ok: false, why: `this seat's own outputs at ${h} are ${toHex(b.outputsId).slice(0, 16)}, not ${String(request.outputsId).slice(0, 16)}` };
    // THE CLAIMS ARE THIS START'S BEFORE ANY NONCE (kanban #1189): read again and written in one synchronous step, so a check of another start that built meanwhile cannot take them too
    const taken = b.claims.filter((c) => heldByOther(ctx.federation, c.nonce, ctx.start));
    if (taken.length) return { ok: false, why: `${taken.length} of those claims are carried or held by another escrow of that federation here` };
    for (const c of b.claims) {
      const from = claimState(ctx.federation, c.nonce).state;
      if (!lockMove(ctx.federation, c.nonce, from, CLAIM_LOCK.HELD, { start: ctx.start, escrow: w.cur.name, outputsId: toHex(b.outputsId), loadHeight: h }))
        return { ok: false, why: `the claim ${c.nonce.slice(0, 16)} moved while it was read` };
    }
    keepProp(ctx, w, b, h);
    return { ok: true, digest: b.digest, publicKey: ctx.censusKey };
  }

  // ---- ONE PASS ----
  async function pass() {
    const done = [];
    const tip = await tipHeight();
    for (const r of db.prepare('SELECT start FROM slash_holds WHERE round_id IS NULL AND census_key IS NOT NULL ORDER BY height, start').all()) {
      let ctx; try { ctx = await contextOf(r.start); } catch (e) { done.push({ start: r.start, why: e.message }); continue; }
      if (!ctx) continue;
      await holdersFor(ctx);
      const w = await walk(ctx);
      if (!w.cur) continue;
      if ((await carrierKeys(ctx)).includes(me)) await publish(ctx, w.cur);
      if (!heldKey(ctx.censusKey)) continue;
      await pull(ctx);
      if (tip < w.cur.confHeight + clocks.fallbackBlocks - 1) continue;
      if (!(await firstOfFederation(ctx, Math.max(w.cur.confHeight, tip)))) continue;
      const got = await spendOne(ctx, w, tip).catch((x) => ({ ok: false, why: x.message }));
      done.push({ start: ctx.start, path: 'liquidation-escrow', escrow: w.cur.name, ...got });
      if (got.ok) log(`[liquidation] escrow of ${ctx.start.slice(0, 16)} spent to ${got.claims} claim(s) of ${ctx.federation.slice(0, 16)}: ${got.txid}`);
      else if (!got.quiet && got.due !== false) log(`[liquidation] escrow of ${ctx.start.slice(0, 16)} waits: ${got.why}`);
    }
    return done;
  }

  // ---- THE CARRIERS PAY THEIR CLAIMS ----
  const carrying = new Set();
  async function carry() {
    const done = [];
    if (!db.prepare("SELECT 1 FROM slash_pegins WHERE use = 'liquidation' LIMIT 1").get()) return done;
    for (const r of db.prepare('SELECT start FROM slash_holds WHERE round_id IS NULL AND census_key IS NOT NULL').all()) { const ctx = await contextOf(r.start).catch(() => null); if (ctx) await walk(ctx).catch(() => null); }
    for (const row of db.prepare('SELECT * FROM liq_escrow_chain ORDER BY table_id, seq').all()) {
      const mine = db.prepare('SELECT federation, address, script FROM slash_pegins WHERE start = ? AND use = ?').all(`liq:${row.escrow_in}`, 'liquidation');
      if (!mine.length) continue;
      const d = decodeLiquidationEscrowOutputs(new Uint8Array(row.outputs)), claims = decodeLiquidationClaims(new Uint8Array(row.claims));
      const slices = liquidationSlices(d, claims);
      for (const [i, o] of d.outputs.entries()) {
        if (o.pays !== 'claims_carrier' && o.pays !== 'reserves') continue;
        const peg = mine.find((p) => same(new Uint8Array(p.script), o.script));
        if (!peg) continue;
        const tag = `${row.escrow_in}:${i}`;
        const state = JSON.parse((db.prepare('SELECT state FROM liq_carried WHERE escrow = ? AND out_index = ?').get(row.escrow_in, i) || { state: '{}' }).state);
        if (state.paidTxid || carrying.has(tag)) continue;
        const keep = () => db.prepare('INSERT OR REPLACE INTO liq_carried (escrow, out_index, state) VALUES (?, ?, ?)').run(row.escrow_in, i, JSON.stringify(state));
        carrying.add(tag);
        try {
          if (!state.claimedMsat) {
            const got = await txOut(row.txid, i + 1).catch(() => null);
            if (!got || (got.script !== undefined && got.script !== toHex(o.script)) || (got.sats !== undefined && BigInt(got.sats) !== o.value)) continue;
          }
          const port = await portFor(peg.federation);
          if (!port) { done.push({ escrow: row.escrow_in, index: i, why: `no client of ${peg.federation.slice(0, 16)}` }); continue; }
          // THIS OUTPUT'S OWN DEPOSIT (kanban #1093): a walletv2 client has one peg-in address, so two escrows carried by one carrier land on it; the claim is read by outpoint
          if (!state.claimedMsat) { const c = await port.peginClaim(peg.address, { outpoint: `${row.txid}:${i + 1}`, sats: o.value }); state.claimedMsat = String(c.claimedMsat); keep(); }
          const claimed = BigInt(state.claimedMsat);
          // EACH CLAIM AT FACE, to its key; the rest, less the payout part of the margin for this carrier's payout fee, to that federation's reserve key: the margin paid the
          // peg-in fee first (kanban #1093), and what it left goes on to the reserves, so a carrier keeps nothing past its fee
          const pays = o.pays === 'claims_carrier' ? (slices.find((x) => x.index === i) || { claims: [] }).claims.map((c) => ({ key: c.payoutPk, msat: c.msat, nonce: c.nonce })) : [];
          const owedOut = pays.reduce((a, x) => a + x.msat, 0n);
          if (claimed < owedOut) { done.push({ escrow: row.escrow_in, index: i, why: `claimed ${claimed} msat, ${owedOut} owed: the claims wait` }); continue; }
          const reserveKey = await reserveKeyOf(peg.federation);
          const margin = o.pays === 'claims_carrier' ? BigInt(d.marginMsat) : 0n, feeHold = margin < payoutFeeMsat ? margin : payoutFeeMsat;
          const rest = claimed - owedOut - feeHold;
          const list = [...pays.map(({ key, msat }) => ({ key, msat })), ...(reserveKey && rest > 0n ? [{ key: toHex(reserveKey), msat: rest }] : [])].filter((x) => x.msat > 0n);
          if (!list.length && payoutOf(state.pay) !== PAYOUT.ASKED) { state.paidTxid = 'nothing'; keep(); continue; }
          // THE PAYOUT ONCE (kanban #1174, keyed-payout.js): ASKED written before the tool, read back under its key after a stop
          if (!state.pay) state.pay = {};
          const got = await keyedPay({ rec: state.pay, save: keep, list, key: `liq:${tag}`, pay: (l, key) => port.payouts(l, { key }), paidBack: (l, key) => port.payoutsSent(l, key), now });
          if (!got.ok) { done.push({ escrow: row.escrow_in, index: i, why: got.why, held: !!got.held }); log(`[liquidation] carrying ${row.escrow_in.slice(0, 16)} output ${i} waits: ${got.why}`); continue; }
          const paid = { txid: got.txid, payouts: got.payouts };
          state.paidTxid = paid.txid;
          state.claims = pays.map((x) => ({ nonce: x.nonce, key: x.key, msat: String(x.msat), outIdx: ((paid.payouts || []).find((y) => y.refundPk === x.key) || {}).outIdx ?? null }));
          if (reserveKey && rest > 0n) state.reserves = { key: toHex(reserveKey), msat: String(rest) };
          keep();
          log(`[liquidation] carried ${row.escrow_in.slice(0, 16)} output ${i}: claimed ${claimed} msat, ${pays.length} claim(s) paid at face${state.reserves ? `, ${rest} msat to the reserves` : ''}: ${paid.txid}`);
          done.push({ escrow: row.escrow_in, index: i, ...state });
        } catch (x) { done.push({ escrow: row.escrow_in, index: i, why: x.message }); log(`[liquidation] carrying ${row.escrow_in.slice(0, 16)} output ${i} waits: ${x.message}`); }
        finally { carrying.delete(tag); }
      }
    }
    return done;
  }

  /** What GET /slash-release?start= adds: the escrow's spends on the chain and this seat's proposals, each with its claims. */
  function served(start) {
    const c = contexts.get(start);
    const props = db.prepare('SELECT * FROM liq_escrow_props WHERE start = ?').all(start);
    if (!c && !props.length) return null;
    return {
      tableId: c ? c.tableId : props[0].table_id, federation: c ? c.federation : null,
      spends: c ? chainOf(c.tableId).map((r) => ({ escrow: r.escrow_in, txid: r.txid, outputs: toHex(new Uint8Array(r.outputs)), claims: toHex(new Uint8Array(r.claims)) })) : [],
      proposals: props.map((r) => ({ escrow: r.escrow, outputsId: r.outputs_id, loadHeight: r.load_height, outputs: toHex(new Uint8Array(r.outputs)), claims: toHex(new Uint8Array(r.claims)), txid: r.txid, sent: r.sent })),
      carried: db.prepare('SELECT * FROM liq_carried').all().filter((x) => c && chainOf(c.tableId).some((r) => r.escrow_in === x.escrow)).map((x) => ({ escrow: x.escrow, index: x.out_index, ...JSON.parse(x.state) })),
    };
  }

  return { pass, carry, checkLiquidationEscrow, takeCarrierPegIn, servedCarriers, served, contextOf, walk, buildAt, claimState };
}
