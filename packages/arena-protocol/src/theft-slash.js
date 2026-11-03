// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FROM A MARK OF THEFT TO A SLASH OF EVERY SEATED GUARDIAN'S BOND (kanban #1093 part 2, ruling #1106, ruling #1109 2026-11-03).
//
// A theft by a threshold of guardians leaves one of two objective marks in the federation's threshold-signed history: inflation (more e-cash redeemed so far than issued so far) or an
// unbacked spend (the reserve output spent on the chain, 6 deep, by a transaction the signed history never names). The federation is HALTED from the mark's height and liquidated as §23A.5,
// every note paid at face from the bonds of every guardian the record still seats - a hacked one and a lapsing one included, a DEPARTED one (left by notice) not.
//
// #1109 QUESTION 1 = A: the abandonment's path. Each bond is started into the hold of its node's newest slash_presig with the census key (guardian-slash-start), and that hold is released to
// the federation's liquidation escrow: by the panels after slash_hold_blocks where it has a release leaf, else by the census key after slash_fallback_blocks. No new script.
//
// #1109 QUESTION 2 = X (Y rejected): the proof carries everything a checker judges, so H(proof) is the hash of the complete proof (#1065). Each signed session goes in as its consensus bytes
// (Fedimint's SignedSessionOutcome encoding, what `await_signed_session_outcome` serves), with the federation's client config (consensus bytes) whose broadcast keys they verify against:
//   inflation       every signed session from 0 up to the mark's session (federation A: 9,660 sessions, ~10 MB - that size is the proof);
//   unbacked spend  the reserve outpoint, the spending transaction, and every signed session from the one that created the outpoint up to the spend; none names the spend.
// A checker re-verifies those bytes itself (a verifier injected into the seat) and reads the spend on its own chain; it never takes a live read or its own alarm book as the verdict.
//
// Pure: the chain, the curve, the record's signatures and the session verifier are the caller's.
import { outputsLeft } from './abandoned-slash.js';
import { BOND_TEMPLATE_V3 } from './bond-script.js';
import { taggedHash, toHex } from './hash.js';
import { Writer, Reader } from './encode.js';
import { parseTransaction } from './tx.js';
import { TAG, TYPE_THEFT_PROOF, PROTOCOL_VERSION, speaksVersion } from './constants.js';
import { GONE } from './federation-record.js';

const same = (a, b) => toHex(a) === toHex(b);
/** The two marks, as the alarm book names them (reserve-alarms.js ALARM_KINDS), and the byte each is written as. */
export const THEFT_KINDS = Object.freeze({ inflation: 1, 'unbacked-spend': 2 });
const kindOfByte = (b) => Object.keys(THEFT_KINDS).find((k) => THEFT_KINDS[k] === b) || null;
/** An unbacked spend is a mark only 6 deep (reserve-spend-watch.js UNBACKED_DEPTH). */
export const THEFT_SPEND_DEPTH = 6;

/** 1 type + 2 version + federation + node + txid + a 4-byte vout + 1 kind + a 4-byte mark height + an 8-byte mark session + the spend's txid. */
export const THEFT_PROOF_HEAD_BYTES = 148;

const varBytes = (w, b) => { w.u32(b.length); w.bytes(b); };
const readVarBytes = (r) => r.bytes(r.u32());

/**
 * THE PROOF A THEFT'S SLASH COMMITS TO. `federationId`; `nodePubkey` the guardian; `txid` (internal order) and `vout` its bond output; `mark` { kind, height, session } - inflation: the first
 * session where redeemed passes issued; unbacked spend: the last session carried, and `spendTxid` (32 bytes, display order as bitcoind names it); `record` the signed federation record that
 * seats the guardian; `config` the federation's client config, consensus bytes; `firstSession` and `sessions` [consensus bytes of each SignedSessionOutcome, in order]; an unbacked spend also
 * `reserve` { txid (display, 32 bytes), vout } the outpoint a threshold named and `spendTx` the raw spending transaction. Its id is the hash of these bytes, as for every slash proof.
 */
export function encodeTheftProof({ federationId, nodePubkey, txid, vout, mark, record, config, firstSession, sessions, reserve = null, spendTx = null }) {
  const kind = THEFT_KINDS[mark && mark.kind];
  if (!kind) throw new Error(`a mark of theft is one of ${Object.keys(THEFT_KINDS).join(', ')}`);
  if (!(record instanceof Uint8Array) || !record.length) throw new Error('a proof of a theft carries the signed record that seats the guardian');
  if (!(config instanceof Uint8Array) || !config.length) throw new Error('a proof of a theft carries the federation\'s config, whose keys the sessions verify against');
  if (!Number.isInteger(mark.height) || mark.height < 0) throw new Error('a mark names its height');
  if (!Number.isInteger(mark.session) || mark.session < 0) throw new Error('a mark names its session');
  if (!Number.isInteger(firstSession) || firstSession < 0) throw new Error('the sessions name the index they start at');
  if (!Array.isArray(sessions) || !sessions.length || !sessions.every((s) => s instanceof Uint8Array && s.length)) throw new Error('a proof of a theft carries its signed sessions');
  if (firstSession + sessions.length - 1 !== mark.session) throw new Error('the sessions run up to the mark\'s session');
  if (mark.kind === 'inflation' && firstSession !== 0) throw new Error('an inflation is a total over the whole history: its sessions start at 0');
  if (mark.kind === 'unbacked-spend') {
    if (!(mark.spendTxid instanceof Uint8Array && mark.spendTxid.length === 32)) throw new Error('an unbacked spend names its transaction (32 bytes)');
    if (!(reserve && reserve.txid instanceof Uint8Array && reserve.txid.length === 32 && Number.isInteger(reserve.vout))) throw new Error('an unbacked spend names the reserve outpoint');
    if (!(spendTx instanceof Uint8Array && spendTx.length)) throw new Error('an unbacked spend carries the spending transaction');
  }
  const w = new Writer();
  w.u8(TYPE_THEFT_PROOF);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(federationId);
  w.bytes32(nodePubkey);
  w.bytes32(txid);
  w.u32(vout);
  w.u8(kind);
  w.u32(mark.height);
  w.u64(BigInt(mark.session));
  w.bytes32(mark.kind === 'unbacked-spend' ? mark.spendTxid : new Uint8Array(32));
  varBytes(w, record);
  varBytes(w, config);
  w.u64(BigInt(firstSession));
  w.u32(sessions.length);
  for (const s of sessions) varBytes(w, s);
  if (mark.kind === 'unbacked-spend') { w.bytes32(reserve.txid); w.u32(reserve.vout); varBytes(w, spendTx); }
  return w.finish();
}

export function decodeTheftProof(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_THEFT_PROOF) throw new Error('not a proof of a theft');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const p = { federationId: r.bytes32(), nodePubkey: r.bytes32(), txid: r.bytes32(), vout: r.u32() };
  const kind = kindOfByte(r.u8());
  if (!kind) throw new Error('that proof names no mark of theft');
  const height = r.u32(), session = Number(r.u64()), spendTxid = r.bytes32();
  const record = readVarBytes(r), config = readVarBytes(r), firstSession = Number(r.u64()), n = r.u32();
  const sessions = [];
  for (let i = 0; i < n; i++) sessions.push(readVarBytes(r));
  const out = { ...p, mark: kind === 'inflation' ? { kind, height, session } : { kind, height, session, spendTxid }, record, config, firstSession, sessions };
  if (kind === 'unbacked-spend') { out.reserve = { txid: r.bytes32(), vout: r.u32() }; out.spendTx = readVarBytes(r); }
  r.end();
  if (!record.length || !config.length || !n) throw new Error('a proof of a theft carries its record, the config and its sessions');
  if (firstSession + n - 1 !== session) throw new Error('the sessions do not run up to the mark\'s session');
  if (kind === 'inflation' && firstSession !== 0) throw new Error('an inflation\'s sessions start at 0');
  return out;
}

/** Whether `bytes` is this kind of proof: a reader of proofs of every kind asks this first. */
export const isTheftProof = (bytes) => bytes instanceof Uint8Array && bytes[0] === TYPE_THEFT_PROOF;
/** The 32 bytes a slash's OP_RETURN commits to, of a proof's bytes. */
export const theftProofId = (bytes) => taggedHash(TAG.slashProof, bytes);

/** WHO A THEFT TAKES: every guardian the record still seats (not gone); a DEPARTED one left by notice and is not taken, an ABANDONED one is slashed by its own row. Node keys. */
export function theftTakes(record) {
  const gone = new Set((record && record.gone || []).filter((g) => g.kind === GONE.DEPARTED || g.kind === GONE.ABANDONED).map((g) => toHex(g.peerKey)));
  return ((record && record.guardians) || []).filter((g) => !gone.has(toHex(g.peerKey))).map((g) => g.nodePubkey);
}

/**
 * WHAT A GUARDIAN'S BOND HOLDS FOR A THEFT: the template-3 outputs of `nodePubkey` in `bonds` (one census read, abandoned-slash.js bondsOf) that nothing has ended or started, confirmed at or
 * before `atHeight`. A started output is out, its slash is running. Answers outputsLeft's rows.
 */
export const theftOutputs = (bonds, nodePubkey, atHeight) => outputsLeft(bonds, nodePubkey, atHeight).filter((o) => o.template === BOND_TEMPLATE_V3);

/**
 * DO THE SESSIONS SHOW THE MARK: what the verifier answered over the proof's own bytes (the stake-lock tool's `theft-verify`, see SESSION VERIFIER below), held to what the proof claims.
 * `spendHeight` the height this checker's chain confirmed the spend at (unbacked spend only). Answers { ok, why }.
 */
export function sessionsShowMark(p, v, { spendHeight = null } = {}) {
  if (!v || typeof v !== 'object') return { ok: false, why: 'the verifier gave no answer' };
  if (v.federationMatches !== true) return { ok: false, why: 'the config in that proof is not the federation it names' };
  if (Array.isArray(v.unverified) && v.unverified.length) return { ok: false, why: `session ${v.unverified[0]} does not verify against the federation's broadcast keys` };
  if (v.sessions !== p.sessions.length || v.verified !== p.sessions.length) return { ok: false, why: `${v.verified ?? 0} of the proof's ${p.sessions.length} sessions verify` };
  if (v.firstSession !== p.firstSession || v.lastSession !== p.mark.session) return { ok: false, why: 'the verifier read other session indices than the proof names' };
  if (p.mark.kind === 'inflation') {
    if (v.firstInflationSession !== p.mark.session) return { ok: false, why: v.firstInflationSession === null || v.firstInflationSession === undefined ? 'redeemed never passes issued in those sessions' : `redeemed passes issued at session ${v.firstInflationSession}, not ${p.mark.session}` };
    return { ok: true, why: `inflation at session ${p.mark.session}: redeemed ${v.cumulativeRedeemedMsat} msat over issued ${v.cumulativeIssuedMsat} msat, sessions 0-${p.mark.session} verified` };
  }
  const spend = toHex(p.mark.spendTxid);
  if ((v.signedPegOutTxids || []).map((t) => String(t).toLowerCase()).includes(spend)) return { ok: false, why: 'the signed history names that spend: it was the federation\'s own peg-out' };
  if (v.outpointCreatedAt !== p.firstSession) return { ok: false, why: 'the sessions do not start at the one that created the reserve outpoint' };
  if (!(Number.isInteger(v.coversHeight) && Number.isInteger(spendHeight) && v.coversHeight >= spendHeight)) return { ok: false, why: `the sessions do not reach the spend's height ${spendHeight}` };
  return { ok: true, why: `unbacked spend ${spend.slice(0, 16)}: sessions ${p.firstSession}-${p.mark.session} verified, none names it` };
}

/** THE SPEND ON THE CHECKER'S CHAIN: the transaction is the one the mark names and spends the reserve outpoint. `confirmations` this checker's chain's. Answers { ok, wait, why }. */
export function spendStands(p, { confirmations }) {
  let tx; try { tx = parseTransaction(p.spendTx); } catch (e) { return { ok: false, why: `the spend in that proof is no transaction: ${e.message}` }; }
  if (toHex(Uint8Array.from(tx.txid).reverse()) !== toHex(p.mark.spendTxid)) return { ok: false, why: 'the transaction in that proof is not the spend it names' };
  const reserveInternal = toHex(Uint8Array.from(p.reserve.txid).reverse());
  if (!tx.inputs.some((i) => toHex(i.previousTxid) === reserveInternal && i.previousVout === p.reserve.vout)) return { ok: false, why: 'that transaction does not spend the reserve outpoint' };
  if (!Number.isInteger(confirmations)) return { ok: false, wait: true, why: 'this seat\'s chain does not hold that spend' };
  if (confirmations < THEFT_SPEND_DEPTH) return { ok: false, wait: true, why: `the spend is ${confirmations} deep, ${THEFT_SPEND_DEPTH} needed` };
  return { ok: true };
}

/**
 * MAY THIS OUTPUT BE SLASHED FOR THIS THEFT, on one checker's own reads of the proof's own bytes. `record` the proof's record, already held to its threshold on the checker's census;
 * `newest` the newest record the checker holds of that federation, or null; `proof` decoded; `bonds` its census read at `atHeight`; `shown` sessionsShowMark's answer, or undefined where
 * the checker could not run its verifier; `spend` spendStands' answer (unbacked spend). Answers { verdict: true | false | undefined, why, output? }: undefined only where this checker cannot
 * say yet (no verifier, the spend not 6 deep on its chain), so a hold's return is never taken on a guess.
 */
export function theftSlashStands({ record, newest = null, proof, bonds, atHeight, shown, spend = null }) {
  if (!same(record.federationId, proof.federationId)) return { verdict: false, why: 'that record is another federation\'s' };
  if (!theftTakes(record).some((k) => same(k, proof.nodePubkey))) return { verdict: false, why: 'that record does not seat that node as a guardian' };
  if (newest && !theftTakes(newest).some((k) => same(k, proof.nodePubkey))) return { verdict: false, why: `the newest record this seat holds of that federation (${newest.height}) does not seat that node` };
  const output = theftOutputs(bonds, proof.nodePubkey, atHeight).find((o) => o.txid === toHex(proof.txid) && o.vout === proof.vout);
  if (!output) return { verdict: false, why: `${toHex(proof.txid).slice(0, 16)}:${proof.vout} is no unspent template-3 bond output of that node at ${atHeight}` };
  if (proof.mark.kind === 'unbacked-spend') {
    if (!spend) return { verdict: undefined, why: 'the spend was not read on this seat\'s chain' };
    if (!spend.ok) return { verdict: spend.wait ? undefined : false, why: spend.why };
  }
  if (shown === undefined) return { verdict: undefined, why: 'this seat cannot verify signed sessions yet' };
  if (!shown.ok) return { verdict: false, why: shown.why };
  return { verdict: true, why: `${shown.why}: every seated guardian's bond pays the notes`, output };
}

/**
 * WHERE A SLASHED GUARDIAN BOND IS OWED (§23A.5, kanban #1093 part 2): a guardian of a federation that is liquidating (`halt` its halt - a HALTED record, the seats' halt proof or a mark of
 * theft, liquidations.js haltOf) pays that federation's notes at face first, so the slash is owed to its LIQUIDATION escrow; otherwise to the protocol reserves. One rule for a theft and an
 * abandonment alike. Answers { to: 'liquidation', federation, haltHeight } or { to: 'reserves' }.
 */
export function slashedGuardianPays({ federation, halt }) {
  return halt && Number.isInteger(halt.height) ? { to: 'liquidation', federation: String(federation).toLowerCase(), haltHeight: halt.height } : { to: 'reserves' };
}

/**
 * THE SESSION VERIFIER A CHECKER RUNS (the stake-lock tool, packages/arena-node/tools/stake-lock, `--mode theft-verify`; kanban #1108 extends it). Input on stdin, one JSON object:
 *   { federationId (hex), config (hex, the client config's consensus bytes), firstSession, sessions: [hex of each SignedSessionOutcome's consensus bytes],
 *     spendTxid? (hex, display), reserve? ('txid:vout', display) }
 * It reads no guardian. It answers one JSON line:
 *   { mode: 'theft-verify', federationMatches (the config's federation id is federationId), sessions, verified, unverified: [index], firstSession, lastSession,
 *     firstInflationSession (null: none; totals from session 0 when firstSession is 0), cumulativeIssuedMsat, cumulativeRedeemedMsat, signedPegOutTxids: [display hex],
 *     outpointCreatedAt (the session whose wallet item created the reserve outpoint named, or null), coversHeight (the highest consensus block height the sessions agree) }
 */
export const THEFT_VERIFY_MODE = 'theft-verify';
/** The verifier's input for a decoded proof. */
export const theftVerifyInput = (p) => ({ federationId: toHex(p.federationId), config: toHex(p.config), firstSession: p.firstSession, sessions: p.sessions.map(toHex),
  ...(p.mark.kind === 'unbacked-spend' ? { spendTxid: toHex(p.mark.spendTxid), reserve: `${toHex(p.reserve.txid)}:${p.reserve.vout}` } : {}) });
