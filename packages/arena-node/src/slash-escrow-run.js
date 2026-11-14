// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A SLASH LEFT IN ESCROW IS SIGNED, CARRIED AND PAID ON (spec 5A.3B, RULED 2026-11-03, kanban #1085; built for #972 on the 2.0 line).
//
// A slash's table can leave money in its escrow: players owed with no carrier yet, or a reserves' part no federation had room for. The escrow output has the hold's release leaf
// (t of n of both panels, no wait) and its fallback leaf (slash_fallback_blocks, the census key); with no panels only the fallback leaf. Every seat checks its escrows every 6
// blocks. A spend is due when a carrier has published a signed peg-in for it (the players' part) or a federation has room for the reserves' part, read on the federation records
// in force at a height the spend names in its outputs[]: at or above the escrow's confirmation, at or below the tip when it is signed. Each signer builds the spend from what it
// reads itself at that height and signs only its own bytes:
//
//   A PANEL MEMBER builds at its own check height, serves its proposal and signature at GET /slash-release, reads the other members' proposals there, signs each one it rebuilds
//   byte for byte at the height it names, and sends one at t of each panel.
//   A HOLDER OF THE CENSUS KEY, once slash_fallback_blocks have passed since the escrow confirmed, files in a turn by a hash of the proof and its key, and asks the other holders
//   in two rounds of FROST (kind `escrow`); each signs only for its own outputs[] at the height asked.
//   A CARRIER publishes one CarrierPegIn per escrow outpoint and federation at POST /slash/<payout_table_id>/carriers, and once the spend is mined pays on what it carried.
//
// Who carries is the release's rule read again at the spend: panel A's members in score order for the panels' leaf, the census key's holders in descending shares (less the accused
// and the round's seats) for the fallback leaf, none above its own bond, a member that has left the census skipped. The fee is the start's own rate, off the reserves' part, and
// off each player's part pro rata to its loss only when there is no reserves' part (slash-release.js escrowSlices). Each players' output holds the table's carrier margin past
// its part, out of the reserves' share, and outputs[] says when there is no such share and the players bear it (kanban #1086).
import { schnorr } from '@noble/curves/secp256k1.js';
import { panelThreshold } from '../../arena-protocol/src/bond-script.js';
import { carrierEscrowPegInId } from '../../arena-protocol/src/census-key.js';
import { decodeSlashEscrowOutputs, decodeSlashPayoutTable, escrowTableSpend } from '../../arena-protocol/src/slash.js';
import { escrowSlices, escrowWitness, slashEscrowOutput, slashEscrowSpend } from '../../arena-protocol/src/slash-release.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { gatherCensusSignature } from './census-sign.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const display = (internalHex) => toHex(fromHex(internalHex).reverse());
const same = (a, b) => toHex(a) === toHex(b);
const ALREADY = /txn-same-nonwitness-data-in-mempool|already in (the )?(mempool|block ?chain)|txn-already-known|txn-already-in-mempool|already known/i;
/** "Every seat checks its escrows every 6 blocks" (#1085): a new spend is built once per such window, at its first height. */
export const ESCROW_CHECK_BLOCKS = 6;
const outpointOf = (s) => { const [txid, vout] = String(s).split(':'); return { txid: fromHex(txid).reverse(), vout: Number(vout) }; };
const nameOf = (txidDisplay, vout) => `${txidDisplay}:${vout}`;

/**
 * Made by slash-release-run.js with its own reads: `confirmedOf(start)` the release or fallback that confirmed, `peers()` the census' keys, `fallbackRank`, and the run's deps.
 */
export function createSlashEscrow({ asker = null, secret, me, clocks, db, tweakPoint, tipHeight, entriesAtTip, txOut, fetchProof, judge, panelsOf, seatsOf, holdersOf, heldKey, thresholdOf,
  signer, urlOf, fetchFn, send, portFor, scriptOf, federationsAt, retired, now, stepMs, log, confirmedOf, peers, fallbackRank, getJson, payOn }) {
  db.exec(`CREATE TABLE IF NOT EXISTS slash_escrow_chain (table_id TEXT NOT NULL, seq INTEGER NOT NULL, start TEXT NOT NULL, escrow_in TEXT NOT NULL, value INTEGER NOT NULL, path TEXT NOT NULL,
      outputs BLOB NOT NULL, txid TEXT NOT NULL, PRIMARY KEY (table_id, seq));
    CREATE TABLE IF NOT EXISTS slash_escrow_props (escrow TEXT NOT NULL, outputs_id TEXT NOT NULL, table_id TEXT NOT NULL, start TEXT NOT NULL, path TEXT NOT NULL, load_height INTEGER NOT NULL,
      outputs BLOB NOT NULL, txid TEXT NOT NULL, signature BLOB, sent TEXT, made_ms INTEGER NOT NULL, PRIMARY KEY (escrow, outputs_id));
    CREATE TABLE IF NOT EXISTS slash_escrow_sigs (escrow TEXT NOT NULL, outputs_id TEXT NOT NULL, node TEXT NOT NULL, signature BLOB NOT NULL, PRIMARY KEY (escrow, outputs_id, node));
    CREATE TABLE IF NOT EXISTS slash_carrier_pegins (table_id TEXT NOT NULL, escrow TEXT NOT NULL, federation TEXT NOT NULL, node TEXT NOT NULL, script BLOB NOT NULL, signature BLOB NOT NULL,
      PRIMARY KEY (table_id, escrow, federation, node))`);

  // ---- WHAT AN ESCROW IS: the confirmed table's escrow output, rebuilt from the start, the round's panels and the census key ----
  const contexts = new Map();                     // start -> the escrow's context, once its release or fallback confirmed
  async function contextOf(start) {
    if (contexts.has(start)) return contexts.get(start);
    const h = db.prepare('SELECT * FROM slash_holds WHERE start = ?').get(start);
    if (!h || !h.census_key || h.rate === null || h.rate === undefined) return null;
    const conf = await confirmedOf(start);
    if (!conf) return null;
    const at = conf.table.outputs.findIndex((o) => o.pays === 'escrow');
    if (at < 0) { contexts.set(start, null); return null; }
    const bytes = await fetchProof(fromHex(h.proof_id));
    const read = bytes ? judge.read(bytes) : null;
    if (!read || !read.ok) return null;
    // A SLASH WITH NO ROUND: its escrow pays a liquidation's claims (liquidation-escrow-run.js), not a round's entries
    if (!read.roundId) { contexts.set(start, null); return null; }
    const censusKey = fromHex(h.census_key);
    const panels = panelsOf(read.contract, read.roundId);
    const escrowOut = conf.table.outputs[at];
    const withPanels = panels && panels.ok && panels.panelA.length ? slashEscrowOutput({ panelA: panels.panelA, panelB: panels.panelB, censusKey, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint }) : null;
    const bare = slashEscrowOutput({ censusKey, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
    const output = withPanels && same(withPanels.script, escrowOut.script) ? withPanels : same(bare.script, escrowOut.script) ? bare : null;
    if (!output) { log(`[slash] the escrow of ${start.slice(0, 16)} is under a script this seat cannot rebuild`); return null; }
    const ctx = { start, h, conf, table: conf.table, tableId: conf.tableId, output, panels: output.panels ? panels : null, contract: read.contract, roundId: read.roundId, censusKey,
      proofId: fromHex(h.proof_id), rate: BigInt(h.rate), first: { txid: conf.txid, vout: at + 1, value: escrowOut.value }, playersFed: toHex(read.contract.federationId) };
    contexts.set(start, ctx);
    return ctx;
  }
  const startOfTable = (tableId) => { for (const [s, c] of contexts) if (c && c.tableId === String(tableId).toLowerCase()) return s; return null; };

  // ---- THE ESCROW'S SPENDS ON THE CHAIN, IN ORDER ----
  const chainOf = (tableId) => db.prepare('SELECT * FROM slash_escrow_chain WHERE table_id = ? ORDER BY seq').all(tableId);
  const spendsOf = (rows) => rows.map((r) => { const d = decodeSlashEscrowOutputs(new Uint8Array(r.outputs)); return { value: BigInt(r.value), outputs: d.outputs, marginMsat: d.marginMsat, marginOff: d.marginOff }; });

  /** The transaction an escrow spend's outputs[] make, by `path` from the escrow `inName` of `value`: what every signer rebuilds, and what the txid checks. */
  function txOfOutputs(ctx, inName, value, path, bytes) {
    const o = decodeSlashEscrowOutputs(bytes);
    if (toHex(o.tableId) !== ctx.tableId) return null;
    const payees = o.outputs.filter((x) => x.pays !== 'escrow');
    const fee = value - o.outputs.reduce((a, x) => a + x.value, 0n);
    if (fee < 0n) return null;
    const built = escrowTableSpend({ escrow: { ...outpointOf(inName), value, script: ctx.output.script }, tableId: o.tableId, loadHeight: o.loadHeight, marginMsat: o.marginMsat, marginOff: o.marginOff, payees, feeSats: fee,
      sequence: path === 'release' ? 0xfffffffd : clocks.fallbackBlocks });
    if (!built.ok) return null;
    return { ...built, txid: display(toHex(parseTransaction(serializeSpend({ ...built.tx, witnesses: [[new Uint8Array(64)]] })).txid)), decoded: o };
  }

  /** A spend of the escrow `inName` the chain holds: one of this seat's own proposals, or one a signer serves, whose txid has a confirmed output. */
  async function findSpend(ctx, inName, value) {
    const cands = db.prepare('SELECT path, outputs FROM slash_escrow_props WHERE escrow = ?').all(inName).map((r) => ({ path: r.path, bytes: new Uint8Array(r.outputs) }));
    for (const k of signersOf(ctx).filter((x) => x !== me)) {
      try { const s = await getJson(`${urlOf(k)}/slash-release?start=${ctx.start}`); for (const p of (s.escrow && s.escrow.proposals) || []) if (p.escrow === inName) cands.push({ path: p.path, bytes: fromHex(p.outputs) }); } catch { /* the next */ }
    }
    const tip = await tipHeight();
    for (const c of cands) {
      const t = txOfOutputs(ctx, inName, value, c.path, c.bytes);
      if (!t) continue;
      for (let i = 1; i < t.tx.outputs.length; i++) {
        const got = await txOut(t.txid, i).catch(() => null);
        if (got && got.confirmations > 0) return { path: c.path, bytes: c.bytes, txid: t.txid, decoded: t.decoded, height: tip - got.confirmations + 1 };
      }
    }
    return null;
  }

  /**
   * WHERE THE ESCROW STANDS: its spends on the chain (kept once found) and the output it is now, with its confirmation height; `done` when a spend left nothing in it, `wait` when
   * this seat cannot see it confirmed yet.
   */
  async function walk(ctx) {
    const tip = await tipHeight();
    let rows = chainOf(ctx.tableId);
    let cur = ctx.first;
    if (rows.length) {
      const last = rows[rows.length - 1], o = decodeSlashEscrowOutputs(new Uint8Array(last.outputs)).outputs;
      const back = o.findIndex((x) => x.pays === 'escrow');
      if (back < 0) return { done: true, rows };
      cur = { txid: last.txid, vout: back + 1, value: o[back].value };
    }
    for (let step = 0; step < 16; step++) {
      const inName = nameOf(cur.txid, cur.vout);
      const got = await txOut(cur.txid, cur.vout).catch(() => null);
      if (got && got.confirmations > 0) return { rows, cur: { ...cur, name: inName, confHeight: tip - got.confirmations + 1 } };
      const next = await findSpend(ctx, inName, cur.value);
      if (!next) return { rows, wait: `the escrow ${inName.slice(0, 16)} is not confirmed here and no spend of it is known` };
      db.prepare('INSERT OR IGNORE INTO slash_escrow_chain (table_id, seq, start, escrow_in, value, path, outputs, txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ctx.tableId, rows.length, ctx.start, inName, Number(cur.value), next.path, next.bytes, next.txid);
      rows = chainOf(ctx.tableId);
      const back = next.decoded.outputs.findIndex((x) => x.pays === 'escrow');
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
  /** Whom a seat asks about an escrow: both panels, and the census key's holders. */
  function signersOf(ctx) {
    const keys = new Set(ctx.panels ? [...ctx.panels.panelA, ...ctx.panels.panelB].map(toHex) : []);
    for (const h of holdersCache.get(ctx.start) || []) keys.add(h.key);
    return [...keys];
  }
  /** The keys that may carry by `path`, in carrying order: panel A in score order, or the holders in descending shares less the accused and the round's seats. */
  async function carrierKeys(ctx, path) {
    if (path === 'release') return ctx.panels.panelA.map(toHex);
    const excluded = new Set([ctx.h.node, ...(await seatsOf(ctx.contract, ctx.roundId))]);
    return [...await holdersFor(ctx)].sort((a, b) => b.shares - a.shares || (a.key < b.key ? -1 : 1)).map((x) => x.key).filter((k) => !excluded.has(k));
  }
  /** Every key that may carry this escrow at all: what a CarrierPegIn is held to before a seat keeps it. */
  async function anyCarrier(ctx) {
    const keys = new Set(ctx.panels ? await carrierKeys(ctx, 'release') : []);
    for (const k of await carrierKeys(ctx, 'fallback')) keys.add(k);
    return keys;
  }

  /** The carriers of a spend by `path` of the escrow `inName`: each published peg-in, in carrying order, its bond at the tip; a key out of the census skipped. */
  async function carriersFor(ctx, path, inName) {
    const entries = (await entriesAtTip()) || [];
    const bonds = new Map();
    for (const e of entries) bonds.set(toHex(e.pubkey), (bonds.get(toHex(e.pubkey)) || 0n) + BigInt(e.bondSats));
    const rows = db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ? AND escrow = ?').all(ctx.tableId, inName);
    const out = [];
    for (const k of await carrierKeys(ctx, path)) {
      if (!bonds.has(k)) continue;
      const mine = rows.filter((r) => r.node === k).sort((a, b) => (a.federation === ctx.playersFed ? -1 : b.federation === ctx.playersFed ? 1 : a.federation < b.federation ? -1 : 1));
      for (const r of mine) out.push({ key: k, federation: r.federation, script: new Uint8Array(r.script), bondSats: bonds.get(k) });
    }
    return out;
  }

  // ---- CarrierPegIn: made, taken, handed on ----
  const pegInRecord = (r) => ({ node: r.node, tableId: r.table_id, escrow: r.escrow, federation: r.federation, script: toHex(new Uint8Array(r.script)), signature: toHex(new Uint8Array(r.signature)) });
  /**
   * POST /slash/<payout_table_id>/carriers: a CarrierPegIn { node, tableId, escrow "txid:vout", federation, script, signature }, checked against the carrier rule before it is
   * kept: its node key's signature, a table this seat holds confirmed, an escrow outpoint of that table, and a node that may carry it. A new one is handed on to the escrow's signers.
   */
  async function takeCarrierPegIn(tableId, rec) {
    const tid = String(tableId).toLowerCase();
    const start = startOfTable(tid);
    if (!start) return { ok: false, status: 503, why: 'this seat has not read a confirmed table with that id' };
    const ctx = contexts.get(start);
    if (!rec || String(rec.tableId || tid).toLowerCase() !== tid) return { ok: false, status: 400, why: 'a CarrierPegIn names its table' };
    let script, signature, fid, at;
    try { script = fromHex(String(rec.script)); signature = fromHex(String(rec.signature)); fid = String(rec.federation).toLowerCase(); at = outpointOf(rec.escrow); if (fromHex(fid).length !== 32 || at.txid.length !== 32 || !Number.isInteger(at.vout)) throw new Error('bad'); }
    catch { return { ok: false, status: 400, why: 'a CarrierPegIn is { node, tableId, escrow, federation, script, signature }' }; }
    const name = String(rec.escrow).toLowerCase();
    const known = name === nameOf(ctx.first.txid, ctx.first.vout) || chainOf(tid).some((r) => { const o = decodeSlashEscrowOutputs(new Uint8Array(r.outputs)).outputs; const b = o.findIndex((x) => x.pays === 'escrow'); return b >= 0 && nameOf(r.txid, b + 1) === name; });
    if (!known) return { ok: false, status: 409, why: 'that is no escrow outpoint of this table here' };
    if (!(await anyCarrier(ctx)).has(String(rec.node))) return { ok: false, status: 409, why: 'that node carries no part of this escrow by the carrier rule' };
    if (!verifySig(signature, carrierEscrowPegInId({ tableId: fromHex(tid), outpoint: at, federationId: fromHex(fid), script }), fromHex(String(rec.node)))) return { ok: false, status: 409, why: 'that CarrierPegIn is not signed by its node' };
    const had = db.prepare('SELECT 1 FROM slash_carrier_pegins WHERE table_id = ? AND escrow = ? AND federation = ? AND node = ?').get(tid, name, fid, String(rec.node));
    if (had) return { ok: true, kept: false };
    db.prepare('INSERT INTO slash_carrier_pegins (table_id, escrow, federation, node, script, signature) VALUES (?, ?, ?, ?, ?, ?)').run(tid, name, fid, String(rec.node), script, signature);
    handOn(ctx, { node: String(rec.node), tableId: tid, escrow: name, federation: fid, script: toHex(script), signature: toHex(signature) });
    return { ok: true, kept: true };
  }
  function handOn(ctx, rec) {
    for (const k of signersOf(ctx)) {
      if (k === me || k === rec.node || !urlOf(k)) continue;
      fetchFn(`${urlOf(k)}/slash/${ctx.tableId}/carriers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), signal: AbortSignal.timeout(20000) }).catch(() => {});
    }
  }
  const servedCarriers = (tableId) => ({ tableId: String(tableId).toLowerCase(), carriers: db.prepare('SELECT * FROM slash_carrier_pegins WHERE table_id = ?').all(String(tableId).toLowerCase()).map(pegInRecord) });

  /** THIS NODE AS A CARRIER: one peg-in per escrow outpoint and federation, made once by its own client and signed by its node key, kept here and handed to the signers. */
  async function ownEscrowPegIn(ctx, inName, fid) {
    const start = `escrow:${inName}`;
    let row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, 'escrow');
    if (!row) {
      const port = await portFor(fid);
      if (!port || typeof port.peginAddress !== 'function') return null;
      const address = await port.peginAddress();
      db.prepare('INSERT OR IGNORE INTO slash_pegins (start, federation, use, address, script) VALUES (?, ?, ?, ?, ?)').run(start, fid, 'escrow', address, scriptOf(address));
      row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, 'escrow');
    }
    const script = new Uint8Array(row.script);
    const signature = schnorr.sign(carrierEscrowPegInId({ tableId: fromHex(ctx.tableId), outpoint: outpointOf(inName), federationId: fromHex(fid), script }), secret);
    return { node: me, tableId: ctx.tableId, escrow: inName, federation: fid, script: toHex(script), signature: toHex(signature) };
  }
  const published = new Set();
  async function publish(ctx, cur) {
    const view = (await federationsAt(cur.confHeight)) || [];
    // a federation whose reserve key this seat has not read yet (reservePending, kanban #1129) gets its peg-in too: the spend waits for the key, not for a carrier after it
    const fids = [...new Set([ctx.playersFed, ...view.filter((f) => f && f.status === 'OPEN' && (f.reserveKey || f.reservePending)).map((f) => String(f.federation).toLowerCase())])];
    for (const fid of fids) {
      const name = `${cur.name}:${fid}`;
      if (published.has(name)) continue;
      let rec; try { rec = await ownEscrowPegIn(ctx, cur.name, fid); } catch (e) { log(`[slash] no escrow peg-in into ${fid.slice(0, 16)}: ${e.message}`); continue; }
      if (!rec) continue;
      published.add(name);
      await takeCarrierPegIn(ctx.tableId, rec);
    }
  }
  /** What the other signers hold, read at their doors: what a POST missed still arrives. */
  async function pull(ctx) {
    for (const k of signersOf(ctx)) {
      if (k === me || !urlOf(k)) continue;
      let got; try { got = await getJson(`${urlOf(k)}/slash/${ctx.tableId}/carriers`); } catch { continue; }
      for (const rec of (got && got.carriers) || []) await takeCarrierPegIn(ctx.tableId, rec);
    }
  }

  // ---- BUILDING, AT A NAMED HEIGHT ----
  /** This seat's escrow spend by `path` at `loadHeight`, from its own records at that height and the peg-ins it holds. */
  async function buildAt(ctx, w, path, loadHeight) {
    const federations = (await federationsAt(loadHeight)) || [];
    // A RESERVE KEY THIS SEAT HAS NOT READ YET IS NOT "NO RESERVE KEY" (kanban #1129, as the release's table, slash-release-run.js build): a federation whose guardian
    // seats stand has a key; built without it, this seat's outputs[] place no reserves' part there and no signer that read the key builds those bytes. It waits, by name.
    // NO CAP HERE (#1130 caps the hold's release and fallback, which race the owner's return leaf): the escrow has no return leaf, so a wait loses nothing
    const gone = new Set((retired || []).map((x) => String(x).toLowerCase()));
    const unread = federations.filter((f) => f && f.status === 'OPEN' && !f.reserveKey && f.reservePending && !gone.has(String(f.federation).toLowerCase()) && BigInt(f.exposureCapSats || 0) > 0n);
    if (unread.length) return { ok: false, why: `the reserve key of federation ${unread.map((f) => String(f.federation).slice(0, 16)).join(', ')} is not read here yet: no escrow spend is built without its reserves' part`, wait: true };
    const carriers = await carriersFor(ctx, path, w.cur.name);
    return slashEscrowSpend({ path, escrow: { ...outpointOf(w.cur.name), value: w.cur.value }, output: ctx.output, table: ctx.table, tableId: fromHex(ctx.tableId), spends: spendsOf(w.rows),
      loadHeight, carriers, playersFederation: ctx.playersFed, federations, retired, rate: ctx.rate, panels: ctx.panels, fallbackBlocks: clocks.fallbackBlocks });
  }
  const propOf = (inName, oid) => db.prepare('SELECT * FROM slash_escrow_props WHERE escrow = ? AND outputs_id = ?').get(inName, oid) || null;
  function keepProp(ctx, w, path, b, loadHeight, signature = null) {
    const oid = toHex(b.outputsId);
    const txid = display(toHex(parseTransaction(serializeSpend({ ...b.spend.tx, witnesses: [[new Uint8Array(64)]] })).txid));
    db.prepare('INSERT OR IGNORE INTO slash_escrow_props (escrow, outputs_id, table_id, start, path, load_height, outputs, txid, signature, sent, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(w.cur.name, oid, ctx.tableId, ctx.start, path, loadHeight, b.bytes, txid, signature, now());
    if (signature && !propOf(w.cur.name, oid).signature) db.prepare('UPDATE slash_escrow_props SET signature = ? WHERE escrow = ? AND outputs_id = ?').run(signature, w.cur.name, oid);
    return propOf(w.cur.name, oid);
  }
  async function sendRaw(raw, txid, what) {
    try { return { ok: true, txid: String(await send(toHex(raw))) }; } catch (e) {
      if (!ALREADY.test(e.message)) return { ok: false, why: `the ${what} was not taken: ${e.message}` };
      return { ok: true, txid: display(toHex(txid)) };
    }
  }

  // ---- THE PANELS' LEAF: t of n of each, no wait ----
  async function escrowRelease(ctx, w, tip, fresh) {
    const members = [...ctx.panels.panelA, ...ctx.panels.panelB].map(toHex);
    const lowest = w.cur.confHeight;
    const builds = new Map();                     // outputs id -> { b, prop }
    const signOwn = async (loadHeight, wantId = null) => {
      const b = await buildAt(ctx, w, 'release', loadHeight);
      if (!b.ok) return b;
      if (wantId && toHex(b.outputsId) !== wantId) return { ok: false, why: 'not this seat\'s bytes' };
      const signature = schnorr.sign(b.digest, secret);
      const prop = keepProp(ctx, w, 'release', b, loadHeight, signature);
      builds.set(prop.outputs_id, { b, prop });
      return { ok: true, b, prop };
    };
    // ITS OWN: once per check window, at the window's first height (or the escrow's confirmation, if later)
    let mine = null;
    if (fresh) { mine = await signOwn(Math.max(lowest, Math.floor(tip / ESCROW_CHECK_BLOCKS) * ESCROW_CHECK_BLOCKS)); if (!mine.ok && mine.due === false) log(`[slash] escrow ${w.cur.name.slice(0, 16)} not due: ${mine.why}`); }
    // THE OTHERS': each proposal of this escrow it rebuilds byte for byte at the height it names, it signs too
    const served = [];
    for (const k of members) {
      if (k === me) continue;
      try { const s = await getJson(`${urlOf(k)}/slash-release?start=${ctx.start}`); served.push(...((s.escrow && s.escrow.proposals) || []).filter((p) => p.escrow === w.cur.name && p.path === 'release')); } catch { /* says nothing yet */ }
    }
    for (const p of served) {
      if (builds.has(p.outputsId) || !(p.loadHeight >= lowest && p.loadHeight <= tip)) continue;
      const held = propOf(w.cur.name, p.outputsId);
      if (held && held.signature) { const b = await buildAt(ctx, w, 'release', held.load_height); if (b.ok && toHex(b.outputsId) === p.outputsId) builds.set(p.outputsId, { b, prop: held }); continue; }
      await signOwn(p.loadHeight, p.outputsId);
    }
    for (const r of db.prepare('SELECT * FROM slash_escrow_props WHERE escrow = ? AND path = ? AND signature IS NOT NULL').all(w.cur.name, 'release')) {
      if (builds.has(r.outputs_id)) continue;
      const b = await buildAt(ctx, w, 'release', r.load_height);
      if (b.ok && toHex(b.outputsId) === r.outputs_id) builds.set(r.outputs_id, { b, prop: r });
    }
    // THE SIGNATURES OVER EACH, AND ONE GOES OUT AT t OF EACH PANEL
    const t = panelThreshold(ctx.panels.panelA.length);
    for (const [oid, { b, prop }] of builds) {
      const sigs = new Map([[me, new Uint8Array(prop.signature)]]);
      for (const r of db.prepare('SELECT node, signature FROM slash_escrow_sigs WHERE escrow = ? AND outputs_id = ?').all(w.cur.name, oid)) sigs.set(r.node, new Uint8Array(r.signature));
      for (const p of served.filter((x) => x.outputsId === oid)) {
        for (const x of [p.own, ...(p.signatures || [])].filter(Boolean)) {
          if (!members.includes(x.node) || sigs.has(x.node)) continue;
          const sig = fromHex(x.signature);
          if (verifySig(sig, b.digest, fromHex(x.node))) { sigs.set(x.node, sig); db.prepare('INSERT OR IGNORE INTO slash_escrow_sigs (escrow, outputs_id, node, signature) VALUES (?, ?, ?, ?)').run(w.cur.name, oid, x.node, sig); }
        }
      }
      const a = ctx.panels.panelA.filter((k) => sigs.has(toHex(k))).length, z = ctx.panels.panelB.filter((k) => sigs.has(toHex(k))).length;
      if (a < t || z < t) continue;
      const raw = serializeSpend({ ...b.spend.tx, witnesses: [escrowWitness({ escrow: ctx.output, path: 'release', panelA: ctx.panels.panelA, panelB: ctx.panels.panelB, signatures: sigs })] });
      const r = await sendRaw(raw, parseTransaction(raw).txid, 'escrow spend');
      if (!r.ok) return r;
      db.prepare('UPDATE slash_escrow_props SET sent = ? WHERE escrow = ? AND outputs_id = ?').run(r.txid, w.cur.name, oid);
      return { ok: true, txid: r.txid, outputsId: oid, loadHeight: prop.load_height, signers: { a, b: z, t }, feeSats: b.feeSats };
    }
    return mine && !mine.ok ? mine : { ok: false, why: 'the panels have not signed one spend at t of each yet' };
  }

  // ---- THE CENSUS KEY'S LEAF: slash_fallback_blocks after the escrow confirmed ----
  const fbSince = new Map();
  async function escrowFallback(ctx, w, tip, fresh) {
    const loadHeight = Math.max(w.cur.confHeight, Math.floor(tip / ESCROW_CHECK_BLOCKS) * ESCROW_CHECK_BLOCKS);
    const held = db.prepare('SELECT * FROM slash_escrow_props WHERE escrow = ? AND path = ? ORDER BY made_ms DESC').get(w.cur.name, 'fallback');
    const b = await buildAt(ctx, w, 'fallback', fresh || !held ? loadHeight : held.load_height);
    if (!b.ok) return b;
    const prop = keepProp(ctx, w, 'fallback', b, fresh || !held ? loadHeight : held.load_height);
    const holders = (await holdersFor(ctx)).map((x) => x.key);
    if (!fbSince.has(w.cur.name)) fbSince.set(w.cur.name, now());
    const rank = fallbackRank(ctx.proofId, holders, me);
    if (rank < 0 || now() - fbSince.get(w.cur.name) < rank * stepMs) return { ok: false, why: `not this holder's turn to file yet (rank ${rank})`, quiet: true };
    const keyHex = toHex(ctx.censusKey);
    const threshold = thresholdOf(keyHex);
    if (!threshold) return { ok: false, why: `this seat reads no threshold for key ${keyHex.slice(0, 16)}` };
    const request = { kind: 'escrow', start: ctx.start, tableId: ctx.tableId, escrow: w.cur.name, loadHeight: prop.load_height, outputsId: prop.outputs_id };
    const own = heldKey(ctx.censusKey) ? signer() : null;
    const got = await gatherCensusSignature({ asker, request, digest: b.digest, publicKey: ctx.censusKey, threshold, urls: holders.filter((k) => k !== me).map(urlOf).filter(Boolean), own, fetchFn });
    if (!got.ok) return got;
    const raw = serializeSpend({ ...b.spend.tx, witnesses: [escrowWitness({ escrow: ctx.output, path: 'fallback', signature: got.signature })] });
    const r = await sendRaw(raw, parseTransaction(raw).txid, 'escrow fallback');
    if (!r.ok) return r;
    db.prepare('UPDATE slash_escrow_props SET sent = ? WHERE escrow = ? AND outputs_id = ?').run(r.txid, w.cur.name, prop.outputs_id);
    return { ok: true, txid: r.txid, outputsId: prop.outputs_id, loadHeight: prop.load_height, signers: got.signers, feeSats: b.feeSats };
  }

  /**
   * A HOLDER ASKED TO SIGN AN ESCROW SPEND (POST /census-sign/commit, kind `escrow`): the escrow is the one this seat reads now, its fallback leaf has opened, the height named
   * lies between its confirmation and the tip, and the outputs[] this seat builds at that height are the ones named. The digest is its own.
   */
  async function checkEscrow(request) {
    const ctx = await contextOf(String(request.start || '').toLowerCase());
    if (!ctx) return { ok: false, why: 'this seat reads no confirmed escrow for that start' };
    if (ctx.tableId !== String(request.tableId).toLowerCase()) return { ok: false, why: 'that is not the table this seat reads confirmed' };
    await holdersFor(ctx);
    const w = await walk(ctx);
    if (!w.cur) return { ok: false, why: w.done ? 'that escrow is spent to the end' : w.wait };
    if (w.cur.name !== String(request.escrow).toLowerCase()) return { ok: false, why: `this seat's escrow is ${w.cur.name.slice(0, 16)}, not that one` };
    const tip = await tipHeight();
    if (tip < w.cur.confHeight + clocks.fallbackBlocks - 1) return { ok: false, why: 'that escrow\'s fallback leaf has not opened yet' };
    const h = Number(request.loadHeight);
    if (!Number.isInteger(h) || h < w.cur.confHeight || h > tip) return { ok: false, why: `an escrow spend names a height from ${w.cur.confHeight} to ${tip}, not ${request.loadHeight}` };
    const b = await buildAt(ctx, w, 'fallback', h);
    if (!b.ok) return b;
    if (toHex(b.outputsId) !== String(request.outputsId).toLowerCase()) return { ok: false, why: `this seat's own outputs at ${h} are ${toHex(b.outputsId).slice(0, 16)}, not ${String(request.outputsId).slice(0, 16)}` };
    keepProp(ctx, w, 'fallback', b, h);
    return { ok: true, digest: b.digest, publicKey: ctx.censusKey };
  }

  // ---- ONE PASS: every escrow this seat reads, checked once per 6 blocks ----
  const checked = new Map();                      // escrow name -> the window it was last built in
  async function pass() {
    const done = [];
    const tip = await tipHeight();
    const win = Math.floor(tip / ESCROW_CHECK_BLOCKS);
    for (const h of db.prepare('SELECT start FROM slash_holds WHERE census_key IS NOT NULL ORDER BY height').all()) {
      let ctx; try { ctx = await contextOf(h.start); } catch (e) { done.push({ start: h.start, why: e.message }); continue; }
      if (!ctx) continue;
      await holdersFor(ctx);
      const w = await walk(ctx);
      if (!w.cur) continue;
      const onPanel = !!ctx.panels && [...ctx.panels.panelA, ...ctx.panels.panelB].some((k) => toHex(k) === me);
      const holder = !!heldKey(ctx.censusKey);
      const fallbackOpen = tip >= w.cur.confHeight + clocks.fallbackBlocks - 1;
      if ((await anyCarrier(ctx)).has(me)) await publish(ctx, w.cur);
      if (!onPanel && !holder) continue;
      await pull(ctx);
      const fresh = checked.get(w.cur.name) !== win;
      checked.set(w.cur.name, win);
      if (onPanel) {
        const r = await escrowRelease(ctx, w, tip, fresh).catch((x) => ({ ok: false, why: x.message }));
        done.push({ start: ctx.start, path: 'escrow-release', escrow: w.cur.name, ...r });
        if (r.ok) { log(`[slash] escrow spend of ${ctx.start.slice(0, 16)} sent: ${r.txid}`); continue; }
      }
      if (holder && fallbackOpen) {
        const r = await escrowFallback(ctx, w, tip, fresh).catch((x) => ({ ok: false, why: x.message }));
        done.push({ start: ctx.start, path: 'escrow-fallback', escrow: w.cur.name, ...r });
        if (r.ok) log(`[slash] escrow fallback of ${ctx.start.slice(0, 16)} sent: ${r.txid}`);
      }
      // A BUILD THAT WAITED (a reserve key not read yet, kanban #1129) has not checked this window: the next pass builds its own again, at the same height
      if (done.some((r) => r.escrow === w.cur.name && r.wait)) checked.delete(w.cur.name);
    }
    return done;
  }

  // ---- THE CARRIERS PAY ON EACH ESCROW SPEND ON THE CHAIN ----
  async function carry() {
    const done = [];
    // WHAT THE CHAIN HOLDS NOW: a spend mined since the last pass is read here, so a carrier pays on without waiting for a pass
    if (db.prepare("SELECT 1 FROM slash_pegins WHERE use = 'escrow' LIMIT 1").get()) {
      for (const h of db.prepare('SELECT start FROM slash_holds WHERE census_key IS NOT NULL').all()) { const ctx = await contextOf(h.start).catch(() => null); if (ctx) await walk(ctx).catch(() => null); }
    }
    for (const t of db.prepare('SELECT DISTINCT table_id FROM slash_escrow_chain').all()) {
      const rows = chainOf(t.table_id);
      const tbl = db.prepare('SELECT bytes FROM slash_tables WHERE table_id = ?').get(t.table_id);
      if (!tbl) continue;
      const sliced = escrowSlices({ table: decodeSlashPayoutTable(new Uint8Array(tbl.bytes)), spends: spendsOf(rows) }).spends;
      for (const [seq, r] of rows.entries()) {
        const mine = db.prepare('SELECT federation, address, script FROM slash_pegins WHERE start = ?').all(`escrow:${r.escrow_in}`);
        if (!mine.length) continue;
        const d = decodeSlashEscrowOutputs(new Uint8Array(r.outputs));
        // EACH OUTPUT THIS CARRIER CARRIES, with the margin the spend names (kanban #1086): a players' output holds it past its slices, or the players bear it pro rata
        for (const [i, o] of d.outputs.entries()) {
          if (o.pays !== 'player_carrier' && o.pays !== 'reserves') continue;
          const peg = mine.find((p) => same(new Uint8Array(p.script), o.script));
          if (!peg) continue;
          const got = await payOn({ name: { start: `escrow:${r.escrow_in}`, path: 'escrow', index: i }, startHex: r.start, txid: r.txid, vout: i + 1, o, peg, marginMsat: d.marginMsat,
            slices: (sliced[seq].find((y) => y.index === i) || { slices: [] }).slices });
          if (got) done.push(got);
        }
      }
    }
    return done;
  }

  /** What GET /slash-release?start= adds for the escrow: its table, its spends on the chain, and this seat's proposals with their signatures. */
  function served(start) {
    const c = contexts.get(start);
    const props = db.prepare('SELECT * FROM slash_escrow_props WHERE start = ?').all(start);
    if (!c && !props.length) return null;
    return {
      tableId: c ? c.tableId : props[0].table_id,
      spends: c ? chainOf(c.tableId).map((r) => ({ escrow: r.escrow_in, path: r.path, txid: r.txid, outputs: toHex(new Uint8Array(r.outputs)) })) : [],
      proposals: props.map((r) => ({ escrow: r.escrow, path: r.path, outputsId: r.outputs_id, loadHeight: r.load_height, outputs: toHex(new Uint8Array(r.outputs)), txid: r.txid, sent: r.sent,
        own: r.signature ? { node: me, signature: toHex(new Uint8Array(r.signature)) } : null,
        signatures: db.prepare('SELECT node, signature FROM slash_escrow_sigs WHERE escrow = ? AND outputs_id = ?').all(r.escrow, r.outputs_id).map((x) => ({ node: x.node, signature: toHex(new Uint8Array(x.signature)) })) })),
    };
  }

  return { pass, carry, checkEscrow, takeCarrierPegIn, servedCarriers, served };
}
