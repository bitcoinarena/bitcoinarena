// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OFFENCE ROWS (a) AND (b) OF THE NAMED CLAIM (§5A.3, protocol 27, kanban #1044 B1, ruling #1131 4): both on bytes the accused signed.
//
//   (a) OFF_TABLE_CLAIM        being a named signer of an accepted claim whose transaction is not the rebuild of a correct table for its round.
//                              Proof: the federation's threshold-signed session outcome holding the transaction (await_signed_session_outcome,
//                              checked against the guardians' keys) + what the table row reads. Read exactly as the table row reads an acked
//                              pair, with the transaction in place of ack + table, on its SETTLEMENT BODY ID (ruling #1135): a transaction whose
//                              body a correct table builds - the round's own per federation, or a late table's claiming only its own entry's
//                              locks - is never an offence, whoever acked what.
//   (b) FORFEIT_OF_LOST_ENTRY  being a named signer of a forfeit of a lock whose entry the accused signed a non-qualifying result for.
//                              Proof: the forfeit (session outcome, as above) + the accused's own signed result. An ENTRY_VOID on a seat's own
//                              clock is not that seat's lost result.
//
// The spends come from the stake-lock tool's `arena-claim-read` (the sessions verified against the federation's keys there); the correct
// table's txids from the seat's own table reader; a signed result's check is the caller's. Pure.
import { toHex } from './hash.js';

export const OFF_TABLE_CLAIM = 'OFF_TABLE_CLAIM';
export const FORFEIT_OF_LOST_ENTRY = 'FORFEIT_OF_LOST_ENTRY';
export const NAMED_CLAIM_OFFENCES = Object.freeze([OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY]);

const low = (x) => String(x || '').toLowerCase();
const keyHex = (k) => (k instanceof Uint8Array ? toHex(k) : low(k));

/**
 * ROW (a), as ruling #1135 2 reads it. `spends` the reader's list (each claim carries its transaction's `body_id`: the accepted transaction with its
 * claims' signer lists emptied and every output key equal to KeyAgg(claim_keys[S]) written as Z, and `one_signer_set`); `roundId` hex;
 * `correctBodyIds` the body ids a correct table of the round builds (its settlement per federation, and each late table's). The accepted transaction
 * is an offence when its claims name different signer sets (false by itself), or when its body id is none of the correct ones - which catches both
 * another key where the signers' refund key belongs and the signers' key where a player's belongs. A transaction a correct table builds to is never
 * an offence, whoever acked what. Answers [{ offence, txid, session, signers, bodyId, why, offenders: [node key hex] }], the named signers the offenders.
 * A claim whose lock's funding was not read (no round id, so no keys and no body id) is not judged: the proof must carry it.
 */
export function offTableClaims({ spends, roundId, correctBodyIds }) {
  const correct = new Set([...(correctBodyIds || [])].map(low));
  const round = low(roundId);
  const byTx = new Map();
  for (const s of spends || []) {
    if (s.kind !== 'claim' || !s.lock || low(s.lock.round_id) !== round) continue;
    const mixed = s.one_signer_set === false;
    if (!mixed && (!s.body_id || correct.has(low(s.body_id)))) continue;
    const t = byTx.get(s.txid) || { offence: OFF_TABLE_CLAIM, txid: low(s.txid), session: s.session, signers: s.signers, bodyId: s.body_id ? low(s.body_id) : null,
      why: mixed ? 'its claims name different signer sets' : 'its body is not the body of a correct table', offenders: new Set() };
    for (const k of s.named_keys || []) t.offenders.add(low(k));
    byTx.set(s.txid, t);
  }
  return [...byTx.values()].map((t) => ({ ...t, offenders: [...t.offenders].sort() }));
}

/**
 * ROW (b). `spends` the reader's list; `entryOf(outpoint)` the entry id (hex) whose lock that is, or null; `lostBy(entryIdHex)` the node keys (hex)
 * whose own signed result for that entry is non-qualifying - an ENTRY_VOID is not one. Answers [{ offence, txid, outpoint, entryId, offenders }]:
 * the named signers of each forfeit who signed that entry as lost. A seat that signed nothing of the kind is not named, whoever it forfeited with.
 */
export function forfeitsOfLostEntries({ spends, entryOf, lostBy }) {
  const out = [];
  for (const s of spends || []) {
    if (s.kind !== 'cancel') continue;
    const entryId = entryOf(s.outpoint);
    if (!entryId) continue;
    const lost = new Set([...(lostBy(low(entryId)) || [])].map(keyHex));
    const offenders = (s.named_keys || []).map(low).filter((k) => lost.has(k)).sort();
    if (offenders.length) out.push({ offence: FORFEIT_OF_LOST_ENTRY, txid: low(s.txid), session: s.session, outpoint: s.outpoint, entryId: low(entryId), offenders });
  }
  return out;
}
