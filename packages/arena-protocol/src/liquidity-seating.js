// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LIQUIDITY SEATING OF AN EPOCH, SIGNED BY THE GUARDIANS (spec §23A.10): each guardian lists the liquidity providers
// of its federation - a channel of at least L to one of its custody nodes, free balance at or above the deposit minimum - with their
// weights, and signs it; a seating stands when at least the federation's threshold of its seated guardians signed the same list for
// the same epoch. A 2026.0.16 round's settlement pays the liquidity quarter only from a standing seating, by its weights.
// THE WEIGHTS ARE FLOORED TO L (100,000 sat testnet4, 250,000 mainnet) here: free balances move by the minute, and guardians reading a
// few minutes apart must still sign the same list to reach the threshold.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { liquidityWeight, LIQUIDITY_TERMS } from './liquidity.js';
import { tagAt, tagsAccepted, TAG_PAIRS } from './tag-switch.js';

export const LIQUIDITY_SEATING_TAG = TAG_PAIRS.liquiditySeating[0];   // the tag before the switch (tag-switch.js, kanban #525)

const norm = (providers) => [...providers].map((p) => ({ node: String(p.node).toLowerCase(), weight: String(p.weight) })).sort((a, b) => (a.node < b.node ? -1 : 1));

/** The 32 bytes a seating's signatures cover: the federation, the epoch, the providers (node keys, sorted) with their weights. */
export function liquiditySeatingHash({ federationId, epoch, providers }, tag = tagAt('liquiditySeating', { epoch })) {
  const w = new Writer();
  w.bytes32(fromHex(federationId)); w.u32(epoch);
  w.vec(norm(providers), (p, ww) => { ww.bytes32(fromHex(p.node)); ww.u64(BigInt(p.weight)); });
  return taggedHash(tag, w.finish());
}

/** One guardian's signature on a seating. */
export function signLiquiditySeating(seating, guardianNode, sign) {
  const s = { federationId: seating.federationId.toLowerCase(), epoch: seating.epoch, providers: norm(seating.providers) };
  return { ...s, guardian: String(guardianNode).toLowerCase(), signature: toHex(sign(liquiditySeatingHash(s))) };
}

/**
 * A guardian's list from the providers' claims (checked) and its federation's custody nodes' LND keys: every provider with a channel of
 * at least L to one of them and a weight above 0 (its free balance at or above the deposit minimum), its weight floored to L.
 */
export function liquiditySeatingFrom({ claims, federationLnKeys, network = 'testnet4', proven = null }) {
  const L = LIQUIDITY_TERMS[network].channelSats, keys = new Set(federationLnKeys);
  // `proven` (Map node -> sats, provenFreeSats): the free balance this guardian's chain confirms; without it, the claimed one
  const free = (c) => (proven ? (proven.get(c.node) || 0n) : BigInt(c.freeSats));
  return claims.filter((c) => c.channels.some((x) => keys.has(x.peer) && BigInt(x.capacitySats) >= L))
    .map((c) => ({ node: c.node, weight: (liquidityWeight(c, federationLnKeys, network, free(c)) / L) * L }))
    .filter((p) => p.weight > 0n);
}

/** Whether signed seatings make one that stands: the list signed by the most seated guardians, if at least the threshold. */
export function standingLiquiditySeating({ signed = [], federationId, epoch, seated, threshold, verify }) {
  const allowed = new Set((seated || []).map((k) => String(k).toLowerCase()));
  const byBody = new Map();
  for (const s of signed) {
    if (!s || String(s.federationId).toLowerCase() !== String(federationId).toLowerCase() || s.epoch !== epoch || !allowed.has(String(s.guardian).toLowerCase())) continue;
    let good = false;
    try { good = tagsAccepted('liquiditySeating', { epoch: s.epoch }).some((t) => verify(fromHex(s.signature), liquiditySeatingHash(s, t), fromHex(s.guardian))); } catch { good = false; }
    if (!good) continue;
    const providers = norm(s.providers);
    const key = providers.map((p) => `${p.node}:${p.weight}`).join(',');
    const row = byBody.get(key) || { providers, signers: new Set() };
    row.signers.add(String(s.guardian).toLowerCase());
    byBody.set(key, row);
  }
  const best = [...byBody.values()].sort((a, b) => b.signers.size - a.signers.size)[0];
  if (!best || best.signers.size < threshold) return { ok: false, signers: best ? best.signers.size : 0, why: `no liquidity seating for epoch ${epoch} is signed by ${threshold} of the seated guardians` };
  return { ok: true, seating: { federationId: String(federationId).toLowerCase(), epoch, providers: best.providers }, signers: best.signers.size };
}
