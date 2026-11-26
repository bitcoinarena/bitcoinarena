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
import { taggedHash, fromHex, toHex, sha256 } from './hash.js';
import { utf8Encode } from './utf8.js';
import { tagAt, tagsAccepted, TAG_PAIRS } from './tag-switch.js';

export const GATEWAY_CLAIM_TAG = TAG_PAIRS.gatewayClaim[0];   // the tag before the switch (tag-switch.js, kanban #525)

/** The 32 bytes a claim's signature covers - under the tag of its atMs, or `tag`. */
export function gatewayClaimHash(c, tag = tagAt('gatewayClaim', { ms: c.atMs })) {
  const w = new Writer();
  w.bytes32(fromHex(c.node)); w.bytes32(fromHex(c.federationId));
  w.str(String(c.gatewayUrl)); w.bytes(fromHex(c.lightningPubkey), 33);
  w.u64(BigInt(c.capacitySats)); w.u64(BigInt(c.pegInSats)); w.u64(BigInt(c.atMs));
  w.u64(BigInt(c.inboundSats)); w.u64(BigInt(c.outboundSats)); w.str(String(c.lightningAddr || '')); w.u64(BigInt(c.outsideInboundSats || 0));
  // ITS PEG-IN OUTPOINTS, WHEN IT NAMES ANY (spec §23A.3a "What counts as the peg-in"; kanban #559/#543): signed with the rest; a claim that
  // names none hashes as before, so the claims already out keep their signatures
  const outs = pegInOutpointsOf(c);
  // ITS LIGHTNING-KEY PROOF, WHEN IT CARRIES ONE (kanban #3739): signed with the rest, after the outpoints (their count written even when
  // it is 0, so the two never read as each other); a claim without one hashes as before
  const proof = lightningProofOf(c);
  if (outs.length || proof) { w.u32(outs.length); for (const o of outs) w.str(o); }
  if (proof) w.str(proof);
  return taggedHash(tag, w.finish());
}

/** A claim's peg-in outpoints, `txid:vout` as an explorer prints them, sorted and once each ([] when it names none). */
export function pegInOutpointsOf(c) {
  const list = Array.isArray(c && c.pegInOutpoints) ? c.pegInOutpoints.map((x) => String(x).toLowerCase()) : [];
  return [...new Set(list.filter((x) => /^[0-9a-f]{64}:\d{1,6}$/.test(x)))].sort();
}

// THE GATEWAY IS THE NODE'S BECAUSE ITS LIGHTNING KEY SAYS SO (spec §23A.9 "The Lightning-key proof", kanban #3739; owner ruling
// 2026-11-25). A claim's gatewayUrl and lightningPubkey are the node's own word, so a seated guardian could sign a claim naming an
// honest operator's gateway and, probed first, take its seat, volume and fee share (#2422 held a gateway for the first node that named
// it). The proof ties the gateway to one node key: the gateway's Lightning node key signs (claiming node key, federation id, gateway URL)
// in LND's signmessage format (POST /v1/signmessage - the custody agent asks its own LND, which holds that key). A guardian checks it
// against claim.lightningPubkey, and checks that the gateway's routing_info answers that same Lightning key.
export const GATEWAY_LN_PROOF_TAG = 'ARENA/v1/GATEWAY_LN_PROOF';
/** The message the gateway's Lightning key signs for a claim of `node` in `federationId` at `gatewayUrl`. */
export const gatewayLnProofMessage = (node, federationId, gatewayUrl) =>
  `${GATEWAY_LN_PROOF_TAG}:${String(node).toLowerCase()}:${String(federationId).toLowerCase()}:${String(gatewayUrl)}`;
/** The digest LND's signmessage signs with the node key: sha256d("Lightning Signed Message:" || message), no length prefixes. */
export const lightningMessageDigest = (message) => sha256(sha256(utf8Encode(`Lightning Signed Message:${message}`)));
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
/** zbase32 (LND's signature encoding) of `bytes`. */
export function zbase32Encode(bytes) {
  let out = '', acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += ZBASE32[(acc >> bits) & 31]; } acc &= (1 << bits) - 1; }
  if (bits > 0) out += ZBASE32[(acc << (5 - bits)) & 31];
  return out;
}
/** The bytes of a zbase32 string, or null when it is not one. */
export function zbase32Decode(s) {
  const out = []; let acc = 0, bits = 0;
  for (const ch of String(s)) { const v = ZBASE32.indexOf(ch); if (v < 0) return null; acc = (acc << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } acc &= (1 << bits) - 1; }
  return Uint8Array.from(out);
}
/** A claim's Lightning-key proof (the zbase32 string LND answers), or '' when it carries none. */
export const lightningProofOf = (c) => (c && typeof c.lightningProof === 'string' ? c.lightningProof : '');
/**
 * Whether `signature` (LND signmessage: zbase32 of the 65-byte compact form - header 27..34, r, s) on `message` is by the Lightning
 * key `pubkey` (33-byte hex). `recover(sig64, recoveryBit, digest32) -> 33-byte compressed key` (the caller's secp256k1).
 */
export function lightningSigned({ pubkey, message, signature, recover }) {
  const sig = zbase32Decode(signature);
  if (!sig || sig.length !== 65 || sig[0] < 27 || sig[0] > 34) return false;
  let key; try { key = recover(sig.slice(1), (sig[0] - 27) & 3, lightningMessageDigest(message)); } catch { return false; }
  return !!key && toHex(key) === String(pubkey).toLowerCase();
}
/** Whether claim `c` carries a good proof: its lightningPubkey signed (c.node, c.federationId, c.gatewayUrl). Answers { ok, why }. */
export function checkGatewayLnProof(c, recover) {
  const proof = lightningProofOf(c);
  if (!proof) return { ok: false, why: 'the claim carries no Lightning-key proof' };
  return lightningSigned({ pubkey: c.lightningPubkey, message: gatewayLnProofMessage(c.node, c.federationId, c.gatewayUrl), signature: proof, recover })
    ? { ok: true } : { ok: false, why: 'the claim\'s Lightning-key proof is not by its Lightning key for this node, federation and gateway' };
}
// THE CUT-OVER (kanban #3739, owner ruling 2026-11-25: a grace period): before it, a claim without a good proof still counts as before
// (a gateway it names held first-come, kanban #2422) - but a claim that proves the gateway takes it from one that does not; from it, a
// claim without a good proof counts for nothing. A block height per network, the first block of a gateway epoch (144), so every guardian
// judges a whole epoch by one rule (like TAG_SWITCH, tag-switch.js).
// TO CONFIRM BY THE OWNER: testnet4 169,488 = epoch 1177, about 30 days after this release (2026-11-25: tip 163,375, ~200 blocks a day
// on testnet4 over the last 3 weeks, so ~2026-12-25); mainnet and regtest 0 - the proof is required from their first block (no claim out
// there needs the grace).
export const GATEWAY_LN_PROOF_FROM = Object.freeze({ mainnet: 0, testnet4: 169488, regtest: 0 });
/** Whether a claim must carry a good proof at height `height` on `network` (a network not named: required). */
export const gatewayLnProofRequired = (network, height, from = GATEWAY_LN_PROOF_FROM) => {
  const h = Object.prototype.hasOwnProperty.call(from, network) ? from[network] : 0;
  return Number(height) >= h;
};

/** A claim, signed with `sign(hash32) -> signature64` by the node key `node` (hex). */
export function signGatewayClaim(fields, sign) {
  const c = { node: String(fields.node).toLowerCase(), federationId: String(fields.federationId).toLowerCase(), gatewayUrl: String(fields.gatewayUrl),
    lightningPubkey: String(fields.lightningPubkey).toLowerCase(), capacitySats: String(fields.capacitySats), pegInSats: String(fields.pegInSats), atMs: String(fields.atMs),
    inboundSats: String(fields.inboundSats ?? 0), outboundSats: String(fields.outboundSats ?? 0), lightningAddr: String(fields.lightningAddr || ''),
    outsideInboundSats: String(fields.outsideInboundSats ?? 0), ...(pegInOutpointsOf(fields).length ? { pegInOutpoints: pegInOutpointsOf(fields) } : {}),
    ...(lightningProofOf(fields) ? { lightningProof: lightningProofOf(fields) } : {}) };
  return { ...c, signature: toHex(sign(gatewayClaimHash(c))) };
}

/** Whether `c` is a well-formed claim signed by its node. `verify(sig, hash, key)`. Answers { ok, why }. */
export function checkGatewayClaim(c, verify) {
  if (!c || !/^[0-9a-f]{64}$/.test(c.node || '') || !/^[0-9a-f]{64}$/.test(c.federationId || '')) return { ok: false, why: 'a claim names a node key and a federation id' };
  if (!/^https?:\/\/\S+\/$/.test(c.gatewayUrl || '')) return { ok: false, why: 'a claim names its gateway\'s address, ending in /' };
  if (!/^0[23][0-9a-f]{64}$/.test(c.lightningPubkey || '')) return { ok: false, why: 'a claim names its Lightning node key' };
  if (!/^(|([a-z0-9-]+\.)*[a-z0-9-]+:\d{1,5}|\[[0-9a-f:]+\]:\d{1,5})$/i.test(String(c.lightningAddr ?? ''))) return { ok: false, why: 'a claim\'s Lightning address is host:port, or empty' };
  for (const k of ['capacitySats', 'pegInSats', 'atMs', 'inboundSats', 'outboundSats', 'outsideInboundSats']) if (!/^\d+$/.test(String(c[k] || ''))) return { ok: false, why: `a claim's ${k} is a whole number` };
  if (c.pegInOutpoints !== undefined && (!Array.isArray(c.pegInOutpoints) || pegInOutpointsOf(c).length !== c.pegInOutpoints.length))
    return { ok: false, why: 'a claim\'s peg-in outpoints are txid:vout, each once' };
  if (c.lightningProof !== undefined && (typeof c.lightningProof !== 'string' || !/^[ybndrfg8ejkmcpqxot1uwisza345h769]{1,200}$/.test(c.lightningProof)))
    return { ok: false, why: 'a claim\'s Lightning-key proof is LND\'s signmessage answer (zbase32)' };
  if (!/^[0-9a-f]{128}$/.test(c.signature || '')) return { ok: false, why: 'a claim is signed' };
  let good = false;
  try { good = tagsAccepted('gatewayClaim', { ms: c.atMs }).some((t) => verify(fromHex(c.signature), gatewayClaimHash(c, t), fromHex(c.node))); } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: 'the claim is not signed by its node key' };
}
