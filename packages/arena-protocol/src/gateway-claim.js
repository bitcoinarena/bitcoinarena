// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE STANDS FOR A GATEWAY SEAT (spec §23A.9): its gateway claim, signed by its node key - which federation, where its
// gateway answers (its public address /gateway/), its Lightning node key, the public channel capacity and peg-in it states, when. Its
// seat serves it (GET /gateway-claim); the federation's guardians read it, probe the gateway it names, and rank the claims (gateway-
// seats.js). What a guardian can check itself it checks (the signature, the node being seated, the gateway serving the federation);
// capacity and peg-in are stated here and stand only while the gateway's routed volume does not contradict them.
// INBOUND AND OUTBOUND APART (2026-10-18, on the installer's LND: "Does the [LND] we setup have incoming liquidity?" - it had none):
// a deposit reaches the federation through the gateway's INBOUND liquidity, a payout leaves through its OUTBOUND, so a claim states
// both (the remote and the local balance of its public channels), and the address its LND takes peer connections at (host:port,
// empty when it takes none) - the federation's channel ring (custody-agent.js) dials it. outsideInboundSats: the inbound from peers OUTSIDE
// the federation ("only connected between them with nothing outside it's no good") - the part a seat's deposit minimum counts.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex } from './hash.js';

export const GATEWAY_CLAIM_TAG = 'BLWP/v1/GATEWAY_CLAIM';

/** The 32 bytes a claim's signature covers. */
export function gatewayClaimHash(c) {
  const w = new Writer();
  w.bytes32(fromHex(c.node)); w.bytes32(fromHex(c.federationId));
  w.str(String(c.gatewayUrl)); w.bytes(fromHex(c.lightningPubkey), 33);
  w.u64(BigInt(c.capacitySats)); w.u64(BigInt(c.pegInSats)); w.u64(BigInt(c.atMs));
  w.u64(BigInt(c.inboundSats)); w.u64(BigInt(c.outboundSats)); w.str(String(c.lightningAddr || '')); w.u64(BigInt(c.outsideInboundSats || 0));
  return taggedHash(GATEWAY_CLAIM_TAG, w.finish());
}

/** A claim, signed with `sign(hash32) -> signature64` by the node key `node` (hex). */
export function signGatewayClaim(fields, sign) {
  const c = { node: String(fields.node).toLowerCase(), federationId: String(fields.federationId).toLowerCase(), gatewayUrl: String(fields.gatewayUrl),
    lightningPubkey: String(fields.lightningPubkey).toLowerCase(), capacitySats: String(fields.capacitySats), pegInSats: String(fields.pegInSats), atMs: String(fields.atMs),
    inboundSats: String(fields.inboundSats ?? 0), outboundSats: String(fields.outboundSats ?? 0), lightningAddr: String(fields.lightningAddr || ''),
    outsideInboundSats: String(fields.outsideInboundSats ?? 0) };
  return { ...c, signature: toHex(sign(gatewayClaimHash(c))) };
}

/** Whether `c` is a well-formed claim signed by its node. `verify(sig, hash, key)`. Answers { ok, why }. */
export function checkGatewayClaim(c, verify) {
  if (!c || !/^[0-9a-f]{64}$/.test(c.node || '') || !/^[0-9a-f]{64}$/.test(c.federationId || '')) return { ok: false, why: 'a claim names a node key and a federation id' };
  if (!/^https?:\/\/\S+\/$/.test(c.gatewayUrl || '')) return { ok: false, why: 'a claim names its gateway\'s address, ending in /' };
  if (!/^0[23][0-9a-f]{64}$/.test(c.lightningPubkey || '')) return { ok: false, why: 'a claim names its Lightning node key' };
  if (!/^(|([a-z0-9-]+\.)*[a-z0-9-]+:\d{1,5}|\[[0-9a-f:]+\]:\d{1,5})$/i.test(String(c.lightningAddr ?? ''))) return { ok: false, why: 'a claim\'s Lightning address is host:port, or empty' };
  for (const k of ['capacitySats', 'pegInSats', 'atMs', 'inboundSats', 'outboundSats', 'outsideInboundSats']) if (!/^\d+$/.test(String(c[k] || ''))) return { ok: false, why: `a claim's ${k} is a whole number` };
  if (!/^[0-9a-f]{128}$/.test(c.signature || '')) return { ok: false, why: 'a claim is signed' };
  let good = false;
  try { good = verify(fromHex(c.signature), gatewayClaimHash(c), fromHex(c.node)); } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: 'the claim is not signed by its node key' };
}
