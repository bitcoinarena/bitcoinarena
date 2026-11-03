// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STARTED BOND IS RELEASED, OR TAKEN BY THE FALLBACK, AND ITS CARRIERS PAY (spec 5A.3B steps 4 and 5, kanban #972, decision #1083).
//
// Every seat reads the started bonds of its own census at the tip. For each one it reads the start off its chain (the proof it names, its slash height, its fee input), the proof
// by its hash, and the round in the proof. Then:
//
//   A PANEL MEMBER of that round, slash_hold_blocks after the start, replays the proof itself, builds the payout table from what it reads itself and signs the release only over
//   its own bytes. It reads the others' signatures from their doors and keeps those that sign the same bytes; t of each panel, and it sends the release.
//   A HOLDER OF THE CENSUS KEY the bond names, slash_fallback_blocks after the start with the hold still there, builds the fallback with the key's holders as carriers. One holder
//   at a time (a turn by a hash of the proof) asks the others in two rounds of FROST; each one answers only for its own bytes.
//   A CARRIER, once the release or the fallback is out, claims the peg-in the table paid it, pays each player's loss it carries to that player's key, and the rest of what it claimed
//   to the federation's reserve key, kept as a reserve row of kind `slash`.
//
// What a signer reads, it reads from the chain, the proof and the seats a round names: its own census for the panels, the holders and the bonds; the round's seats for how the
// round settled (GET /audit-run, every signature checked); the carriers for their peg-ins, each signed by its node key; its own federation records for the reserves' load. Two
// signers that read the same build the same bytes. Two that do not sign different bytes, nothing adds up, and the fallback is the way out.
import { schnorr } from '@noble/curves/secp256k1.js';
import { BOND_TEMPLATE_V3, holdOutputKey, panelThreshold } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitmentIn, holdSlashSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { carrierPegInId, fallbackCarriers } from '../../arena-protocol/src/census-key.js';
import { decodeSlashPayoutTable, fraudProofHash, slashDistribution, slashPayoutTableId } from '../../arena-protocol/src/slash.js';
import { carrierSlices, fallbackWitness, releaseWitness, signedHoldSpend, slashEscrowOutput, slashHoldSpend, startFeeRate } from '../../arena-protocol/src/slash-release.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { gatherCensusSignature } from './census-sign.js';
import { createSlashEscrow } from './slash-escrow-run.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const display = (internalHex) => toHex(fromHex(internalHex).reverse());
const same = (a, b) => toHex(a) === toHex(b);
/** What a carrier keeps back of a claim for its own payout transaction's fee, as the arbitration set does (liquidation-claims.js REMAINDER_FEE_MARGIN_MSAT). */
export const CARRIER_FEE_MARGIN_MSAT = 10_000n;
/** A send refused because the very transaction is already there: another signer sent it first. */
const ALREADY = /already in (the )?(mempool|block ?chain)|txn-already-known|txn-already-in-mempool|already known/i;

/** Which holder files a fallback first: a hash of the proof and the key, as a start's filer (slash-start-run.js filerRank), under its own tag. */
export const fallbackRank = (proofId, keys, me) => [...keys].sort((a, b) => (toHex(taggedHash('ARENA/v1/SlashFallbackFiler', Uint8Array.from([...proofId, ...fromHex(a)])))
  < toHex(taggedHash('ARENA/v1/SlashFallbackFiler', Uint8Array.from([...proofId, ...fromHex(b)]))) ? -1 : 1)).indexOf(me);

/**
 * `key`, `secret` this node's; `networkId`, `clocks` { holdBlocks, returnBlocks, fallbackBlocks }; `db`; `tweakPoint` the curve.
 * `tipHeight()`; `entriesAtTip()` the census at the tip, started bonds with their `hold`; `rawTx(txid display hex, nearHeight)` a transaction's bytes or null; `unspent(txid display, vout)`;
 * `txOut(txid display, vout)` -> { sats, script hex, confirmations } of a confirmed unspent output, or null (gettxout without the mempool); by default read from `unspent`.
 * `federationsAt(height)` the reserves' view on the federation records in force at that height, as `federations()` answers it (an escrow spend's named height, #1085).
 * `fetchProof(id)` the bytes under a proof's hash or null; `judge(bytes, { startHeight })` -> { verdict, why, held } with `judge.read`; `panelsOf(contract, rid)`; `seatsOf(contract, rid)`
 * the round's drawn keys (hex); `lossesFor({ contract, rid, held })` -> { ok, losses: Map key hex -> msat, entryIds: Map key hex -> bytes } or { ok: false, why }.
 * `federations()` the reserves' view, [{ federation, status, reserveKey, reserveSats, exposureCapSats }]; `retired` hex; `portFor(fid hex)` a stake-lock port or null; `scriptOf(address)`;
 * `reserveKeyOf(fid hex)` 33 bytes or null; `keepReserveRow(row)`.
 * `urlOf(key hex)`; `heldKey(publicKey)` CensusKeyStore's; `thresholdOf(key hex)`; `holdersOf(key hex, height)` -> [{ key, shares }]; `signer()` this node's census signer or null.
 * `send(hex)`.
 */
export function createSlashRelease({ key, secret, networkId, clocks, db, tweakPoint, tipHeight, entriesAtTip, rawTx, unspent, fetchProof, judge, panelsOf, seatsOf = () => [], lossesFor,
  federations = async () => [], retired = [], portFor = async () => null, scriptOf, reserveKeyOf = () => null, keepReserveRow = () => {}, urlOf = () => null, heldKey = () => null,
  thresholdOf = () => null, holdersOf = async () => [], signer = () => null, send, stepMs = 600000, fetchFn = fetch, now = Date.now, log = () => {},
  txOut = async (txid, vout) => ((await unspent(txid, vout)) ? { confirmations: 1 } : null), federationsAt = async () => federations() }) {
  const me = toHex(key);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_holds (start TEXT PRIMARY KEY, height INTEGER NOT NULL, round_id TEXT, proof_id TEXT, node TEXT NOT NULL, bond TEXT NOT NULL, seen_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_spends (start TEXT NOT NULL, path TEXT NOT NULL, table_id TEXT NOT NULL, tbl BLOB NOT NULL, txid TEXT NOT NULL, fee INTEGER NOT NULL, signature BLOB,
      sent TEXT, made_ms INTEGER NOT NULL, PRIMARY KEY (start, path));
    CREATE TABLE IF NOT EXISTS slash_spend_sigs (start TEXT NOT NULL, table_id TEXT NOT NULL, node TEXT NOT NULL, signature BLOB NOT NULL, PRIMARY KEY (start, table_id, node));
    CREATE TABLE IF NOT EXISTS slash_pegins (start TEXT NOT NULL, federation TEXT NOT NULL, use TEXT NOT NULL, address TEXT NOT NULL, script BLOB NOT NULL, PRIMARY KEY (start, federation, use));
    CREATE TABLE IF NOT EXISTS slash_carried (start TEXT NOT NULL, path TEXT NOT NULL, out_index INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (start, path, out_index));
    CREATE TABLE IF NOT EXISTS slash_tables (table_id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_confirmed (start TEXT PRIMARY KEY, path TEXT NOT NULL, table_id TEXT NOT NULL, txid TEXT NOT NULL, height INTEGER NOT NULL)`);
  // THE ESCROW READS THE START WITHOUT THE CENSUS: once the hold is spent the bond is gone from it, so its census key and fee rate are kept with the start (#1085)
  for (const col of ['census_key TEXT', 'rate INTEGER', 'hold_value INTEGER', 'hold_script BLOB', 'slash_height INTEGER']) { try { db.exec(`ALTER TABLE slash_holds ADD COLUMN ${col}`); } catch { /* there already */ } }
  const spendOf = (start, path) => db.prepare('SELECT * FROM slash_spends WHERE start = ? AND path = ?').get(start, path) || null;
  const keepSpend = (start, path, b, signature) => {
    const txid = display(toHex(parseTransaction(serializeSpend({ ...b.spend.tx, witnesses: [[new Uint8Array(64)]] })).txid));
    db.prepare('INSERT OR IGNORE INTO slash_tables (table_id, bytes) VALUES (?, ?)').run(toHex(b.tableId), b.bytes);
    const had = spendOf(start, path);
    if (had && had.table_id === toHex(b.tableId)) return had;
    db.prepare('INSERT OR REPLACE INTO slash_spends (start, path, table_id, tbl, txid, fee, signature, sent, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)')
      .run(start, path, toHex(b.tableId), b.bytes, txid, Number(b.feeSats), signature, now());
    return spendOf(start, path);
  };

  // ---- THE START, READ ONCE: its proof, its slash height, its fee input, the round ----
  const starts = new Map();                       // start display hex -> what was read of it
  async function readStart(e) {
    const start = display(e.hold.txid);
    if (starts.has(start) && starts.get(start).bytes) return starts.get(start);
    const raw = await rawTx(start, e.hold.height);
    if (!raw) return null;
    const tx = parseTransaction(raw);
    const said = arbitrationCommitmentIn(tx.outputs);
    const prevouts = [{ value: BigInt(e.bondSats), script: e.script }];
    for (const input of tx.inputs.slice(1)) {
      const prev = await rawTx(toHex([...input.previousTxid].reverse()), e.hold.height);
      if (!prev) return null;
      prevouts.push(parseTransaction(prev).outputs[input.previousVout]);
    }
    const info = { start, raw, tx, height: e.hold.height, holdScript: tx.outputs[0].script, proofId: said ? said.proofId : null, slashHeight: said ? said.slashHeight : null,
      rate: startFeeRate({ startRaw: raw, prevouts }), filer: prevouts[1] ? { script: prevouts[1].script, sats: prevouts[1].value } : null, bytes: null, read: null };
    if (info.proofId) {
      const bytes = await fetchProof(info.proofId);
      if (bytes && same(fraudProofHash(bytes), info.proofId)) {
        const read = judge.read(bytes);
        if (read.ok && read.roundId) Object.assign(info, { bytes, read });
      }
    }
    starts.set(start, info);
    db.prepare('INSERT OR IGNORE INTO slash_holds (start, height, round_id, proof_id, node, bond, seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(start, e.hold.height, info.read ? toHex(info.read.roundId) : null, info.proofId ? toHex(info.proofId) : null, toHex(e.pubkey), `${toHex(e.txid)}:${e.vout}`, now());
    if (info.read && !db.prepare('SELECT round_id FROM slash_holds WHERE start = ?').get(start).round_id) db.prepare('UPDATE slash_holds SET round_id = ?, proof_id = ? WHERE start = ?').run(toHex(info.read.roundId), toHex(info.proofId), start);
    db.prepare('UPDATE slash_holds SET census_key = ?, rate = ?, hold_value = ?, hold_script = ?, slash_height = ? WHERE start = ?')
      .run(toHex(e.advert.censusKey), Number(info.rate), Number(tx.outputs[0].value), tx.outputs[0].script, info.slashHeight, start);
    return info;
  }

  /** The hold the start paid: the round's, with its panels, or the bond's own, with none. Null for a hold this seat cannot rebuild. */
  function holdOf(e, info) {
    const base = { nodeKey: e.pubkey, censusKey: e.advert.censusKey, bondMaturity: e.advert.bondMaturityHeight, ...clocks };
    const panels = panelsOf(info.read.contract, info.read.roundId);
    if (panels.ok && panels.panelA.length) {
      const h = holdOutputKey({ ...base, panelA: panels.panelA, panelB: panels.panelB }, { tweakPoint });
      if (h.ok && same(h.script, info.holdScript)) return { hold: h, panels };
    }
    const bare = holdOutputKey({ ...base, panelA: [], panelB: [] }, { tweakPoint });
    return bare.ok && same(bare.script, info.holdScript) ? { hold: bare, panels: null } : null;
  }

  // ---- WHAT A PEER SAYS AT ITS DOOR ----
  const getJson = async (url) => { const r = await fetchFn(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`); return r.json(); };

  /** A carrier's peg-in for this start, federation and use (the players' part or the reserves'), its node key's signature checked: { script, signature } or null. */
  const pegInsSeen = new Map();
  async function pegInOf(keyHex, start, fid, use) {
    const name = `${keyHex}:${start}:${fid}:${use}`;
    if (pegInsSeen.has(name)) return pegInsSeen.get(name);
    let got = null;
    try {
      const said = keyHex === me ? await ownPegIn(start, fid, use) : await getJson(`${urlOf(keyHex)}/slash-pegin?start=${start}&federation=${fid}&use=${use}`);
      const script = fromHex(said.script), signature = fromHex(said.signature);
      if (said.node === keyHex && verifySig(signature, carrierPegInId(networkId, script), fromHex(keyHex))) got = { script, signature };
    } catch { got = null; }
    if (got) pegInsSeen.set(name, got);
    return got;
  }

  /**
   * THIS NODE AS A CARRIER: one peg-in address per start, federation and use, made once by its own client and signed by its node key. The players' part and a reserves' part are
   * two outputs of one release, so they are two addresses: each deposit is claimed on its own. Throws where it has no client of that federation.
   */
  async function ownPegIn(start, fid, use = 'players') {
    if (use !== 'players' && use !== 'reserves') throw new Error('a peg-in is for the players\' part or the reserves\'');
    let row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, use);
    if (!row) {
      const port = await portFor(fid);
      if (!port || typeof port.peginAddress !== 'function') throw new Error(`this node holds no client of federation ${fid.slice(0, 16)}`);
      const address = await port.peginAddress();
      db.prepare('INSERT OR IGNORE INTO slash_pegins (start, federation, use, address, script) VALUES (?, ?, ?, ?, ?)').run(start, fid, use, address, scriptOf(address));
      row = db.prepare('SELECT address, script FROM slash_pegins WHERE start = ? AND federation = ? AND use = ?').get(start, fid, use);
    }
    const script = new Uint8Array(row.script);
    return { node: me, federation: fid, use, address: row.address, script: toHex(script), signature: toHex(schnorr.sign(carrierPegInId(networkId, script), secret)) };
  }

  // ---- THE TABLE'S INPUTS ----
  /** What earlier slashes of the same round pay its players: their tables' entries, in chain order then proof id, for every one not returned. Undefined while one cannot be read. */
  async function paidBefore(info) {
    const rid = toHex(info.read.roundId), mine = toHex(info.proofId);
    const earlier = db.prepare('SELECT start, height, proof_id FROM slash_holds WHERE round_id = ? AND (height < ? OR (height = ? AND proof_id < ?))').all(rid, info.height, info.height, mine);
    const paid = new Map();
    for (const r of earlier) {
      const kept = spendOf(r.start, 'release') || spendOf(r.start, 'fallback');
      let bytes = kept ? new Uint8Array(kept.tbl) : null;
      if (!bytes) {
        for (const k of peers.filter((k) => k !== me).slice(0, 32)) {
          try { const s = await getJson(`${urlOf(k)}/slash-release?start=${r.start}`); const t = s.release || s.fallback; if (t && t.table) { bytes = fromHex(t.table); break; } } catch { /* the next */ }
        }
      }
      if (!bytes) return undefined;
      for (const e of decodeSlashPayoutTable(bytes).entries) { const k = toHex(e.playerPubkey); paid.set(k, (paid.get(k) || 0n) + e.lossMsat); }
    }
    return paid;
  }

  /** The bonds by node, at the tip: a carrier carries no more than its own. */
  const bondsOf = (entries) => { const m = new Map(); for (const e of entries) m.set(toHex(e.pubkey), (m.get(toHex(e.pubkey)) || 0n) + BigInt(e.bondSats)); return m; };

  /**
   * THE SPEND AND ITS TABLE, as this node reads it. `carriersOf(fid)` -> [{ key, script, bondSats }] in carrying order for the players' federation; the reserves' parts each go to the first
   * of those carriers, in that order, with a peg-in of that federation. Answers slashHoldSpend's answer, or { ok: false, why, wait } where this node cannot say yet.
   */
  async function build({ e, info, hold, panels, path, verdict, carrierKeys }) {
    const { contract, roundId } = info.read;
    const owed = await lossesFor({ contract, rid: roundId, held: verdict.held });
    if (!owed.ok) return { ok: false, why: `the losses cannot be read yet: ${owed.why}`, wait: true };
    const paid = await paidBefore(info);
    if (!paid) return { ok: false, why: 'an earlier slash of that round has no table this node can read yet', wait: true };
    const playersFed = toHex(contract.federationId);
    const view = (await federations()).filter((f) => f && f.status === 'OPEN' && f.reserveKey);
    const carriers = [], reserveScripts = new Map();
    for (const c of carrierKeys) {
      const peg = await pegInOf(c.key, info.start, playersFed, 'players');
      if (peg) carriers.push({ key: c.key, script: peg.script, bondSats: c.bondSats });
      for (const f of view) {
        if (reserveScripts.has(f.federation)) continue;
        const p = await pegInOf(c.key, info.start, f.federation, 'reserves');
        if (p) reserveScripts.set(f.federation, p.script);
      }
    }
    const feds = view.filter((f) => reserveScripts.has(f.federation)).map((f) => ({ ...f, script: reserveScripts.get(f.federation) }));
    const escrow = slashEscrowOutput({ ...(path === 'release' ? { panelA: panels.panelA, panelB: panels.panelB } : {}), censusKey: e.advert.censusKey, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
    const entriesFor = (escrowSats) => {
      const d = slashDistribution({ escrowSats, roundId, contract, losses: owed.losses, paid });
      return [...d.players].filter(([, msat]) => msat > 0n).map(([k, msat]) => ({ entryId: owed.entryIds.get(k) || new Uint8Array(32), playerPubkey: fromHex(k), lossMsat: msat }));
    };
    const outpoint = { txid: fromHex(e.hold.txid), vout: 0, value: BigInt(e.bondSats) };
    const built = slashHoldSpend({ path, hold, outpoint, panels, proofId: info.proofId, slashHeight: info.slashHeight, rate: info.rate, clocks,
      table: { networkId, roundId, bond: { txid: e.txid, vout: e.vout }, filer: info.filer, carriers, federations: feds, retired, escrowScript: escrow.script, entriesFor } });
    return built.ok ? { ...built, carriers, outpoint } : built;
  }

  // ---- THE RELEASE: t of n of both panels ----
  const relDone = new Set();
  async function release({ e, info, hold, panels, verdict, entries }) {
    if (relDone.has(info.start)) return null;
    const bonds = bondsOf(entries);
    const b = await build({ e, info, hold, panels, path: 'release', verdict, carrierKeys: panels.panelA.map((k) => ({ key: toHex(k), bondSats: bonds.get(toHex(k)) || 0n })) });
    if (!b.ok) return b;
    const signature = schnorr.sign(b.digest, secret);
    const row = keepSpend(info.start, 'release', b, signature);
    if (row.table_id !== toHex(b.tableId)) return { ok: false, why: 'the table moved' };
    if (!row.signature || !same(new Uint8Array(row.signature), signature)) db.prepare('UPDATE slash_spends SET signature = ? WHERE start = ? AND path = ?').run(signature, info.start, 'release');
    const members = [...panels.panelA, ...panels.panelB].map(toHex);
    const sigs = new Map([[me, signature]]);
    for (const r of db.prepare('SELECT node, signature FROM slash_spend_sigs WHERE start = ? AND table_id = ?').all(info.start, toHex(b.tableId))) sigs.set(r.node, new Uint8Array(r.signature));
    for (const k of members) {
      if (sigs.has(k)) continue;
      try {
        const s = await getJson(`${urlOf(k)}/slash-release?start=${info.start}`);
        for (const x of [s.release && s.release.own, ...((s.release && s.release.signatures) || [])].filter(Boolean)) {
          if (!members.includes(x.node) || sigs.has(x.node)) continue;
          const sig = fromHex(x.signature);
          if (verifySig(sig, b.digest, fromHex(x.node))) { sigs.set(x.node, sig); db.prepare('INSERT OR IGNORE INTO slash_spend_sigs (start, table_id, node, signature) VALUES (?, ?, ?, ?)').run(info.start, toHex(b.tableId), x.node, sig); }
        }
      } catch { /* that member says nothing yet */ }
    }
    const t = panelThreshold(panels.panelA.length);
    const countIn = (panel) => panel.filter((k) => sigs.has(toHex(k))).length;
    const a = countIn(panels.panelA), z = countIn(panels.panelB);
    if (a < t || z < t) return { ok: false, why: `${a} of panel A and ${z} of panel B have signed these bytes, ${t} of each are needed`, tableId: toHex(b.tableId) };
    const { raw, txid } = signedHoldSpend({ spend: b.spend, witness: releaseWitness({ hold, panelA: panels.panelA, panelB: panels.panelB, signatures: sigs }) });
    let sent;
    try { sent = String(await send(toHex(raw))); } catch (e2) {
      // ANOTHER MEMBER SENT THE SAME TRANSACTION FIRST: the txid does not move with whose signatures it carries
      if (!ALREADY.test(e2.message)) return { ok: false, why: `the release was not taken: ${e2.message}` };
      sent = display(toHex(txid));
    }
    relDone.add(info.start);
    db.prepare('UPDATE slash_spends SET sent = ? WHERE start = ? AND path = ?').run(sent, info.start, 'release');
    return { ok: true, txid: sent, tableId: toHex(b.tableId), signers: { a, b: z, t }, feeSats: b.feeSats, vsize: b.vsize };
  }

  // ---- THE FALLBACK: the census key, with its holders as carriers ----
  async function fallbackBuild({ e, info, hold, verdict, entries }) {
    const keyHex = toHex(e.advert.censusKey);
    const holders = await holdersOf(keyHex, info.height);
    if (!holders.length) return { ok: false, why: `no holders of key ${keyHex.slice(0, 16)} are read here`, wait: true };
    const bonds = bondsOf(entries);
    const excluded = [toHex(e.pubkey), ...(await seatsOf(info.read.contract, info.read.roundId))];
    const playersFed = toHex(info.read.contract.federationId);
    const pegIns = new Map();
    for (const h of holders) { if (excluded.includes(h.key)) continue; const p = await pegInOf(h.key, info.start, playersFed, 'players'); if (p) pegIns.set(h.key, p); }
    const carriers = fallbackCarriers({ holders, bonds, excluded, pegIns, networkId, verify: verifySig });
    return build({ e, info, hold, panels: null, path: 'fallback', verdict, carrierKeys: carriers.map((c) => ({ key: c.key, bondSats: c.bondSats })) });
  }

  const fbDone = new Set(), fbSince = new Map();
  async function fallback({ e, info, hold, verdict, entries }) {
    if (fbDone.has(info.start)) return null;
    const keyHex = toHex(e.advert.censusKey);
    const holders = (await holdersOf(keyHex, info.height)).map((h) => h.key);
    if (!fbSince.has(info.start)) fbSince.set(info.start, now());
    // EVERY HOLDER BUILDS AND KEEPS IT, so a holder the table names as a carrier knows to carry whoever files it; only the filing waits its turn
    const b = await fallbackBuild({ e, info, hold, verdict, entries });
    if (!b.ok) return b;
    keepSpend(info.start, 'fallback', b, null);
    const rank = fallbackRank(info.proofId, holders, me);
    if (rank < 0 || now() - fbSince.get(info.start) < rank * stepMs) return { ok: false, why: `not this holder's turn to file yet (rank ${rank})`, quiet: true };
    const threshold = thresholdOf(keyHex);
    if (!threshold) return { ok: false, why: `this seat reads no threshold for key ${keyHex.slice(0, 16)}` };
    const request = { kind: 'fallback', start: info.start, proof: toHex(info.bytes), tableId: toHex(b.tableId) };
    const own = heldKey(e.advert.censusKey) ? signer() : null;
    const got = await gatherCensusSignature({ request, digest: b.digest, publicKey: e.advert.censusKey, threshold, urls: holders.filter((k) => k !== me).map(urlOf).filter(Boolean), own, fetchFn });
    if (!got.ok) return got;
    const { raw, txid } = signedHoldSpend({ spend: b.spend, witness: fallbackWitness({ hold, signature: got.signature }) });
    let sent;
    try { sent = String(await send(toHex(raw))); } catch (e2) {
      if (!ALREADY.test(e2.message)) return { ok: false, why: `the fallback was not taken: ${e2.message}` };
      sent = display(toHex(txid));
    }
    fbDone.add(info.start);
    db.prepare('UPDATE slash_spends SET sent = ? WHERE start = ? AND path = ?').run(sent, info.start, 'fallback');
    return { ok: true, txid: sent, tableId: toHex(b.tableId), signers: got.signers, shares: got.shares, feeSats: b.feeSats, vsize: b.vsize };
  }

  /** A HOLDER ASKED TO SIGN A FALLBACK: the hold is one of its census, its clock has run, the proof holds on its own replay, and its own table is the one named. The digest is its own. */
  async function checkFallback(request) {
    const entries = await entriesAtTip();
    if (!entries) return { ok: false, why: 'this seat reads no census at the tip yet' };
    const e = entries.find((x) => x.hold && display(x.hold.txid) === String(request.start));
    if (!e) return { ok: false, why: 'no started bond of this census has that start' };
    const info = await readStart(e);
    if (!info || !info.bytes) return { ok: false, why: 'this seat cannot read that start or its proof' };
    if (toHex(info.bytes) !== String(request.proof)) return { ok: false, why: 'that is not the proof the start names' };
    if ((await tipHeight()) < info.height + clocks.fallbackBlocks - 1) return { ok: false, why: 'that hold\'s fallback has not opened yet' };
    const got = holdOf(e, info);
    if (!got) return { ok: false, why: 'that start pays no hold this seat can rebuild' };
    const verdict = await judge(info.bytes, { startHeight: info.height });
    if (verdict.verdict !== true) return { ok: false, why: verdict.verdict === false ? `the proof does not hold here: ${verdict.why}` : `this seat cannot judge that proof yet: ${verdict.why}` };
    const b = await fallbackBuild({ e, info, hold: got.hold, verdict, entries });
    if (!b.ok) return b;
    if (toHex(b.tableId) !== String(request.tableId)) return { ok: false, why: `this seat's own table is ${toHex(b.tableId).slice(0, 16)}, not ${String(request.tableId).slice(0, 16)}` };
    keepSpend(info.start, 'fallback', b, null);
    return { ok: true, digest: b.digest, publicKey: e.advert.censusKey };
  }

  // ---- WHICH SPEND OF A HOLD CONFIRMED (RULED 2026-11-03, kanban #1085: "a carrier pays on for whichever table confirmed") ----
  /**
   * The release or fallback the chain holds for a start, read once and kept: this node's own when the chain holds it, else one a peer built, taken only when the transaction its
   * table makes (the hold's one input, the OP_RETURN naming H(proof), slash_height and that table's id, then its outputs) has the txid whose outputs the chain holds, confirmed.
   * So the bytes hash to the table the chain carries; nothing is judged again, the panels' threshold or the census key did that. Answers { path, txid, tableId, table, bytes, height } or null.
   */
  const confirmedSeen = new Map();
  async function confirmedOf(start) {
    const kept = db.prepare('SELECT c.*, t.bytes FROM slash_confirmed c JOIN slash_tables t ON t.table_id = c.table_id WHERE c.start = ?').get(start);
    if (kept) { const bytes = new Uint8Array(kept.bytes); return { path: kept.path, txid: kept.txid, tableId: kept.table_id, table: decodeSlashPayoutTable(bytes), bytes, height: kept.height }; }
    const h = db.prepare('SELECT * FROM slash_holds WHERE start = ?').get(start);
    if (!h || !h.hold_script || !h.proof_id || h.slash_height === null || h.slash_height === undefined) return null;
    const tip = await tipHeight();
    const atChain = async (path, bytes) => {
      let table; try { table = decodeSlashPayoutTable(bytes); } catch { return null; }
      const tableId = slashPayoutTableId(table);
      if (toHex(table.proofId) !== h.proof_id) return null;
      const built = holdSlashSpend({ path, hold: { txid: fromHex(start).reverse(), vout: 0, value: BigInt(h.hold_value), script: new Uint8Array(h.hold_script) }, proofId: fromHex(h.proof_id), slashHeight: h.slash_height, table, tableId, clocks });
      if (!built.ok) return null;
      const txid = display(toHex(parseTransaction(serializeSpend({ ...built.tx, witnesses: [[new Uint8Array(64)]] })).txid));
      for (const [i, o] of table.outputs.entries()) {
        const got = await txOut(txid, i + 1).catch(() => null);
        if (got && got.confirmations > 0 && (got.script === undefined || got.script === toHex(o.script)) && (got.sats === undefined || BigInt(got.sats) === o.value)) return { path, txid, tableId: toHex(tableId), table, bytes, height: tip - got.confirmations + 1 };
      }
      return null;
    };
    let found = null;
    for (const path of ['release', 'fallback']) { const s = spendOf(start, path); if (!found && s) found = await atChain(path, new Uint8Array(s.tbl)); }
    // A PEER'S TABLE, ONCE THE HOLD IS GONE AND NONE OF THIS NODE'S OWN IS WHAT SPENT IT: a member whose own reading differed still carries the one that went out
    if (!found && !(await txOut(start, 0).catch(() => null)) && (confirmedSeen.get(start) || 0) < tip) {
      confirmedSeen.set(start, tip);
      for (const k of peers.filter((x) => x !== me).slice(0, 32)) {
        let s; try { s = await getJson(`${urlOf(k)}/slash-release?start=${start}`); } catch { continue; }
        for (const path of ['release', 'fallback']) if (!found && s[path] && s[path].table) found = await atChain(path, fromHex(s[path].table));
        if (found) break;
      }
    }
    if (!found) return null;
    db.prepare('INSERT OR IGNORE INTO slash_tables (table_id, bytes) VALUES (?, ?)').run(found.tableId, found.bytes);
    db.prepare('INSERT OR IGNORE INTO slash_confirmed (start, path, table_id, txid, height) VALUES (?, ?, ?, ?, ?)').run(start, found.path, found.tableId, found.txid, found.height);
    return found;
  }

  // ---- THE CARRIERS PAY ----
  const carrying = new Set();
  /**
   * ONE OUTPUT A CARRIER WAS PAID, PAID ON: claim the peg-in, each player's slice to refund_key(player), the rest less the fee margin to that federation's reserve key, kept as a
   * reserve row of kind `slash`. `name` { start (where its state is kept), path, index } and `startHex` the hold's start, for the reserve row; `slices` this output's.
   */
  async function payOn({ name, startHex, txid, vout, o, peg, slices }) {
    const tag = `${name.start}:${name.path}:${name.index}`;
    const row = db.prepare('SELECT state FROM slash_carried WHERE start = ? AND path = ? AND out_index = ?').get(name.start, name.path, name.index);
    const state = row ? JSON.parse(row.state) : {};
    if (state.paidTxid || carrying.has(tag)) return null;
    // THE PEG-IN RECEIVED THE SLICE: the chain holds that output, to this carrier's script, for exactly the table's value
    if (!state.claimedMsat) {
      const got = await txOut(txid, vout).catch(() => null);
      if (!got || (got.script !== undefined && got.script !== toHex(o.script)) || (got.sats !== undefined && BigInt(got.sats) !== o.value)) return null;
    }
    carrying.add(tag);
    try {
      const port = await portFor(peg.federation);
      if (!port) return { start: startHex, why: `no client of ${peg.federation.slice(0, 16)}` };
      if (!state.claimedMsat) {
        const c = await port.peginClaim(peg.address);
        state.claimedMsat = String(c.claimedMsat);
        db.prepare('INSERT OR REPLACE INTO slash_carried (start, path, out_index, state) VALUES (?, ?, ?, ?)').run(name.start, name.path, name.index, JSON.stringify(state));
      }
      const claimed = BigInt(state.claimedMsat) - CARRIER_FEE_MARGIN_MSAT;
      const players = o.pays === 'player_carrier' ? slices : [];
      const playersMsat = players.reduce((a, x) => a + x.msat, 0n);
      const pays = players.map((x) => ({ key: toHex(refundKeyOf(x.playerPubkey)), msat: claimed >= playersMsat ? x.msat : (x.msat * (claimed > 0n ? claimed : 0n)) / playersMsat, entryId: toHex(x.entryId) }));
      const rest = claimed - pays.reduce((a, x) => a + x.msat, 0n);
      const reserveKey = reserveKeyOf(peg.federation);
      const list = [...pays, ...(reserveKey && rest > 0n ? [{ key: toHex(reserveKey), msat: rest, reserves: true }] : [])].filter((x) => x.msat > 0n);
      if (!list.length) { state.paidTxid = 'nothing'; } else {
        const paid = await port.payouts(list.map((x) => ({ key: x.key, msat: x.msat })));
        const outIdxOf = (k) => (paid.payouts.find((y) => y.refundPk === k) || {}).outIdx ?? null;
        state.paidTxid = paid.txid;
        state.players = pays.map((x) => ({ key: x.key, entry: x.entryId, msat: String(x.msat), outIdx: outIdxOf(x.key) }));
        const r = list.find((x) => x.reserves);
        if (r) {
          state.reserves = { key: r.key, msat: String(r.msat), outIdx: outIdxOf(r.key) };
          const roundId = (db.prepare('SELECT round_id FROM slash_holds WHERE start = ?').get(startHex) || {}).round_id;
          if (state.reserves.outIdx !== null && roundId) keepReserveRow({ outpoint: { txid: fromHex(paid.txid), outIdx: BigInt(state.reserves.outIdx) }, entryId: fromHex(startHex), roundId: fromHex(roundId),
            federationId: peg.federation, recipientPk: reserveKey, amountMsat: r.msat, contractId: (paid.payouts.find((y) => y.refundPk === r.key) || {}).contractId || 'slash', senderOnContract: false, image: null, item: 'slash' });
        }
      }
      db.prepare('INSERT OR REPLACE INTO slash_carried (start, path, out_index, state) VALUES (?, ?, ?, ?)').run(name.start, name.path, name.index, JSON.stringify(state));
      log(`[slash] carried ${name.path} ${startHex.slice(0, 16)} output ${name.index}: claimed ${state.claimedMsat} msat, ${(state.players || []).length} player(s) paid${state.reserves ? `, ${state.reserves.msat} msat to the reserves` : ''}: ${state.paidTxid}`);
      return { start: startHex, path: name.path, index: name.index, ...state };
    } catch (x) { log(`[slash] carrying ${startHex.slice(0, 16)} output ${name.index} waits: ${x.message}`); return { start: startHex, index: name.index, why: x.message }; }
    finally { carrying.delete(tag); }
  }

  /**
   * THE CARRIERS PAY ON, for whichever table confirmed (RULED 2026-11-03, kanban #1085): once a release or fallback is mined its table is a fact, and the money on a carrier's peg-in
   * belongs to the players and the reserves that table names. A carrier whose own table differed carries the confirmed one after checking it hashes to what the chain carries
   * (confirmedOf), that it names this carrier's peg-in, and that the peg-in received exactly that (payOn). It does not judge the table again. Then each escrow spend on the chain.
   */
  async function carry() {
    const done = [];
    for (const h of db.prepare('SELECT DISTINCT start FROM slash_pegins WHERE start NOT LIKE \'escrow:%\'').all()) {
      const c = await confirmedOf(h.start).catch(() => null);
      if (!c) continue;
      const mine = db.prepare('SELECT federation, address, script FROM slash_pegins WHERE start = ?').all(h.start);
      const slices = carrierSlices(c.table);
      for (const [i, o] of c.table.outputs.entries()) {
        if (o.pays !== 'player_carrier' && o.pays !== 'reserves') continue;
        const peg = mine.find((p) => same(new Uint8Array(p.script), o.script));
        if (!peg) continue;
        const r = await payOn({ name: { start: h.start, path: c.path, index: i }, startHex: h.start, txid: c.txid, vout: i + 1, o, peg, slices: (slices.find((x) => x.index === i) || { slices: [] }).slices });
        if (r) done.push(r);
      }
    }
    done.push(...await escrow.carry());
    return done;
  }

  // ---- ONE PASS ----
  let passing = false;
  let peers = [];                                 // the census' node keys at the last pass: whom an earlier table is asked of
  // WHAT A SLASH LEFT IN ESCROW (RULED 2026-11-03, kanban #1085): slash-escrow-run.js, on this run's reads
  const escrow = createSlashEscrow({ secret, me, clocks, db, tweakPoint, tipHeight, entriesAtTip, txOut, fetchProof, judge, panelsOf, seatsOf, holdersOf, heldKey, thresholdOf, signer, urlOf,
    fetchFn, send, portFor, scriptOf, federationsAt, retired, now, stepMs, log, confirmedOf, peers: () => peers, fallbackRank, getJson, payOn });
  async function pass() {
    if (passing) return [];
    passing = true;
    const done = [];
    try {
      const tip = await tipHeight();
      const entries = await entriesAtTip();
      if (!entries) return done;
      peers = [...new Set(entries.map((e) => toHex(e.pubkey)))];
      const started = entries.filter((e) => e.hold && e.advert && e.advert.bondScriptTemplateVersion === BOND_TEMPLATE_V3);
      const read = [];
      for (const e of started) { const info = await readStart(e).catch((x) => { log(`[slash] start ${display(e.hold.txid).slice(0, 16)} not read: ${x.message}`); return null; }); if (info && info.bytes) read.push({ e, info }); }
      read.sort((x, y) => x.info.height - y.info.height || (toHex(x.info.proofId) < toHex(y.info.proofId) ? -1 : 1));
      for (const { e, info } of read) {
        const got = holdOf(e, info);
        if (!got) continue;
        const onPanel = !!got.panels && [...got.panels.panelA, ...got.panels.panelB].some((k) => toHex(k) === me);
        const holder = !!heldKey(e.advert.censusKey);
        const releaseOpen = got.panels && tip >= info.height + clocks.holdBlocks - 1;
        const fallbackOpen = tip >= info.height + clocks.fallbackBlocks - 1;
        if (!(onPanel && releaseOpen) && !(holder && fallbackOpen)) continue;
        const verdict = await judge(info.bytes, { startHeight: info.height });
        if (verdict.verdict !== true) { done.push({ start: info.start, why: verdict.why }); continue; }
        if (onPanel && releaseOpen) {
          const r = await release({ e, info, hold: got.hold, panels: got.panels, verdict, entries }).catch((x) => ({ ok: false, why: x.message }));
          if (r) { done.push({ start: info.start, path: 'release', ...r }); log(r.ok ? `[slash] release of ${info.start.slice(0, 16)} sent: ${r.txid}, table ${r.tableId.slice(0, 16)}` : `[slash] release of ${info.start.slice(0, 16)} waits: ${r.why}`); }
        }
        if (holder && fallbackOpen) {
          const r = await fallback({ e, info, hold: got.hold, verdict, entries }).catch((x) => ({ ok: false, why: x.message }));
          if (r) { done.push({ start: info.start, path: 'fallback', ...r }); if (!r.quiet) log(r.ok ? `[slash] fallback of ${info.start.slice(0, 16)} sent: ${r.txid}, table ${r.tableId.slice(0, 16)}` : `[slash] fallback of ${info.start.slice(0, 16)} waits: ${r.why}`); }
        }
      }
      done.push(...await escrow.pass().catch((x) => { log(`[slash] the escrow pass did not run: ${x.message}`); return []; }));
    } finally { passing = false; }
    return done;
  }

  /** GET /slash-release?start=: what this node built for that start, its own signature on the release and those it holds, and what it carried. */
  function served(start) {
    const out = { node: me, start };
    for (const path of ['release', 'fallback']) {
      const s = spendOf(start, path);
      if (!s) continue;
      out[path] = { tableId: s.table_id, table: toHex(new Uint8Array(s.tbl)), txid: s.txid, feeSats: s.fee, sent: s.sent,
        own: s.signature ? { node: me, signature: toHex(new Uint8Array(s.signature)) } : null,
        signatures: db.prepare('SELECT node, signature FROM slash_spend_sigs WHERE start = ? AND table_id = ?').all(start, s.table_id).map((r) => ({ node: r.node, signature: toHex(new Uint8Array(r.signature)) })) };
    }
    out.carried = db.prepare('SELECT path, out_index, state FROM slash_carried WHERE start = ?').all(start).map((r) => ({ path: r.path, index: r.out_index, ...JSON.parse(r.state) }));
    const esc = escrow.served(start);
    if (esc) out.escrow = esc;
    return out;
  }
  const tableById = (id) => { const r = db.prepare('SELECT bytes FROM slash_tables WHERE table_id = ?').get(String(id).toLowerCase()); return r ? new Uint8Array(r.bytes) : null; };
  const list = () => db.prepare('SELECT start, height, round_id, proof_id, node, bond FROM slash_holds ORDER BY height DESC LIMIT 64').all().map((r) => ({ ...r, ...served(r.start) }));

  /** A census key ask that is not a start: a fallback of a hold, or an escrow spend (kind `escrow`). */
  const checkOther = (request) => (request && request.kind === 'escrow' ? escrow.checkEscrow(request) : checkFallback(request));
  return { pass, carry, checkFallback, checkEscrow: escrow.checkEscrow, checkOther, served, tableById, list, ownPegIn, confirmedOf,
    takeCarrierPegIn: escrow.takeCarrierPegIn, servedCarriers: escrow.servedCarriers };
}
