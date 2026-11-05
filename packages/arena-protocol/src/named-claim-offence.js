// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OFFENCE ROWS (a) AND (b) OF THE NAMED CLAIM (§5A.3, protocol 27, kanban #1044 B1, ruling #1131 4): both on bytes the accused signed.
//
//   (a) OFF_TABLE_CLAIM        being a named signer of an accepted claim whose transaction is not the rebuild of a correct table for its round.
//                              Proof: the federation's threshold-signed session outcome holding the transaction (await_signed_session_outcome,
//                              checked against the guardians' keys) + what the table row reads. Read exactly as the table row reads an acked
//                              pair, with the transaction in place of ack + table: a transaction a correct table rebuilds to - the round's
//                              own, or a late table's claiming only its own entry's locks - is never an offence, whoever acked what.
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
 * ROW (a). `spends` the reader's list; `roundId` hex; `correctTxids` every txid a correct table of the round rebuilds to (the round's settlement
 * and each late table's). Answers [{ offence, txid, session, signers, offenders: [node key hex] }] - one per off-table claim transaction of the
 * round, its named signers the offenders. A claim whose lock's funding was not read (no round id) is not judged: the proof must carry it.
 */
export function offTableClaims({ spends, roundId, correctTxids }) {
  const correct = new Set([...(correctTxids || [])].map(low));
  const round = low(roundId);
  const byTx = new Map();
  for (const s of spends || []) {
    if (s.kind !== 'claim' || !s.lock || low(s.lock.round_id) !== round) continue;
    if (correct.has(low(s.txid))) continue;
    const t = byTx.get(s.txid) || { offence: OFF_TABLE_CLAIM, txid: low(s.txid), session: s.session, signers: s.signers, offenders: new Set() };
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
