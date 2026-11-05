// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROOF OF OFFENCE ROWS (a) AND (b) OF THE NAMED CLAIM (§5A.3, protocol 27, kanban #1044 B1, rulings #1131 4, #1135 2), as published and as judged.
//
// Both rows stand on bytes the federation signed: the sessions that fund the round's Arena locks and the session that holds the spend, each a
// SignedSessionOutcome verified against the federation's broadcast keys from its client config. The judge replays them OFFLINE with the stake-lock
// tool's `arena-claim-read` (no client, no guardian): the spend, its named signers, its body id. The proof carries those bytes whole.
//
//   (a) OFF_TABLE_CLAIM        + the correct table of the round's settlement in that federation and what shows it correct: the Entry Contracts,
//                              each loser's P, the FINAL records. The judge reads the table as the table row reads one (tableAgainstFinals) and
//                              takes it only when it is EXACTLY F of a threshold of FINALs (complete, nothing false); it rebuilds the table's
//                              body with its own tool and holds the spend false when its body id is another, or its claims name different
//                              signer sets - on a transaction that claims a lock the correct table claims (a late entry's own table claims
//                              no lock of the round's table, so it is never read against it). A table not shown exactly F builds no proof.
//   (b) FORFEIT_OF_LOST_ENTRY  + the entry and the accused's own signed result for it, non-qualifying (a VOID is not a lost result). The spend is
//                              a Cancel of that entry's stake or fee lock naming the accused.
//
// THE RECORD: the 199-byte proof body - `nodePubkey` the accused, `signedResultId` the spend's txid (its 32 bytes as the tool prints them),
// `transcriptHash` (a) the correct table's id / (b) the entry id, `playerPubkey` zero for (a) and the entry's player for (b), the bond the accused
// advertised - then TYPE_NAMED_CLAIM_EVIDENCE, the row (1 = a, 2 = b), the length of the rest and the rest: the config, the first session's index,
// the sessions, then (a) the table, the entries, the preimages, the finals / (b) the entry, the signed result.
import { Writer, Reader } from './encode.js';
import { toHex, fromHex } from './hash.js';
import { TYPE_NAMED_CLAIM_EVIDENCE } from './constants.js';
import { SLASH_PROOF_BYTES, decodeSlashProof, tableAgainstFinals } from './slash.js';
import { encodeEntryContract, decodeEntryContract, entryId as entryIdOf, roundId as roundIdOf } from './contracts.js';
import { decodePlayerResult, resultId, splitSignedResult } from './result.js';
import { isQualifier, VOID } from './payout.js';
import { decodeSettlementTable, settlementTableId } from './settlement-ack.js';
import { isAttested, payoutRuleForRound } from './manifest.js';
import { offTableClaims, forfeitsOfLostEntries, OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from './named-claim-offence.js';

export const NAMED_ROW_OFF_TABLE = 1;
export const NAMED_ROW_FORFEIT = 2;
const ZERO32 = new Uint8Array(32);
const nhex = (b) => toHex(b);
const nlow = (x) => String(x || '').toLowerCase();
const nlong = (w, b) => { w.u32(b.length); w.bytes(b); };
const nlongOf = (r) => r.bytes(r.u32());

/** The tool's outpoint text of an entry's lock outpoint, or null for none. */
export const namedOutpointText = (o) => (o && o.txid instanceof Uint8Array && o.txid.some((x) => x) ? `${nhex(o.txid)}:${String(o.outIdx)}` : null);

export function namedClaimEvidenceBytesOf(bytes, at = 0) {
  const lenAt = at + SLASH_PROOF_BYTES + 2;
  if (bytes[at + SLASH_PROOF_BYTES] !== TYPE_NAMED_CLAIM_EVIDENCE || bytes.length < lenAt + 4) throw new Error('not a proof of a named claim');
  return lenAt + 4 - at + new DataView(bytes.buffer, bytes.byteOffset + lenAt, 4).getUint32(0);
}

/**
 * `parts`: { row, config, firstSession, sessions: [bytes], table, entries, preimages, finals } for (a); { row, config, firstSession, sessions, entry, signedResult } for (b).
 */
export function joinNamedClaimEvidence(proofBytes, parts) {
  if (proofBytes.length !== SLASH_PROOF_BYTES) throw new Error(`a slash proof is ${SLASH_PROOF_BYTES} bytes, got ${proofBytes.length}`);
  const { row, config, firstSession, sessions } = parts;
  if (row !== NAMED_ROW_OFF_TABLE && row !== NAMED_ROW_FORFEIT) throw new Error('a named claim\'s proof is row (a) or row (b)');
  if (!Number.isSafeInteger(firstSession) || firstSession < 0) throw new Error('the first session is an index');
  const w = new Writer();
  nlong(w, config);
  w.u64(BigInt(firstSession));
  w.u32(sessions.length);
  for (const s of sessions) nlong(w, s);
  if (row === NAMED_ROW_OFF_TABLE) {
    nlong(w, parts.table);
    w.vec(parts.entries || [], (e, ww) => nlong(ww, encodeEntryContract(e)));
    w.vec(parts.preimages || [], (p, ww) => { ww.bytes32(p.entryId); ww.bytes32(p.preimage); });
    w.vec(parts.finals || [], (f, ww) => { nlong(ww, encodeEntryContract(f.entry)); nlong(ww, f.signedResult); ww.vec(f.finalSigs, (s, w2) => nlong(w2, s)); });
  } else {
    nlong(w, encodeEntryContract(parts.entry));
    nlong(w, parts.signedResult);
  }
  const rest = w.finish();
  const out = new Uint8Array(SLASH_PROOF_BYTES + 2 + 4 + rest.length);
  out.set(proofBytes, 0);
  out[SLASH_PROOF_BYTES] = TYPE_NAMED_CLAIM_EVIDENCE;
  out[SLASH_PROOF_BYTES + 1] = row;
  new DataView(out.buffer).setUint32(SLASH_PROOF_BYTES + 2, rest.length);
  out.set(rest, SLASH_PROOF_BYTES + 6);
  return out;
}

export function splitNamedClaimEvidence(bytes) {
  let n = -1; if (bytes instanceof Uint8Array) { try { n = namedClaimEvidenceBytesOf(bytes); } catch { n = -1; } }
  if (n < 0 || bytes.length !== n) throw new Error('that is not a published proof of a named claim');
  const proofBytes = bytes.subarray(0, SLASH_PROOF_BYTES);
  const row = bytes[SLASH_PROOF_BYTES + 1];
  if (row !== NAMED_ROW_OFF_TABLE && row !== NAMED_ROW_FORFEIT) throw new Error('a named claim\'s proof is row (a) or row (b)');
  const r = new Reader(bytes.subarray(SLASH_PROOF_BYTES + 6));
  const out = { proof: decodeSlashProof(proofBytes), proofBytes, row };
  out.config = nlongOf(r);
  const first = r.u64();
  if (first > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the first session is out of range');
  out.firstSession = Number(first);
  const count = r.u32();
  out.sessions = [];
  for (let i = 0; i < count; i++) out.sessions.push(nlongOf(r));
  if (row === NAMED_ROW_OFF_TABLE) {
    out.table = nlongOf(r);
    out.entries = r.vec((rr) => decodeEntryContract(nlongOf(rr)));
    out.preimages = r.vec((rr) => ({ entryId: rr.bytes32(), preimage: rr.bytes32() }));
    out.finals = r.vec((rr) => ({ entry: decodeEntryContract(nlongOf(rr)), signedResult: nlongOf(rr), finalSigs: rr.vec(nlongOf) }));
  } else {
    out.entry = decodeEntryContract(nlongOf(r));
    out.signedResult = nlongOf(r);
  }
  if (r.at !== bytes.length - SLASH_PROOF_BYTES - 6) throw new Error('trailing bytes after the proof of a named claim');
  return out;
}

/** What the judge hands the stake-lock tool's `arena-claim-read` (stdin): the proof's own bytes, hex. */
export const claimReadInput = ({ config, firstSession, sessions, roundId = null }) => ({
  config: nhex(config), firstSession, sessions: sessions.map(nhex), ...(roundId ? { roundId: nhex(roundId) } : {}),
});

/**
 * DOES THIS PROOF OF A NAMED CLAIM SLASH THIS BOND? `got` splitNamedClaimEvidence's answer; `read` the tool's arena-claim-read over got's sessions
 * (claimReadInput), or null where no tool runs here (then nothing is held: the caller answers "cannot say"); `contract` the round's, decoded;
 * `committee` the round's settlement seats (keys); `advert` the accused's advertisement; `verify(sig, msg, key)` BIP-340; `feesOf(federation hex)`;
 * `manifest` the round's game's; `rebuiltBodyId` (a) the judge's own rebuild of the shown table's body (hex), or null.
 * Returns { slashed: false, why } or { slashed: true, offence, bond, why }.
 */
export function slashHoldsOnNamedClaim({ got, read, contract, committee, advert, verify, feesOf = () => null, manifest = null, rebuiltBodyId = null }) {
  const no = (why) => ({ slashed: false, why });
  if (!got || !got.proof) return no('no proof');
  const { proof } = got;
  if (!Array.isArray(committee) || !committee.some((k) => nhex(k) === nhex(proof.nodePubkey)))
    return no(`${nhex(proof.nodePubkey)} is not a settlement seat of this round, so no lock of it names that key`);
  let rid;
  try { rid = roundIdOf(contract); } catch (e) { return no(`the contract does not encode: ${e.message}`); }
  if (nhex(rid) !== nhex(proof.roundId)) return no('the contract handed in is not this round\'s');
  if (!read || read.mode !== 'arena-claim-read') return no('the sessions were not read');
  if (Array.isArray(read.unverified) && read.unverified.length) return no(`sessions ${read.unverified.slice(0, 4).join(', ')} do not verify against the federation's keys`);
  if (Number(read.first_session) !== got.firstSession || Number(read.sessions) !== got.sessions.length) return no('the sessions read are not the proof\'s');
  const txid = nhex(proof.signedResultId);
  const accused = nhex(proof.nodePubkey);
  const spends = (read.spends || []).filter((s) => nlow(s.txid) === txid && s.lock && nlow(s.lock.round_id) === nhex(rid));
  if (!spends.length) return no(`no accepted transaction ${txid.slice(0, 16)} in those sessions spends an Arena lock of this round funded there`);
  const fid = nlow(read.federation_id);
  let held;
  if (got.row === NAMED_ROW_OFF_TABLE) {
    let table;
    try { table = decodeSettlementTable(got.table); } catch (e) { return no(`the table shown does not decode: ${e.message}`); }
    if (nhex(settlementTableId(table)) !== nhex(proof.transcriptHash)) return no('the table shown is not the one the proof names');
    if (nhex(table.roundId) !== nhex(rid)) return no('the table shown is of another round');
    const home = table.federationId && table.federationId.some((x) => x) ? nhex(table.federationId) : nhex(contract.federationId);
    if (fid !== home) return no(`the sessions are federation ${fid.slice(0, 16)}'s, and the table settles in ${home.slice(0, 16)}`);
    const attested = !!manifest && isAttested(manifest);
    const rule = attested ? { ok: true, payoutShares: null } : payoutRuleForRound(contract, manifest);
    if (!rule.ok) return no(`F's payout rule cannot be read: ${rule.why}`);
    const reading = tableAgainstFinals({ claimed: table, roundId: rid, contract, attested, payoutShares: rule.payoutShares, entries: got.entries, finals: got.finals, committee, verify, feesOf });
    if (!reading.ok) return no(`the table shown cannot be read: ${reading.why}`);
    if (reading.differs.length) return no(`the table shown is not a correct table: ${reading.differs[0]}`);
    if (!reading.complete) return no('the table shown is not shown to be exactly F: not every row has a threshold of FINALs');
    if (!rebuiltBodyId) return no('the correct table\'s body was not rebuilt');
    const ours = new Set(table.claims.map((c) => `${nhex(c.outpoint.txid)}:${String(c.outpoint.outIdx)}`));
    if (!spends.some((s) => s.kind === 'claim' && ours.has(nlow(s.outpoint)))) return no('that transaction claims no lock the round\'s table claims');
    const rebuilt = rebuiltBodyId instanceof Uint8Array ? nhex(rebuiltBodyId) : nlow(rebuiltBodyId);
    const found = offTableClaims({ spends, roundId: nhex(rid), correctBodyIds: [rebuilt] }).find((x) => x.txid === txid);
    if (!found) return no(`transaction ${txid.slice(0, 16)} is the rebuild of the correct table`);
    if (!found.offenders.includes(accused)) return no('the accused is not a named signer of that claim');
    held = { offence: OFF_TABLE_CLAIM, why: `the node is a named signer of claim ${txid.slice(0, 16)}: ${found.why}` };
  } else {
    const entry = got.entry;
    let eid;
    try { eid = nhex(entryIdOf(entry)); } catch (e) { return no(`the entry does not encode: ${e.message}`); }
    if (eid !== nhex(proof.transcriptHash)) return no('the entry shown is not the one the proof names');
    if (nhex(entry.roundId) !== nhex(rid)) return no('the entry shown is of another round');
    if (nhex(entry.playerPubkey) !== nhex(proof.playerPubkey)) return no('the proof names another player than the entry');
    const home = entry.federationId && entry.federationId.some((x) => x) ? nhex(entry.federationId) : nhex(contract.federationId);
    if (fid !== home) return no(`the sessions are federation ${fid.slice(0, 16)}'s, and the entry locked in ${home.slice(0, 16)}`);
    let body, signature;
    try { const s = splitSignedResult(got.signedResult); body = decodePlayerResult(s.body); signature = s.signature; }
    catch (e) { return no(`the result shown does not decode: ${e.message}`); }
    if (nhex(body.nodePubkey) !== accused) return no('the result shown was signed by another node');
    if (nhex(body.roundId) !== nhex(rid) || nhex(body.playerPubkey) !== nhex(entry.playerPubkey)) return no('the result shown is not of that entry');
    let theirs = false;
    try { theirs = typeof verify === 'function' && verify(signature, resultId(body), proof.nodePubkey) === true; } catch { theirs = false; }
    if (!theirs) return no('the signature on the result is not the accused node\'s');
    if (body.outcome === VOID) return no('a VOID is not a lost result');
    if (isQualifier(body, contract.minScore)) return no('the accused signed that entry as a qualifier');
    const locks = new Set([namedOutpointText(entry.stakeLockOutpoint), namedOutpointText(entry.feeLockOutpoint)].filter(Boolean));
    const found = forfeitsOfLostEntries({ spends: spends.filter((s) => locks.has(nlow(s.outpoint))), entryOf: () => eid, lostBy: () => [accused] });
    if (!found.length) return no('that transaction forfeits no lock of the entry naming the accused');
    held = { offence: FORFEIT_OF_LOST_ENTRY, why: `the node is a named signer of forfeit ${txid.slice(0, 16)} of entry ${eid.slice(0, 16)}, which it signed ${body.outcome}` };
  }
  if (!advert || nhex(advert.nodePubkey) !== accused) return no('no advertisement from the accused node to name its bond');
  if (nhex(advert.bondTxid) !== nhex(proof.bondTxid) || advert.bondVout !== proof.bondVout)
    return no(`the proof names bond ${nhex(proof.bondTxid)}:${proof.bondVout} and the node advertised ${nhex(advert.bondTxid)}:${advert.bondVout}`);
  return { slashed: true, offence: held.offence, bond: { txid: proof.bondTxid, vout: proof.bondVout }, why: held.why };
}

/** The proof body of a named claim's offence: what the filer signs nothing of, and the judge reads first. */
export function namedClaimProofBody({ row, roundId, accused, spendTxid, tableId = null, entry = null, advert }) {
  return {
    roundId, nodePubkey: accused, signedResultId: fromHex(spendTxid),
    playerPubkey: row === NAMED_ROW_FORFEIT ? entry.playerPubkey : ZERO32,
    transcriptHash: row === NAMED_ROW_FORFEIT ? entryIdOf(entry) : tableId,
    bondTxid: advert.bondTxid, bondVout: advert.bondVout,
  };
}
