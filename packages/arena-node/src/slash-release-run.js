// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STARTED BOND IS RELEASED, OR TAKEN BY THE FALLBACK, AND ITS CARRIERS PAY (spec 5A.3B steps 4 and 5, kanban #972, decision #1083).
//
// Every seat reads the started bonds of its own census at the tip. For each one it reads the start off its chain (the proof it names, its slash height, its fee input), the proof
// by its hash, and the round in the proof. Then:
//
//   A PANEL MEMBER of that round, slash_hold_blocks after the start, replays the proof itself and builds a proposal: the payout table from the checked peg-ins it holds and
//   what it reads itself. It signs its own and every other member's proposal whose named peg-ins check and whose bytes it rebuilds equal (RULED 2026-11-04, kanban #1130);
//   it reads the others' signatures from their doors, and the first proposal with t of each panel goes out.
//   A HOLDER OF THE CENSUS KEY the bond names, slash_fallback_blocks after the start with the hold still there, builds the fallback with the key's holders as carriers. One holder
//   at a time (a turn by a hash of the proof) asks the others in two rounds of FROST; each one answers only for its own bytes.
//   A CARRIER, once the release or the fallback is out, claims the peg-in the table paid it, pays each player's loss it carries to that player's key, and the rest of what it claimed
//   to the federation's reserve key, kept as a reserve row of kind `slash`.
//
// What a signer reads, it reads from the chain, the proof and the seats a round names: its own census for the panels, the holders and the bonds; the round's seats for how the
// round settled (GET /audit-run, every signature checked); the carriers for their peg-ins, each signed by its node key over the start, federation and use, and handed on from
// seat to seat; its own federation records for the reserves' load, with a reserve key not read yet waited for until the start's confirmation + slash_return_blocks / 2, and
// from then on the whole reserves' part in the escrow (#1130). Two signers that read the same build the same bytes; where they do not, the fallback is the way out.
import { schnorr } from '@noble/curves/secp256k1.js';
import { BOND_TEMPLATE_V3, holdOutputKey, panelThreshold } from '../../arena-protocol/src/bond-script.js';
import { arbitrationCommitmentIn, holdSlashSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { CARRIER_PEG_IN_USES, carrierPegInId, fallbackCarriers } from '../../arena-protocol/src/census-key.js';
import { decodeSlashPayoutTable, fraudProofHash, slashDistribution, slashPayoutTableId, OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from '../../arena-protocol/src/slash.js';
const NAMED_OFFENCES = [OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY];
import { carrierSlices, fallbackWitness, releaseWitness, signedHoldSpend, slashEscrowOutput, slashHoldSpend, startFeeRate } from '../../arena-protocol/src/slash-release.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { carrierMarginOf, carrierPayoutFeeOf } from '../../arena-protocol/src/slash-presig.js';
import { serializeSpend } from '../../arena-protocol/src/bond-spend.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { gatherCensusSignature } from './census-sign.js';
import { createSlashEscrow } from './slash-escrow-run.js';
import { createLiquidationEscrow } from './liquidation-escrow-run.js';
import { roundlessTableInputs } from '../../arena-protocol/src/liquidation-escrow.js';
import { keyedPay, payoutOf, PAYOUT } from './keyed-payout.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const display = (internalHex) => toHex(fromHex(internalHex).reverse());
const same = (a, b) => toHex(a) === toHex(b);
/** A send refused because the very transaction is already there: another signer sent it first. */
const ALREADY = /already in (the )?(mempool|block ?chain)|txn-already-known|txn-already-in-mempool|already known/i;

/**
 * A START'S RELEASE AT ONE PANEL MEMBER (kanban #1192, the state machine audit of 2026-11-06): none -> proposed (its own proposal kept and signed) -> sending (the signed
 * transaction and its txid on disk, before it is sent) -> sent (taken, or the chain already holds it; terminal) | proposed (refused). Before, "sent" was a Set in memory: a
 * restarted seat rebuilt, re-gathered and re-sent every pass until the release was in a block. A start found SENDING after a stop is sent again, the same bytes.
 */
export const RELEASE = Object.freeze({ NONE: 'none', PROPOSED: 'proposed', SENDING: 'sending', SENT: 'sent' });
const RELEASE_MOVES = Object.freeze({ [RELEASE.NONE]: [RELEASE.PROPOSED], [RELEASE.PROPOSED]: [RELEASE.PROPOSED, RELEASE.SENDING], [RELEASE.SENDING]: [RELEASE.SENT, RELEASE.PROPOSED], [RELEASE.SENT]: [] });
/**
 * WHAT ONE MEMBER'S DOOR CAN MAKE THIS SEAT BUILD (kanban #1192): a proposal costs a whole build (losses, federations, the table), and a panel-A member can sign any number of
 * peg-ins of its own, so any number of proposals that check. Per pass, a member's proposals are rebuilt at most RELEASE_BUILDS_PER_MEMBER at a time (its own first), a peg-in set
 * built once whatever table it claims; per start, this seat keeps and signs at most RELEASE_PROPOSALS_PER_MEMBER handed on by each member. Its own proposal is never capped.
 */
export const RELEASE_BUILDS_PER_MEMBER = 2;
export const RELEASE_PROPOSALS_PER_MEMBER = 4;

/** Which holder files a fallback first: a hash of the proof and the key, as a start's filer (slash-start-run.js filerRank), under its own tag. */
export const fallbackRank = (proofId, keys, me) => [...keys].sort((a, b) => (toHex(taggedHash('ARENA/v1/SlashFallbackFiler', Uint8Array.from([...proofId, ...fromHex(a)])))
  < toHex(taggedHash('ARENA/v1/SlashFallbackFiler', Uint8Array.from([...proofId, ...fromHex(b)]))) ? -1 : 1)).indexOf(me);

/**
 * `key`, `secret` this node's; `networkId`, `clocks` { holdBlocks, returnBlocks, fallbackBlocks }; `carrierMarginMsat` the network's carrier payout margin, which every table
 * this node builds names (kanban #1086, genesis.js CARRIER_PAYOUT_MARGIN_MSAT); `db`; `tweakPoint` the curve.
 * `tipHeight()`; `entriesAtTip()` the census at the tip, started bonds with their `hold`; `rawTx(txid display hex, nearHeight)` a transaction's bytes or null; `unspent(txid display, vout)`;
 * `txOut(txid display, vout)` -> { sats, script hex, confirmations } of a confirmed unspent output, or null (gettxout without the mempool); by default read from `unspent`.
 * `federationsAt(height)` the reserves' view on the federation records in force at that height, as `federations()` answers it (an escrow spend's named height, #1085).
 * `fetchProof(id)` the bytes under a proof's hash or null; `judge(bytes, { startHeight })` -> { verdict, why, held } with `judge.read`; `panelsOf(contract, rid)`; `seatsOf(contract, rid)`
 * the round's drawn keys (hex); `handles(held)` whether a loss rule reads that judged offence at all (false: the start is dropped once, kanban #1044); `lossesFor({ contract, rid, held, tip, capAt })` -> { ok, losses: Map key hex -> msat, entryIds: Map key hex -> bytes } or { ok: false, why }.
 * `federations()` the reserves' view, [{ federation, status, reserveKey, reserveSats, exposureCapSats, reservePending }] (`reservePending`: its guardian seats stand, so it has a key, and this seat has not read it yet); `retired` hex; `portFor(fid hex)` a stake-lock port or null; `scriptOf(address)`;
 * `reserveKeyOf(fid hex)` 33 bytes or null, or a promise of them (the seat's is async); `keepReserveRow(row)`.
 * `urlOf(key hex)`; `heldKey(publicKey)` CensusKeyStore's; `thresholdOf(key hex)`; `holdersOf(key hex, height)` -> [{ key, shares }]; `signer()` this node's census signer or null.
 * `send(hex)`. `claimsOf(fid hex)` the one claims ledger of a liquidating federation, for a slash with no round (liquidation-escrow-run.js).
 */
export function createSlashRelease({ key, secret, networkId, clocks, db, tweakPoint, tipHeight, entriesAtTip, rawTx, unspent, fetchProof, judge, panelsOf, seatsOf = () => [], lossesFor, handles = () => true,
  federations = async () => [], retired = [], portFor = async () => null, scriptOf, reserveKeyOf = () => null, keepReserveRow = () => {}, urlOf = () => null, heldKey = () => null,
  thresholdOf = () => null, holdersOf = async () => [], signer = () => null, send, claimsOf = async () => null, stepMs = 600000, fetchFn = fetch, now = Date.now, log = () => {},
  txOut = async (txid, vout) => ((await unspent(txid, vout)) ? { confirmations: 1 } : null), federationsAt = async () => federations(), carrierMarginMsat = carrierMarginOf(networkId),
  carrierPayoutFeeMsat = carrierPayoutFeeOf(networkId) }) {
  const me = toHex(key);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_holds (start TEXT PRIMARY KEY, height INTEGER NOT NULL, round_id TEXT, proof_id TEXT, node TEXT NOT NULL, bond TEXT NOT NULL, seen_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_spends (start TEXT NOT NULL, path TEXT NOT NULL, table_id TEXT NOT NULL, tbl BLOB NOT NULL, txid TEXT NOT NULL, fee INTEGER NOT NULL, signature BLOB,
      sent TEXT, made_ms INTEGER NOT NULL, PRIMARY KEY (start, path));
    CREATE TABLE IF NOT EXISTS slash_spend_sigs (start TEXT NOT NULL, table_id TEXT NOT NULL, node TEXT NOT NULL, signature BLOB NOT NULL, PRIMARY KEY (start, table_id, node));
    CREATE TABLE IF NOT EXISTS slash_pegins (start TEXT NOT NULL, federation TEXT NOT NULL, use TEXT NOT NULL, address TEXT NOT NULL, script BLOB NOT NULL, PRIMARY KEY (start, federation, use));
    CREATE TABLE IF NOT EXISTS slash_carried (start TEXT NOT NULL, path TEXT NOT NULL, out_index INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (start, path, out_index));
    CREATE TABLE IF NOT EXISTS slash_margin_owed (federation TEXT PRIMARY KEY, msat TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_tables (table_id TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_confirmed (start TEXT PRIMARY KEY, path TEXT NOT NULL, table_id TEXT NOT NULL, txid TEXT NOT NULL, height INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slash_pegins_held (start TEXT NOT NULL, node TEXT NOT NULL, federation TEXT NOT NULL, use TEXT NOT NULL, script BLOB NOT NULL, signature BLOB NOT NULL,
      PRIMARY KEY (start, node, federation, use));
    CREATE TABLE IF NOT EXISTS slash_release_props (start TEXT NOT NULL, table_id TEXT NOT NULL, tbl BLOB NOT NULL, pegins TEXT NOT NULL, signature BLOB NOT NULL, made_ms INTEGER NOT NULL,
      PRIMARY KEY (start, table_id))`);
  // THE ESCROW READS THE START WITHOUT THE CENSUS: once the hold is spent the bond is gone from it, so its census key and fee rate are kept with the start (#1085)
  for (const col of ['census_key TEXT', 'rate INTEGER', 'hold_value INTEGER', 'hold_script BLOB', 'slash_height INTEGER']) { try { db.exec(`ALTER TABLE slash_holds ADD COLUMN ${col}`); } catch { /* there already */ } }
  // WHO HANDED A PROPOSAL ON, FOR ITS QUOTA; THE RELEASE'S OWN STATE (kanban #1192)
  try { db.exec('ALTER TABLE slash_release_props ADD COLUMN via TEXT'); } catch { /* there already */ }
  db.exec('CREATE TABLE IF NOT EXISTS slash_release_sent (start TEXT PRIMARY KEY, state TEXT NOT NULL, table_id TEXT, raw TEXT, txid TEXT, at_ms INTEGER NOT NULL)');
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
        // A ROUND'S PROOF, OR ONE WITH NO ROUND: a theft's or an abandonment's (kanban #1093 part 2, ruling #1111)
        if (read.ok && (read.roundId || read.kind === 'theft' || read.kind === 'abandoned')) Object.assign(info, { bytes, read });
      }
    }
    starts.set(start, info);
    db.prepare('INSERT OR IGNORE INTO slash_holds (start, height, round_id, proof_id, node, bond, seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(start, e.hold.height, info.read && info.read.roundId ? toHex(info.read.roundId) : null, info.proofId ? toHex(info.proofId) : null, toHex(e.pubkey), `${toHex(e.txid)}:${e.vout}`, now());
    if (info.read && info.read.roundId && !db.prepare('SELECT round_id FROM slash_holds WHERE start = ?').get(start).round_id) db.prepare('UPDATE slash_holds SET round_id = ?, proof_id = ? WHERE start = ?').run(toHex(info.read.roundId), toHex(info.proofId), start);
    db.prepare('UPDATE slash_holds SET census_key = ?, rate = ?, hold_value = ?, hold_script = ?, slash_height = ? WHERE start = ?')
      .run(toHex(e.advert.censusKey), Number(info.rate), Number(tx.outputs[0].value), tx.outputs[0].script, info.slashHeight, start);
    return info;
  }

  /** The hold the start paid: the round's, with its panels, or the bond's own, with none. Null for a hold this seat cannot rebuild. */
  function holdOf(e, info) {
    const base = { ownerKey: e.advert.ownerPubkey, censusKey: e.advert.censusKey, bondMaturity: e.advert.bondMaturityHeight, ...clocks };
    // A SLASH WITH NO ROUND starts on the bonding presig, whose hold has no release leaf (#1053): only the bare hold
    const panels = info.read.roundId ? panelsOf(info.read.contract, info.read.roundId) : { ok: false };
    if (panels.ok && panels.panelA.length) {
      const h = holdOutputKey({ ...base, panelA: panels.panelA, panelB: panels.panelB }, { tweakPoint });
      if (h.ok && same(h.script, info.holdScript)) return { hold: h, panels };
    }
    const bare = holdOutputKey({ ...base, panelA: [], panelB: [] }, { tweakPoint });
    return bare.ok && same(bare.script, info.holdScript) ? { hold: bare, panels: null } : null;
  }

  // ---- WHAT A PEER SAYS AT ITS DOOR ----
  const getJson = async (url) => { const r = await fetchFn(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`); return r.json(); };

  /** The hold output a start made, by the start's display txid: what a carrier's peg-in names (#1130). */
  const startOutpoint = (start) => ({ txid: fromHex(start).reverse(), vout: 0 });
  /**
   * A SIGNED PEG-IN, CHECKED (RULED 2026-11-04, kanban #1130): { node, federation, use, script, signature } hex, signed by `node` over carrier_peg_in for this start, that
   * federation and that use, `node` one of `carriers` (hex) where given. Answers { node, federation, use, script, signature } (bytes) or null.
   */
  function checkPegIn(rec, start, carriers = null) {
    try {
      const node = String(rec.node).toLowerCase(), federation = String(rec.federation).toLowerCase(), use = String(rec.use);
      if (!CARRIER_PEG_IN_USES.includes(use) || fromHex(federation).length !== 32 || (carriers && !carriers.includes(node))) return null;
      const script = fromHex(String(rec.script)), signature = fromHex(String(rec.signature));
      if (!script.length || script.length > 80) return null;
      return verifySig(signature, carrierPegInId({ networkId, start: startOutpoint(start), federationId: fromHex(federation), use, script }), fromHex(node)) ? { node, federation, use, script, signature } : null;
    } catch { return null; }
  }
  const pegName = (node, fid, use) => `${node}:${String(fid).toLowerCase()}:${use}`;
  const pegRecord = (p) => ({ node: p.node, federation: p.federation, use: p.use, script: toHex(new Uint8Array(p.script)), signature: toHex(new Uint8Array(p.signature)) });
  /** EVERY CHECKED PEG-IN THIS SEAT HOLDS FOR A START (#1130): what it read itself and what other seats handed on, each checked. Kept, and served at GET /slash-release. */
  const heldPegIns = (start) => db.prepare('SELECT node, federation, use, script, signature FROM slash_pegins_held WHERE start = ? ORDER BY node, federation, use').all(start).map(pegRecord);
  const holdPegIn = (start, rec, carriers) => {
    const p = checkPegIn(rec, start, carriers);
    if (p) db.prepare('INSERT OR IGNORE INTO slash_pegins_held (start, node, federation, use, script, signature) VALUES (?, ?, ?, ?, ?, ?)').run(start, p.node, p.federation, p.use, p.script, p.signature);
    return p;
  };
  /** The peg-ins a list names, as build() takes them: Map node:federation:use -> script. A list with one that does not check answers null. */
  function pegsOf(list, start, carriers) {
    const out = new Map();
    for (const rec of list) { const p = checkPegIn(rec, start, carriers); if (!p) return null; out.set(pegName(p.node, p.federation, p.use), p.script); }
    return out;
  }

  /** A carrier's peg-in for this start, federation and use (the players' part or the reserves'), asked of it, its node key's signature checked: the record (hex) or null. */
  async function pegInOf(keyHex, start, fid, use) {
    try {
      const said = keyHex === me ? await ownPegIn(start, fid, use) : await getJson(`${urlOf(keyHex)}/slash-pegin?start=${start}&federation=${fid}&use=${use}`);
      const rec = { node: said.node, federation: fid, use, script: said.script, signature: said.signature };
      return said.node === keyHex && checkPegIn(rec, start) ? rec : null;
    } catch { return null; }
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
    return { node: me, federation: fid, use, address: row.address, script: toHex(script),
      signature: toHex(schnorr.sign(carrierPegInId({ networkId, start: startOutpoint(start), federationId: fromHex(fid), use, script }), secret)) };
  }

  // ---- THE TABLE'S INPUTS ----
  /** What earlier slashes of the same round pay its players: their tables' entries, in chain order then proof id, for every one not returned. Undefined while one cannot be read. */
  // A NAMED CLAIM'S BONDS PAY IN ASCENDING NODE KEY (RULED 2026-11-06, kanban #1146 B): the proof names five, all started at one height, and the first bond by node
  // key pays each loss, the next only what is still owed. Every other offence keeps proof id order within a height.
  async function paidBefore(info, byNode = false) {
    const rid = toHex(info.read.roundId), mine = toHex(info.proofId);
    const me = String(info.read.nodePubkey ? toHex(info.read.nodePubkey) : '').toLowerCase();
    const earlier = byNode && me
      ? db.prepare('SELECT start, height, proof_id FROM slash_holds WHERE round_id = ? AND (height < ? OR (height = ? AND (lower(node) < ? OR (lower(node) = ? AND proof_id < ?))))').all(rid, info.height, info.height, me, me, mine)
      : db.prepare('SELECT start, height, proof_id FROM slash_holds WHERE round_id = ? AND (height < ? OR (height = ? AND proof_id < ?))').all(rid, info.height, info.height, mine);
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

  /** THE CAP ON A WAIT FOR A RESERVE KEY (RULED 2026-11-04, kanban #1130): the start's confirmation plus slash_return_blocks / 2 (72 mainnet, 18 testnet4, 6 regtest). */
  const reserveCapOf = (info) => info.height + Math.floor(clocks.returnBlocks / 2);

  /**
   * THE SPEND AND ITS TABLE, from the peg-ins `pegs` names (Map node:federation:use -> script, pegsOf) and what this node reads itself. `carrierKeys` [{ key, bondSats }] in carrying
   * order: the players' part to those with a players' peg-in of the round's federation, in that order; each reserves' part to the first of them with a reserves' peg-in of that
   * federation. Answers slashHoldSpend's answer, or { ok: false, why, wait } where this node cannot say yet.
   */
  async function build({ e, info, hold, panels, path, verdict, carrierKeys, pegs }) {
    const { contract, roundId } = info.read;
    // THE TABLE WAITS FOR THE ROUND (RULED 2026-11-06, kanban #1146 B): a named claim's loss is read once the round's remaining locks are settled or expired, and from
    // #1130's cap on against what the federation shows then (`capAt`, `tip`: the loss reader's to apply)
    const owed = await lossesFor({ contract, rid: roundId, held: verdict.held, tip: await tipHeight(), capAt: reserveCapOf(info) });
    if (!owed.ok) return { ok: false, why: `the losses cannot be read yet: ${owed.why}`, wait: true };
    const paid = await paidBefore(info, NAMED_OFFENCES.includes(verdict.held && verdict.held.offence));
    if (!paid) return { ok: false, why: 'an earlier slash of that round has no table this node can read yet', wait: true };
    const playersFed = toHex(contract.federationId);
    const open = (await federations()).filter((f) => f && f.status === 'OPEN');
    // A RESERVE KEY THIS SEAT HAS NOT READ YET IS NOT "NO RESERVE KEY" (kanban #1129, measured 11-04 on the slash-release regtest): a federation whose guardian seats
    // stand (`reservePending`) has a key its seats name; a signer that has not read it yet would build its table with no reserves' row for it, and sign bytes no
    // signer that read the key builds. It waits, by name; a federation with no guardian seats has no key and takes no part (§27A.9.2).
    // THE WAIT HAS A CAP (RULED 2026-11-04, kanban #1130): from the start's confirmation + slash_return_blocks / 2 on, every signer puts the WHOLE reserves' part in the escrow,
    // whatever keys it has read, so the bytes stay equal; the escrow's next spend places it by load (#1085). Players' outputs and the filer do not change.
    const capAt = reserveCapOf(info);
    let view = [];
    if ((await tipHeight()) < capAt) {
      const gone = new Set(retired.map((x) => String(x).toLowerCase()));
      const unread = open.filter((f) => !f.reserveKey && f.reservePending && !gone.has(String(f.federation).toLowerCase()) && BigInt(f.exposureCapSats || 0) > 0n);
      if (unread.length) return { ok: false, why: `the reserve key of federation ${unread.map((f) => String(f.federation).slice(0, 16)).join(', ')} is not read here yet: no table is built without its reserves' row before height ${capAt}`, wait: true };
      view = open.filter((f) => f.reserveKey);
    }
    const carriers = [], reserveScripts = new Map();
    for (const c of carrierKeys) {
      const peg = pegs.get(pegName(c.key, playersFed, 'players'));
      if (peg) carriers.push({ key: c.key, script: peg, bondSats: c.bondSats });
      for (const f of view) {
        if (reserveScripts.has(f.federation)) continue;
        const p = pegs.get(pegName(c.key, f.federation, 'reserves'));
        if (p) reserveScripts.set(f.federation, p);
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
      table: { networkId, roundId, bond: { txid: e.txid, vout: e.vout }, filer: info.filer, carriers, federations: feds, retired, escrowScript: escrow.script, entriesFor, marginMsat: carrierMarginMsat } });
    return built.ok ? { ...built, carriers, outpoint } : built;
  }

  // ---- THE RELEASE: t of n of both panels, over a proposal that names its carriers (RULED 2026-11-04, kanban #1130) ----
  /**
   * The proposals a member serves for a start: its own (`release`) and every other it signed (`release.proposals`), each { tableId, table, pegins, signatures }.
   */
  const proposalsServed = (s) => {
    const r = s && s.release;
    if (!r) return [];
    const own = r.table && Array.isArray(r.pegins) ? [{ tableId: r.tableId, table: r.table, pegins: r.pegins, signatures: [r.own, ...(r.signatures || [])].filter(Boolean) }] : [];
    return [...own, ...(Array.isArray(r.proposals) ? r.proposals : [])].filter((p) => p && typeof p.tableId === 'string' && typeof p.table === 'string' && Array.isArray(p.pegins));
  };
  const keepProposal = (start, b, pegins, signature, via = me) => {
    db.prepare('INSERT OR IGNORE INTO slash_tables (table_id, bytes) VALUES (?, ?)').run(toHex(b.tableId), b.bytes);
    db.prepare('INSERT OR IGNORE INTO slash_release_props (start, table_id, tbl, pegins, signature, made_ms, via) VALUES (?, ?, ?, ?, ?, ?, ?)').run(start, toHex(b.tableId), b.bytes, JSON.stringify(pegins), signature, now(), via);
  };
  /** The proposals of a start kept here that `via` handed this seat (kanban #1192): each member has its own quota, so one member's many cannot crowd out another's. */
  const keptVia = (start, via) => Number(db.prepare('SELECT COUNT(*) AS n FROM slash_release_props WHERE start = ? AND via = ?').get(start, via).n);
  // A START'S RELEASE AS THIS SEAT SENDS IT (kanban #1192): one row per start in slash_release_sent, moved by relStep only (RELEASE, above)
  const relRow = (start) => db.prepare('SELECT * FROM slash_release_sent WHERE start = ?').get(start) || null;
  const relStateOf = (start) => {
    const r = relRow(start);
    if (r) return r.state;
    // A RELEASE SENT BY A SEAT BEFORE THIS ROW EXISTED: its slash_spends row says so
    const s = spendOf(start, 'release');
    return s && s.sent ? RELEASE.SENT : RELEASE.NONE;
  };
  /** THE ONE TRANSITION: compare and set. False, nothing written, unless the start is in `from` now and RELEASE_MOVES has the move. */
  function relStep(start, from, to, fields = {}) {
    if (!RELEASE_MOVES[from].includes(to) || relStateOf(start) !== from) return false;
    const had = relRow(start);
    const r = had
      ? db.prepare('UPDATE slash_release_sent SET state = ?, table_id = ?, raw = ?, txid = ?, at_ms = ? WHERE start = ? AND state = ?')
        .run(to, fields.tableId ?? had.table_id, fields.raw ?? had.raw, fields.txid ?? had.txid, now(), start, from)
      : db.prepare('INSERT OR IGNORE INTO slash_release_sent (start, state, table_id, raw, txid, at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(start, to, fields.tableId ?? null, fields.raw ?? null, fields.txid ?? null, now());
    return Number(r.changes) === 1;
  }
  /** The release on disk as SENDING, sent: SENT (with slash_spends.sent) when taken or already there, PROPOSED again when refused. */
  async function sendRelease(start) {
    const row = relRow(start);
    let sent;
    try { sent = String(await send(row.raw)); } catch (e2) {
      // ANOTHER MEMBER SENT THE SAME TRANSACTION FIRST: the txid does not move with whose signatures it carries
      if (!ALREADY.test(e2.message)) { relStep(start, RELEASE.SENDING, RELEASE.PROPOSED); return { ok: false, why: `the release was not taken: ${e2.message}`, tableId: row.table_id }; }
      sent = row.txid;
    }
    relStep(start, RELEASE.SENDING, RELEASE.SENT, { txid: sent });
    db.prepare('UPDATE slash_spends SET sent = ? WHERE start = ? AND path = ?').run(sent, start, 'release');
    return { ok: true, txid: sent, tableId: row.table_id };
  }
  /**
   * A PANEL MEMBER'S PASS. The carriers are what a proposal names, not what each signer happened to read: every signer of one proposal builds from the same peg-ins.
   *   1. It reads what the other members serve, and keeps every peg-in they hand on that checks: signed by a panel-A member, for this start, that federation and use.
   *   2. It asks each panel-A member for the peg-ins it does not hold yet, and keeps those that check.
   *   3. Its own proposal names every peg-in it holds; it builds the table from them and signs it.
   *   4. Each other member's proposal: every peg-in it names must check; with exactly those, this seat rebuilds everything else itself (losses, fee, load, order, caps,
   *      reserves, escrow), and signs when the bytes are equal. A member left out only moves its share to the next carrier or the escrow, so that is no reason to refuse.
   *   5. A signer may sign every proposal that checks; they all spend the one hold, so one confirms. The first with t of each panel goes out.
   */
  async function release({ e, info, hold, panels, verdict, entries }) {
    // SENT IS ON DISK: nothing is built or gathered again, after a restart too (kanban #1192)
    if (relStateOf(info.start) === RELEASE.SENT) return null;
    // SENDING BEFORE A STOP: the very bytes, again
    if (relStateOf(info.start) === RELEASE.SENDING) {
      const r = await sendRelease(info.start);
      if (r.ok) return { ...r, resumed: true };
    }
    const bonds = bondsOf(entries);
    const panelA = panels.panelA.map(toHex);
    const carrierKeys = panelA.map((k) => ({ key: k, bondSats: bonds.get(k) || 0n }));
    const members = [...panels.panelA, ...panels.panelB].map(toHex);
    const playersFed = toHex(info.read.contract.federationId).toLowerCase();
    // 1. WHAT THE OTHERS SERVE, AND THE PEG-INS THEY HAND ON
    const served = new Map();
    await Promise.all(members.filter((k) => k !== me).map(async (k) => { try { served.set(k, await getJson(`${urlOf(k)}/slash-release?start=${info.start}`)); } catch { /* says nothing yet */ } }));
    for (const s of served.values()) {
      for (const rec of [...((s.release && s.release.pegins) || []), ...((s && s.pegins) || []), ...proposalsServed(s).flatMap((p) => p.pegins)]) holdPegIn(info.start, rec, panelA);
    }
    // 2. WHAT IT ASKS ITSELF: each member's players' peg-in, and a reserves' peg-in of each open federation
    const fids = [...new Set([playersFed, ...(await federations()).filter((f) => f && f.status === 'OPEN').map((f) => String(f.federation).toLowerCase())])];
    const held = new Set(heldPegIns(info.start).map((p) => pegName(p.node, p.federation, p.use)));
    await Promise.all(panelA.map(async (k) => {
      for (const [fid, use] of [[playersFed, 'players'], ...fids.map((f) => [f, 'reserves'])]) {
        if (held.has(pegName(k, fid, use))) continue;
        const rec = await pegInOf(k, info.start, fid, use);
        if (rec) holdPegIn(info.start, rec, panelA);
      }
    }));
    // 3. ITS OWN PROPOSAL
    const mine = heldPegIns(info.start);
    const b = await build({ e, info, hold, panels, path: 'release', verdict, carrierKeys, pegs: pegsOf(mine, info.start, panelA) });
    if (!b.ok) return b;
    const signature = schnorr.sign(b.digest, secret);
    const row = keepSpend(info.start, 'release', b, signature);
    if (row.table_id !== toHex(b.tableId)) return { ok: false, why: 'the table moved' };
    if (!row.signature || !same(new Uint8Array(row.signature), signature)) db.prepare('UPDATE slash_spends SET signature = ? WHERE start = ? AND path = ?').run(signature, info.start, 'release');
    keepProposal(info.start, b, mine, signature);
    relStep(info.start, relStateOf(info.start), RELEASE.PROPOSED, { tableId: toHex(b.tableId) });
    const builds = new Map([[toHex(b.tableId), b]]);
    // ONE BUILD PER PEG-IN SET THIS PASS (kanban #1192): the table follows from the peg-ins and this seat's own reads, so a proposal that names a set built already costs nothing
    const pegKey = (pegs) => [...pegs].map(([k, v]) => `${k}=${toHex(v)}`).sort().join('|');
    const built = new Map([[pegKey(pegsOf(mine, info.start, panelA) || new Map()), b]]);
    const buildOnce = async (pegs) => { const k = pegKey(pegs); if (!built.has(k)) built.set(k, await build({ e, info, hold, panels, path: 'release', verdict, carrierKeys, pegs })); return built.get(k); };
    // 4. THE OTHERS' PROPOSALS, CHECKED AND REBUILT HERE: each member's own first, then the rest, at most RELEASE_BUILDS_PER_MEMBER new builds per member and pass
    const queue = [];
    for (const [k, s] of served) proposalsServed(s).forEach((p, i) => queue.push({ via: k, p, i }));
    queue.sort((x, y) => x.i - y.i);
    const spent = new Map();
    for (const { via, p } of queue) {
      const id = String(p.tableId).toLowerCase();
      if (builds.has(id)) continue;
      const pegs = pegsOf(p.pegins, info.start, panelA);
      if (!pegs) continue;
      const fresh = !built.has(pegKey(pegs));
      if (fresh && (spent.get(via) || 0) >= RELEASE_BUILDS_PER_MEMBER) continue;
      if (fresh) spent.set(via, (spent.get(via) || 0) + 1);
      const theirs = await buildOnce(pegs);
      if (!theirs.ok || toHex(theirs.tableId) !== id || toHex(theirs.bytes) !== String(p.table).toLowerCase()) continue;
      // SIGNED AND KEPT ONCE, WITHIN THE QUOTA OF THE MEMBER THAT HANDED IT ON; past it, not signed here
      if (!db.prepare('SELECT 1 FROM slash_release_props WHERE start = ? AND table_id = ?').get(info.start, id)) {
        if (keptVia(info.start, via) >= RELEASE_PROPOSALS_PER_MEMBER) continue;
        keepProposal(info.start, theirs, p.pegins.map((x) => pegRecord(checkPegIn(x, info.start, panelA))), schnorr.sign(theirs.digest, secret), via);
      }
      builds.set(id, theirs);
    }
    // ...AND THOSE SIGNED ON AN EARLIER PASS, REBUILT FROM THE PEG-INS THEY NAME (at most RELEASE_PROPOSALS_PER_MEMBER per member and its own: the quota bounds this too)
    for (const r of db.prepare('SELECT table_id, pegins FROM slash_release_props WHERE start = ? ORDER BY made_ms DESC').all(info.start)) {
      if (builds.has(r.table_id)) continue;
      const pegs = pegsOf(JSON.parse(r.pegins), info.start, panelA);
      const again = pegs ? await buildOnce(pegs) : null;
      if (again && again.ok && toHex(again.tableId) === r.table_id) builds.set(r.table_id, again);
    }
    // 5. THE SIGNATURES OVER EACH, FROM EVERY MEMBER'S DOOR; ONE GOES OUT AT t OF EACH PANEL
    for (const s of served.values()) {
      for (const p of proposalsServed(s)) {
        const got = builds.get(String(p.tableId).toLowerCase());
        if (!got) continue;
        for (const x of p.signatures || []) {
          if (!x || !members.includes(x.node) || x.node === me) continue;
          let sig; try { sig = fromHex(x.signature); } catch { continue; }
          if (verifySig(sig, got.digest, fromHex(x.node))) db.prepare('INSERT OR IGNORE INTO slash_spend_sigs (start, table_id, node, signature) VALUES (?, ?, ?, ?)').run(info.start, toHex(got.tableId), x.node, sig);
        }
      }
    }
    const t = panelThreshold(panels.panelA.length);
    let best = null;
    for (const [id, got] of builds) {
      const own = db.prepare('SELECT signature FROM slash_release_props WHERE start = ? AND table_id = ?').get(info.start, id);
      const sigs = new Map(own ? [[me, new Uint8Array(own.signature)]] : []);
      for (const r of db.prepare('SELECT node, signature FROM slash_spend_sigs WHERE start = ? AND table_id = ?').all(info.start, id)) sigs.set(r.node, new Uint8Array(r.signature));
      const a = panels.panelA.filter((k) => sigs.has(toHex(k))).length, z = panels.panelB.filter((k) => sigs.has(toHex(k))).length;
      if (!best || Math.min(a, z) > Math.min(best.a, best.z)) best = { id, got, sigs, a, z };
      if (a < t || z < t) continue;
      const { raw, txid } = signedHoldSpend({ spend: got.spend, witness: releaseWitness({ hold, panelA: panels.panelA, panelB: panels.panelB, signatures: sigs }) });
      // THE ONE THAT GOES OUT is this seat's release, whoever proposed it; on disk with its bytes BEFORE it is sent (kanban #1192)
      if (id !== toHex(b.tableId)) keepSpend(info.start, 'release', got, new Uint8Array(own.signature));
      if (!relStep(info.start, RELEASE.PROPOSED, RELEASE.SENDING, { tableId: id, raw: toHex(raw), txid: display(toHex(txid)) })) return { ok: false, why: 'the release moved while it was signed', tableId: id };
      const r = await sendRelease(info.start);
      if (!r.ok) return r;
      return { ok: true, txid: r.txid, tableId: id, signers: { a, b: z, t }, feeSats: got.feeSats, vsize: got.vsize, proposals: builds.size };
    }
    return { ok: false, why: `${best.a} of panel A and ${best.z} of panel B have signed the best of ${builds.size} proposal(s), ${t} of each are needed`, tableId: best.id };
  }

  /**
   * A SLASH WITH NO ROUND (kanban #1093 part 2, ruling #1111): the same PayoutTable, round_id 32 zero bytes, no entries, its outputs the filer and ONE census-key escrow output per bond
   * (slashEscrowOutput with no panels), the whole hold less the fee. That escrow pays the liquidation's claims (liquidation-escrow-run.js).
   */
  function buildRoundless({ e, info, hold }) {
    const escrow = slashEscrowOutput({ censusKey: e.advert.censusKey, fallbackBlocks: clocks.fallbackBlocks }, { tweakPoint });
    const outpoint = { txid: fromHex(e.hold.txid), vout: 0, value: BigInt(e.bondSats) };
    const built = slashHoldSpend({ path: 'fallback', hold, outpoint, panels: null, proofId: info.proofId, slashHeight: info.slashHeight, rate: info.rate, clocks,
      table: roundlessTableInputs({ networkId, bond: { txid: e.txid, vout: e.vout }, filer: info.filer, escrowScript: escrow.script, marginMsat: carrierMarginMsat }) });
    return built.ok ? { ...built, carriers: [], outpoint } : built;
  }

  // ---- THE FALLBACK: the census key, with its holders as carriers ----
  async function fallbackBuild({ e, info, hold, verdict, entries }) {
    if (!info.read.roundId) return buildRoundless({ e, info, hold });
    const keyHex = toHex(e.advert.censusKey);
    const holders = await holdersOf(keyHex, info.height);
    if (!holders.length) return { ok: false, why: `no holders of key ${keyHex.slice(0, 16)} are read here`, wait: true };
    const bonds = bondsOf(entries);
    const excluded = [toHex(e.pubkey), ...(await seatsOf(info.read.contract, info.read.roundId))];
    const playersFed = toHex(info.read.contract.federationId);
    // A FALLBACK'S HOLDERS STILL READ THEIR CARRIERS THEMSELVES (#1130 rules the panels' proposals; a fallback is asked for by its table id)
    const pegIns = new Map();
    for (const h of holders) { if (excluded.includes(h.key)) continue; const p = await pegInOf(h.key, info.start, playersFed, 'players'); if (p) pegIns.set(h.key, { script: fromHex(p.script), signature: fromHex(p.signature) }); }
    const carriers = fallbackCarriers({ holders, bonds, excluded, pegIns, networkId, start: startOutpoint(info.start), federationId: fromHex(playersFed), verify: verifySig });
    const pegs = new Map(carriers.map((c) => [pegName(c.key, playersFed, 'players'), c.script]));
    if ((await tipHeight()) < reserveCapOf(info)) {
      for (const f of (await federations()).filter((x) => x && x.status === 'OPEN' && x.reserveKey)) {
        for (const c of carriers) { const r = await pegInOf(c.key, info.start, String(f.federation).toLowerCase(), 'reserves'); if (r) { pegs.set(pegName(c.key, f.federation, 'reserves'), fromHex(r.script)); break; } }
      }
    }
    return build({ e, info, hold, panels: null, path: 'fallback', verdict, carrierKeys: carriers.map((c) => ({ key: c.key, bondSats: c.bondSats })), pegs });
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
  const tagOf = (name) => `${name.start}:${name.path}:${name.index}`;
  const stateOf = (name) => { const row = db.prepare('SELECT state FROM slash_carried WHERE start = ? AND path = ? AND out_index = ?').get(name.start, name.path, name.index); return row ? JSON.parse(row.state) : {}; };
  const keepState = (name, state) => db.prepare('INSERT OR REPLACE INTO slash_carried (start, path, out_index, state) VALUES (?, ?, ?, ?)').run(name.start, name.path, name.index, JSON.stringify(state));
  /** THE UNUSED MARGIN THIS CARRIER OWES A FEDERATION'S RESERVE KEY (kanban #1086): what its payouts' fees left of the margins it kept back, paid with its next reserves' payout there. */
  const owedMarginOf = (fid) => BigInt((db.prepare('SELECT msat FROM slash_margin_owed WHERE federation = ?').get(fid) || { msat: '0' }).msat);
  const balanceOf = async (port) => (typeof port.ecashBalance === 'function' ? BigInt(await port.ecashBalance()) : null);
  /**
   * ONE OUTPUT A CARRIER WAS PAID, PAID ON (§5A.3B, kanban #972, RULED 2026-11-03, kanban #1086): claim the peg-in, each player's slice to refund_key(player), the rest to that
   * federation's reserve key, kept as a reserve row of kind `slash`. A players' output holds `marginMsat` (the margin its table or escrow spend names) past its slices: the
   * receiving federation's peg-in fee comes off it first (kanban #1093), and the carrier keeps back only the payout part of it (`carrierPayoutFeeMsat`, never more than the
   * margin) for its payout's fee, so the players are paid exactly their slices and what the peg-in left of the margin goes to the reserve key in the same payout. One whose
   * spend names `marginOff: players` holds the slices alone: the peg-in fee and the payout part come off them pro rata. The claim is this output's own deposit, read by its
   * outpoint (a walletv2 client takes every deposit on one address). A carrier keeps nothing: what its payout's fee left of the margin, measured on its client's balance, goes to the reserve key with its next
   * payout there (this spend's reserves' part, or the next one). `name` { start (where its state is kept), path, index }; `startHex` the hold's start, for the reserve row.
   */
  async function payOn({ name, startHex, txid, vout, o, peg, slices, marginMsat }) {
    const tag = tagOf(name);
    const state = stateOf(name);
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
        // THIS OUTPUT'S OWN DEPOSIT (kanban #1093): a walletv2 client has one peg-in address, so two outputs to one carrier land on it; the claim is read by outpoint
        const c = await port.peginClaim(peg.address, { outpoint: `${txid}:${vout}`, sats: o.value });
        state.claimedMsat = String(c.claimedMsat);
        keepState(name, state);
      }
      // THE MARGIN PAID THE PEG-IN (kanban #1093): the output holds the slices plus the margin; the federation took its peg-in fee off it before crediting it. The carrier
      // keeps back only the payout part of the margin (never more than the margin); what the claim holds past the slices and that hold is the reserves'
      const margin = BigInt(marginMsat ?? 0n);
      const feeHold = margin < carrierPayoutFeeMsat ? margin : carrierPayoutFeeMsat;
      const players = o.pays === 'player_carrier' ? slices : [];
      const playersMsat = players.reduce((a, x) => a + x.msat, 0n);
      const claimedAll = BigInt(state.claimedMsat);
      const kept = claimedAll < feeHold ? claimedAll : feeHold;
      const claimed = claimedAll - kept;
      const pays = players.map((x) => ({ key: toHex(refundKeyOf(x.playerPubkey)), msat: claimed >= playersMsat ? x.msat : (x.msat * (claimed > 0n ? claimed : 0n)) / playersMsat, entryId: toHex(x.entryId) }));
      const rest = claimed - pays.reduce((a, x) => a + x.msat, 0n);
      const reserveKey = await reserveKeyOf(peg.federation);
      const owed = reserveKey ? owedMarginOf(peg.federation) : 0n;
      const list = [...pays, ...(reserveKey && rest + owed > 0n ? [{ key: toHex(reserveKey), msat: rest + owed, reserves: true }] : [])].filter((x) => x.msat > 0n);
      // NO RESERVE KEY YET: what the peg-in allowance left stays on this client, owed on to the reserve key as unused margin is
      let unused = kept + (!reserveKey && rest > 0n ? rest : 0n), carried = 0n;
      // THE PAYOUT ONCE (kanban #1174, keyed-payout.js): its record ASKED - key, list, the balance before - is written before the tool is called;
      // after a stop the list is the one recorded (what is owed may have moved), read back under its key, never paid a second time
      const asked = payoutOf(state.pay) === PAYOUT.ASKED;
      if (asked) {
        const byKey = new Map(state.pay.list.map((x) => [x.key, BigInt(x.msat)]));
        for (const x of list) x.msat = byKey.get(x.key) ?? 0n;
        for (const [k, m] of byKey) if (!list.some((x) => x.key === k)) list.push({ key: k, msat: m, ...(k === (reserveKey && toHex(reserveKey)) ? { reserves: true } : {}) });
      }
      if (!list.length && !asked) { state.paidTxid = 'nothing'; } else {
        const before = asked ? (state.pay.balanceBeforeMsat !== undefined && state.pay.balanceBeforeMsat !== null ? BigInt(state.pay.balanceBeforeMsat) : null) : await balanceOf(port).catch(() => null);
        if (!asked) state.pay = { balanceBeforeMsat: before === null ? null : String(before) };
        const got = await keyedPay({ rec: state.pay, save: () => keepState(name, state), list: list.map((x) => ({ key: x.key, msat: x.msat })), key: `slash:${tag}`,
          pay: (l, key) => port.payouts(l, { key }), paidBack: (l, key) => port.payoutsSent(l, key), now });
        if (!got.ok) throw new Error(got.why);
        const paid = { txid: got.txid, payouts: got.payouts };
        // the balance after a pay read back is not this pay's alone: its fee is not known
        const after = got.again ? null : await balanceOf(port).catch(() => null);
        const out = list.reduce((a, x) => a + x.msat, 0n);
        // WHAT THE PAYOUT'S FEE TOOK: the client's balance before less after less what went out; unknown, the whole margin counts as taken
        const fee = before !== null && after !== null ? before - after - out : null;
        unused = (fee === null ? 0n : fee <= 0n ? kept : fee >= kept ? 0n : kept - fee) + (!reserveKey && rest > 0n ? rest : 0n);
        if (fee === null) log(`[slash] carrying ${startHex.slice(0, 16)} output ${name.index}: the client's balance cannot be read, the margin's unused part is not known`);
        state.feeMsat = fee === null ? null : String(fee);
        const outIdxOf = (k) => (paid.payouts.find((y) => y.refundPk === k) || {}).outIdx ?? null;
        state.paidTxid = paid.txid;
        state.players = pays.map((x) => ({ key: x.key, entry: x.entryId, msat: String(x.msat), outIdx: outIdxOf(x.key) }));
        const r = list.find((x) => x.reserves);
        if (r) {
          carried = owed;
          state.reserves = { key: r.key, msat: String(r.msat), outIdx: outIdxOf(r.key), marginOwedMsat: String(owed) };
          const roundId = (db.prepare('SELECT round_id FROM slash_holds WHERE start = ?').get(startHex) || {}).round_id;
          if (state.reserves.outIdx !== null && roundId) keepReserveRow({ outpoint: { txid: fromHex(paid.txid), outIdx: BigInt(state.reserves.outIdx) }, entryId: fromHex(startHex), roundId: fromHex(roundId),
            federationId: peg.federation, recipientPk: reserveKey, amountMsat: r.msat, contractId: (paid.payouts.find((y) => y.refundPk === r.key) || {}).contractId || 'slash', senderOnContract: false, image: null, item: 'slash' });
        }
      }
      state.marginUnusedMsat = String(unused);
      // ONE WRITE: this output paid, and what this carrier owes that reserve key now (what it just paid on off, this payout's unused margin on)
      db.exec('BEGIN');
      try {
        db.prepare('INSERT OR REPLACE INTO slash_margin_owed (federation, msat) VALUES (?, ?)').run(peg.federation, String(owedMarginOf(peg.federation) - carried + unused));
        keepState(name, state);
        db.exec('COMMIT');
      } catch (x) { db.exec('ROLLBACK'); throw x; }
      log(`[slash] carried ${name.path} ${startHex.slice(0, 16)} output ${name.index}: claimed ${state.claimedMsat} msat, ${(state.players || []).length} player(s) paid${state.reserves ? `, ${state.reserves.msat} msat to the reserves` : ''}, margin ${margin} msat, ${unused} unused and owed on: ${state.paidTxid}`);
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
        const r = await payOn({ name: { start: h.start, path: c.path, index: i }, startHex: h.start, txid: c.txid, vout: i + 1, o, peg, marginMsat: c.table.marginMsat,
          slices: (slices.find((y) => y.index === i) || { slices: [] }).slices });
        if (r) done.push(r);
      }
    }
    done.push(...await escrow.carry());
    done.push(...await liquidation.carry().catch((x) => { log(`[liquidation] carrying waits: ${x.message}`); return []; }));
    return done;
  }

  // ---- ONE PASS ----
  let passing = false;
  let peers = [];                                 // the census' node keys at the last pass: whom an earlier table is asked of
  // WHAT A SLASH LEFT IN ESCROW (RULED 2026-11-03, kanban #1085): slash-escrow-run.js, on this run's reads
  // WHAT A SLASH WITH NO ROUND LEFT IN ESCROW pays the liquidation's claims (kanban #1093 part 2, ruling #1111): liquidation-escrow-run.js, on this run's reads
  const liquidation = createLiquidationEscrow({ secret, me, networkId, clocks, db, tweakPoint, tipHeight, entriesAtTip, txOut, fetchProof, judge, holdersOf, heldKey, thresholdOf, signer, urlOf,
    fetchFn, send, portFor, scriptOf, federationsAt, reserveKeyOf, claimsOf, now, stepMs, log, confirmedOf, fallbackRank, getJson, marginMsat: carrierMarginMsat,
    payoutFeeMsat: carrierPayoutFeeMsat });
  const escrow = createSlashEscrow({ secret, me, clocks, db, tweakPoint, tipHeight, entriesAtTip, txOut, fetchProof, judge, panelsOf, seatsOf, holdersOf, heldKey, thresholdOf, signer, urlOf,
    fetchFn, send, portFor, scriptOf, federationsAt, retired, now, stepMs, log, confirmedOf, peers: () => peers, fallbackRank, getJson, payOn });
  const unhandled = new Set();                    // starts whose offence no loss rule reads: dropped once (pass)
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
        if (unhandled.has(info.start)) continue;
        const verdict = await judge(info.bytes, { startHeight: info.height });
        if (verdict.verdict !== true) { done.push({ start: info.start, why: verdict.why }); continue; }
        // AN OFFENCE NO LOSS RULE READS (`handles`, server.js: slash.js OFFENCES - the named claim's rows are not among them) IS DROPPED ONCE, not built again every pass (measured
        // 2026-11-05 on s28a: 752 "the losses cannot be read yet: FORFEIT_OF_LOST_ENTRY is not one of the offences", each a build that asked every holder for
        // its peg-in first). It can never become readable while this code runs; the hold stays as it is
        const offence = verdict.held && verdict.held.offence;
        if (info.read.roundId && offence && !handles(verdict.held)) {
          unhandled.add(info.start);
          log(`[slash] start ${info.start.slice(0, 16)} dropped from release and fallback: ${offence} has no loss rule here, so no table is built for it`);
          done.push({ start: info.start, dropped: true, why: `${offence} has no loss rule here` });
          continue;
        }
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
      done.push(...await liquidation.pass().catch((x) => { log(`[liquidation] the escrow pass did not run: ${x.message}`); return []; }));
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
    // THE PROPOSALS (RULED 2026-11-04, kanban #1130): this seat's own names the peg-ins it was built from; every other it checked and signed, with the signatures it holds over each
    if (out.release) {
      const own = db.prepare('SELECT pegins FROM slash_release_props WHERE start = ? AND table_id = ?').get(start, out.release.tableId);
      if (own) out.release.pegins = JSON.parse(own.pegins);
      out.release.proposals = db.prepare('SELECT table_id, tbl, pegins, signature FROM slash_release_props WHERE start = ? ORDER BY made_ms').all(start).map((r) => ({ tableId: r.table_id, table: toHex(new Uint8Array(r.tbl)),
        pegins: JSON.parse(r.pegins), signatures: [{ node: me, signature: toHex(new Uint8Array(r.signature)) }, ...db.prepare('SELECT node, signature FROM slash_spend_sigs WHERE start = ? AND table_id = ?').all(start, r.table_id)
          .map((x) => ({ node: x.node, signature: toHex(new Uint8Array(x.signature)) }))] }));
    }
    // EVERY CHECKED PEG-IN IT HOLDS, for the others to take (#1130)
    const pegins = heldPegIns(start);
    if (pegins.length) out.pegins = pegins;
    out.carried = db.prepare('SELECT path, out_index, state FROM slash_carried WHERE start = ?').all(start).map((r) => ({ path: r.path, index: r.out_index, ...JSON.parse(r.state) }));
    const esc = escrow.served(start);
    if (esc) out.escrow = esc;
    // AND WHAT IT CARRIED OFF THIS START'S ESCROW (kept under `escrow:<outpoint>`, slash-escrow-run.js carry): a release whose table found no carrier sends the players'
    // part to the escrow (#1034 answer 6), and a carrier pays it from an escrow spend later - measured 11-04 on the main test host, run 9: the player was paid 36,000,000 msat
    // at its key that way, and no door said so, because this list held only the start's own carries
    for (const sp of (esc && esc.spends) || []) {
      for (const r of db.prepare('SELECT path, out_index, state FROM slash_carried WHERE start = ?').all(`escrow:${sp.escrow}`)) out.carried.push({ path: r.path, index: r.out_index, escrow: sp.escrow, ...JSON.parse(r.state) });
    }
    const liq = liquidation.served(start);
    if (liq) out.liquidation = liq;
    return out;
  }
  const tableById = (id) => { const r = db.prepare('SELECT bytes FROM slash_tables WHERE table_id = ?').get(String(id).toLowerCase()); return r ? new Uint8Array(r.bytes) : null; };
  const list = () => db.prepare('SELECT start, height, round_id, proof_id, node, bond FROM slash_holds ORDER BY height DESC LIMIT 64').all().map((r) => ({ ...r, ...served(r.start) }));

  /** A census key ask that is not a start: a fallback of a hold, or an escrow spend (kind `escrow`). */
  const checkOther = (request) => (request && request.kind === 'escrow' ? escrow.checkEscrow(request) : request && request.kind === 'liquidation-escrow' ? liquidation.checkLiquidationEscrow(request) : checkFallback(request));
  // A CarrierPegIn names a table: a round's escrow's, or a roundless one's (the liquidation's)
  const takeCarrierPegIn = async (tableId, rec) => { const r = await escrow.takeCarrierPegIn(tableId, rec); return r.ok || r.status !== 503 ? r : liquidation.takeCarrierPegIn(tableId, rec); };
  const servedCarriers = (tableId) => { const a = escrow.servedCarriers(tableId); return a.carriers.length ? a : liquidation.servedCarriers(tableId); };
  return { pass, carry, checkFallback, checkEscrow: escrow.checkEscrow, checkOther, served, tableById, list, ownPegIn, confirmedOf, takeCarrierPegIn, servedCarriers, liquidation };
}
