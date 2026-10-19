// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROTOCOL RESERVES' BOOK (§27A.9.22026-10-16: "Every node serves GET /reserves: the total
// held, by federation, the last rounds' payments in ... all from its own store, as /donations is"). A version-11 entry's reserve
// output is checked and kept as a row (donation_outputs, under the federation's reserve key) only by the signer nodes its lock
// is handed to; every other seat learns it from them and KEEPS IT ONLY ONCE ITS OWN FEDERATION PORT SAYS SO - the federation
// holds, at that outpoint, the payout contract to that reserve key for exactly that amount (the check /lock makes). So each
// seat's figures are its own store's, and every seat that reaches the federation comes to the same total.
//
//   reserveFigures(rows, ...)     one federation's held total, entry count and the last payments in, newest first
//   verifyPeerReserveRow(...)     a row another seat listed, checked with the federation: the row to keep, or why not
import { donationContractFields } from './stake-lock-signer-node.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

/** The payments in that GET /reserves lists per federation (all of them with ?all=1). */
export const RESERVES_LAST = 50;

const isHex = (s, n) => typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s);

/**
 * ONE FEDERATION'S RESERVES from its rows (round.donationsFor(reserve key), oldest first): { heldMsat, entries, paidIn } - the
 * held total (a string of msat), how many entries paid in, and the last `last` payments, newest first, each with the round's
 * game when `gameOf(roundHex)` names one. Rows of another federation are not counted.
 */
export function reserveFigures(rows, { federationId, last = RESERVES_LAST, gameOf = () => null } = {}) {
  const mine = (rows || []).filter((r) => !federationId || r.federationId === federationId);
  const heldMsat = mine.reduce((t, r) => t + BigInt(r.amountMsat), 0n);
  const shown = last === Infinity ? mine : mine.slice(-last);
  return { heldMsat: String(heldMsat), entries: mine.length,
    paidIn: shown.slice().reverse().map((r) => ({ outpoint: r.outpoint, roundId: r.roundId, entryId: r.entryId, amountMsat: String(r.amountMsat),
      at: new Date(r.verifiedMs).toISOString(), game: gameOf(r.roundId) || null, image: r.senderOnContract && r.playerKey ? r.playerKey : null,
      ...(r.item ? { item: r.item } : {}) })) };
}

/**
 * A RESERVE ROW ANOTHER SEAT LISTED, CHECKED HERE: `row` as GET /reserves lists it, `port` this seat's port into the row's
 * federation, `reserveKey` that federation's 33-byte reserve key. Answers { ok, row } - in the shape putDonationOutputs
 * keeps - or { ok: false, why }. The contract may carry the entry's player key as its image (pages from 0.0.2751) or zeros.
 */
export async function verifyPeerReserveRow({ row, port, reserveKey, federationId }) {
  if (!row || typeof row.outpoint !== 'string') return { ok: false, why: 'a row names its outpoint' };
  const [txHex, idx] = row.outpoint.split(':');
  if (!isHex(txHex, 32) || !/^\d+$/.test(idx || '')) return { ok: false, why: `${row.outpoint} is no outpoint` };
  if (!isHex(row.roundId, 32) || !isHex(row.entryId, 32)) return { ok: false, why: 'a row names its round and entry' };
  let amountMsat;
  try { amountMsat = BigInt(row.amountMsat); } catch { return { ok: false, why: 'a row names its amount in msat' }; }
  if (amountMsat < 1n) return { ok: false, why: 'a reserve payment is at least 1 msat' };
  if (row.image !== null && row.image !== undefined && !isHex(row.image, 32)) return { ok: false, why: 'an image is a 32-byte key' };
  if (!port) return { ok: false, why: 'this seat reaches no port into that federation' };
  if (!(reserveKey instanceof Uint8Array) || reserveKey.length !== 33) return { ok: false, why: 'no reserve key is known for that federation' };
  const outpoint = { txid: fromHex(txHex), outIdx: BigInt(idx) };
  const image = row.image ? fromHex(row.image) : null;
  const [st, zeroId, keyedId] = await Promise.all([port.status(outpoint), port.contractId(donationContractFields({ recipientPk: reserveKey, amountMsat })),
    image ? port.contractId(donationContractFields({ recipientPk: reserveKey, amountMsat, image })) : Promise.resolve(null)]);
  if (!st || !st.stored) return { ok: false, why: `the federation holds nothing at ${txHex.slice(0, 16)}…:${idx}` };
  const stored = String(st.stored.contractId);
  const senderOnContract = keyedId !== null && String(keyedId) === stored;
  if (!senderOnContract && String(zeroId) !== stored) return { ok: false, why: `the output at ${txHex.slice(0, 16)}…:${idx} is not ${amountMsat} msat to the reserve key` };
  return { ok: true, row: { outpoint, entryId: fromHex(row.entryId), roundId: fromHex(row.roundId), federationId, recipientPk: reserveKey,
    amountMsat, contractId: stored, senderOnContract, image: senderOnContract ? row.image : null,
    ...(typeof row.item === 'string' && row.item.length <= 120 ? { item: row.item } : {}) } };
}
