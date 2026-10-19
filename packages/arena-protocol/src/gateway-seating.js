// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY SEATING OF AN EPOCH, SIGNED BY THE GUARDIANS (spec §23A.9, kanban #471): each guardian ranks its federation's gateway
// claims (gateway-seats.js) on the epoch it measured and signs the seats it got; a seating stands when at least the federation's
// threshold of its seated guardians signed the same seats for the same epoch. Kept apart from the federation record on purpose: a
// guardian that measured differently only fails to add its signature here, and the record (status, exposure) is never held up by
// it. With no standing seating for an epoch there are no gateway seats in it, and the guardian pool stays the guardians' (fee.js).
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';

export const GATEWAY_SEATING_TAG = 'BLWP/v1/GATEWAY_SEATING';

/** The 32 bytes a seating's signatures cover: the federation, the epoch, the seats (node keys, sorted). */
export function gatewaySeatingHash({ federationId, epoch, seats }) {
  const w = new Writer();
  w.bytes32(fromHex(federationId)); w.u32(epoch);
  w.vec([...seats].map((s) => String(s).toLowerCase()).sort(), (s, ww) => ww.bytes32(fromHex(s)));
  return taggedHash(GATEWAY_SEATING_TAG, w.finish());
}

/** One guardian's signature on a seating. */
export function signGatewaySeating(seating, guardianNode, sign) {
  return { federationId: seating.federationId.toLowerCase(), epoch: seating.epoch, seats: [...seating.seats].map((s) => s.toLowerCase()).sort(),
    guardian: String(guardianNode).toLowerCase(), signature: toHex(sign(gatewaySeatingHash(seating))) };
}

/**
 * Whether signed seatings make one that stands: `signed` [{ federationId, epoch, seats, guardian, signature }], `seated` the
 * federation's seated guardians (node keys hex), `threshold`. Answers { ok, seating: { federationId, epoch, seats }, signers, why } -
 * the seats signed by the most guardians, if they are at least the threshold.
 */
export function standingSeating({ signed = [], federationId, epoch, seated, threshold, verify }) {
  const allowed = new Set((seated || []).map((k) => String(k).toLowerCase()));
  const byBody = new Map();
  for (const s of signed) {
    if (!s || String(s.federationId).toLowerCase() !== String(federationId).toLowerCase() || s.epoch !== epoch || !allowed.has(String(s.guardian).toLowerCase())) continue;
    let good = false;
    try { good = verify(fromHex(s.signature), gatewaySeatingHash(s), fromHex(s.guardian)); } catch { good = false; }
    if (!good) continue;
    const key = [...s.seats].map((x) => String(x).toLowerCase()).sort().join(',');
    const row = byBody.get(key) || { seats: key ? key.split(',') : [], signers: new Set() };
    row.signers.add(String(s.guardian).toLowerCase());
    byBody.set(key, row);
  }
  const best = [...byBody.values()].sort((a, b) => b.signers.size - a.signers.size)[0];
  if (!best || best.signers.size < threshold)
    return { ok: false, signers: best ? best.signers.size : 0, why: `no seating for epoch ${epoch} is signed by ${threshold} of the federation's seated guardians (at most ${best ? best.signers.size : 0}): no gateway seats in it` };
  return { ok: true, seating: { federationId: String(federationId).toLowerCase(), epoch, seats: best.seats }, signers: best.signers.size,
    why: `${best.signers.size} of the seated guardians signed ${best.seats.length} gateway seat${best.seats.length === 1 ? '' : 's'} for epoch ${epoch}` };
}
