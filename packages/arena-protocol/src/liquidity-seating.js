// THE LIQUIDITY SEATING OF AN EPOCH, SIGNED BY THE GUARDIANS (spec §23A.10, kanban #494): each guardian lists the liquidity providers
// of its federation - a channel of at least L to one of its custody nodes, free balance at or above the deposit minimum - with their
// weights, and signs it; a seating stands when at least the federation's threshold of its seated guardians signed the same list for
// the same epoch. A 2026.0.16 round's settlement pays the liquidity quarter only from a standing seating, by its weights.
// THE WEIGHTS ARE FLOORED TO L (100,000 sat testnet4, 250,000 mainnet) here: free balances move by the minute, and guardians reading a
// few minutes apart must still sign the same list to reach the threshold.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';
import { liquidityWeight, LIQUIDITY_TERMS } from './liquidity.js';

export const LIQUIDITY_SEATING_TAG = 'BLWP/v1/LIQUIDITY_SEATING';

const norm = (providers) => [...providers].map((p) => ({ node: String(p.node).toLowerCase(), weight: String(p.weight) })).sort((a, b) => (a.node < b.node ? -1 : 1));

/** The 32 bytes a seating's signatures cover: the federation, the epoch, the providers (node keys, sorted) with their weights. */
export function liquiditySeatingHash({ federationId, epoch, providers }) {
  const w = new Writer();
  w.bytes32(fromHex(federationId)); w.u32(epoch);
  w.vec(norm(providers), (p, ww) => { ww.bytes32(fromHex(p.node)); ww.u64(BigInt(p.weight)); });
  return taggedHash(LIQUIDITY_SEATING_TAG, w.finish());
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
export function liquiditySeatingFrom({ claims, federationLnKeys, network = 'testnet4' }) {
  const L = LIQUIDITY_TERMS[network].channelSats, keys = new Set(federationLnKeys);
  return claims.filter((c) => c.channels.some((x) => keys.has(x.peer) && BigInt(x.capacitySats) >= L))
    .map((c) => ({ node: c.node, weight: (liquidityWeight(c, federationLnKeys, network) / L) * L }))
    .filter((p) => p.weight > 0n);
}

/** Whether signed seatings make one that stands: the list signed by the most seated guardians, if at least the threshold. */
export function standingLiquiditySeating({ signed = [], federationId, epoch, seated, threshold, verify }) {
  const allowed = new Set((seated || []).map((k) => String(k).toLowerCase()));
  const byBody = new Map();
  for (const s of signed) {
    if (!s || String(s.federationId).toLowerCase() !== String(federationId).toLowerCase() || s.epoch !== epoch || !allowed.has(String(s.guardian).toLowerCase())) continue;
    let good = false;
    try { good = verify(fromHex(s.signature), liquiditySeatingHash(s), fromHex(s.guardian)); } catch { good = false; }
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
