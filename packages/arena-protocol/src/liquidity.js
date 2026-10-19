// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LIQUIDITY PROVIDERS (spec §23A.102026-10-18: "On main net everybody needs incoming liquidity. Spec a fourth
// service for nodes: lnd liquidity provider ... We try to have at least one connection to each node, maximum 2. So this service needs to
// communicate with other nodes who opens liquidity to a new node").
//
// A provider says what it holds in a LIQUIDITY CLAIM its seat serves (GET /liquidity-claim), signed by its node key: its LND key and
// address, its free balance, and its channels to nodes. Every provider reads every other's claim and the nodes' gateway claims, and
// runs the same ASSIGNMENT: for each node with fewer than 2 provider channels of at least L, the providers without one and with free
// funds of at least L, ranked by a ticket on (node, provider), lowest first - the top 2 - count open. No coordinator; the claims are
// the communication, and a provider stops as soon as the others' claims show 2.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex, bytesToBigInt, sha256 } from './hash.js';
import { utf8Encode } from './utf8.js';
import { addressScript, HRP_OF } from './address.js';

export const LIQUIDITY_CLAIM_TAG = 'BLWP/v1/LIQUIDITY_CLAIM';
export const LIQUIDITY_TICKET_TAG = 'BLWP/v1/LIQUIDITY';
/** The liquidity amount L (one channel to one node) and the deposit a provider keeps, per network (§23A.10). */
export const LIQUIDITY_TERMS = Object.freeze({
  testnet4: Object.freeze({ channelSats: 100_000n, depositSats: 500_000n }),     // 5 x L
  mainnet: Object.freeze({ channelSats: 250_000n, depositSats: 2_500_000n }),    // 10 x L (the owner: "250k per node")
  regtest: Object.freeze({ channelSats: 20_000n, depositSats: 100_000n }),
});
export const MAX_PROVIDERS_PER_NODE = 2;
/** The most coins one claim lists to prove its free balance (a guardian asks its chain about each). */
export const MAX_FUNDS = 50;

const LN_KEY = /^0[23][0-9a-f]{64}$/;

/** The 32 bytes a claim's signature covers. */
export function liquidityClaimHash(c) {
  const w = new Writer();
  w.bytes32(fromHex(c.node)); w.bytes(fromHex(c.lightningPubkey), 33); w.str(String(c.lightningAddr || ''));
  w.u64(BigInt(c.freeSats)); w.u64(BigInt(c.atMs));
  w.vec([...c.channels].sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)), (x, ww) => { ww.bytes(fromHex(x.peer), 33); ww.u64(BigInt(x.capacitySats)); });
  w.str(String(c.depositAddress || ''));   // where the provider is topped up (its LND wallet): the owner page and dashboard show it
  // the coins that prove its free balance, each signed by its address key (fundsMessage)
  w.vec([...(c.funds || [])].sort((a, b) => (`${a.txid}:${a.vout}` < `${b.txid}:${b.vout}` ? -1 : 1)), (f, ww) => {
    ww.bytes32(fromHex(f.txid)); ww.u32(Number(f.vout)); ww.str(String(f.address)); ww.u64(BigInt(f.sats)); ww.str(String(f.signature)); });
  return taggedHash(LIQUIDITY_CLAIM_TAG, w.finish());
}

/** A claim signed with `sign(hash32) -> sig64` by node key `node` (hex). */
export function signLiquidityClaim(f, sign) {
  const c = { node: String(f.node).toLowerCase(), lightningPubkey: String(f.lightningPubkey).toLowerCase(), lightningAddr: String(f.lightningAddr || ''),
    freeSats: String(f.freeSats), atMs: String(f.atMs), depositAddress: String(f.depositAddress || ''),
    channels: (f.channels || []).map((x) => ({ peer: String(x.peer).toLowerCase(), capacitySats: String(x.capacitySats) })),
    funds: (f.funds || []).map((x) => ({ txid: String(x.txid).toLowerCase(), vout: Number(x.vout), address: String(x.address), sats: String(x.sats), signature: String(x.signature) })) };
  return { ...c, signature: toHex(sign(liquidityClaimHash(c))) };
}

/** Whether `c` is a well-formed claim signed by its node. Answers { ok, why }. */
export function checkLiquidityClaim(c, verify) {
  if (!c || !/^[0-9a-f]{64}$/.test(c.node || '')) return { ok: false, why: 'a liquidity claim names its node key' };
  if (!LN_KEY.test(c.lightningPubkey || '')) return { ok: false, why: 'a liquidity claim names its Lightning key' };
  for (const k of ['freeSats', 'atMs']) if (!/^\d+$/.test(String(c[k] || ''))) return { ok: false, why: `a liquidity claim's ${k} is a whole number` };
  if (!Array.isArray(c.channels) || c.channels.some((x) => !LN_KEY.test(x.peer || '') || !/^\d+$/.test(String(x.capacitySats || ''))))
    return { ok: false, why: 'a liquidity claim lists its channels: peer key and capacity' };
  if (c.funds !== undefined && (!Array.isArray(c.funds) || c.funds.length > MAX_FUNDS || c.funds.some((x) => !/^[0-9a-f]{64}$/.test(x.txid || '')
    || !Number.isInteger(x.vout) || x.vout < 0 || !/^\d+$/.test(String(x.sats || '')) || typeof x.address !== 'string' || typeof x.signature !== 'string')))
    return { ok: false, why: `a liquidity claim lists at most ${MAX_FUNDS} coins: txid, vout, address, amount, signature` };
  let good = false;
  try { good = verify(fromHex(c.signature), liquidityClaimHash(c), fromHex(c.node)); } catch { good = false; }
  return good ? { ok: true } : { ok: false, why: 'the liquidity claim is not signed by its node key' };
}

export const liquidityTicket = (nodeHex, providerHex) => {
  const w = new Writer(); w.bytes32(fromHex(nodeHex)); w.bytes32(fromHex(providerHex));
  return bytesToBigInt(taggedHash(LIQUIDITY_TICKET_TAG, w.finish()));
};

/**
 * WHO OPENS TO WHOM. `needs` [{ node (hex), lightningPubkey }] - the nodes with a gateway; `claims` - the providers' checked liquidity
 * claims; `skipped` Set of `${node}:${provider}` a provider was ranked for and did not open within an hour. Answers
 * [{ node, lightningPubkey, have, open: [provider node hex] }] for every node with fewer than MAX_PROVIDERS_PER_NODE channels.
 */
export function assignLiquidity({ needs, claims, network = 'testnet4', skipped = new Set() }) {
  const L = LIQUIDITY_TERMS[network].channelSats;
  const out = [];
  for (const n of needs) {
    const providers = claims.filter((c, i) => c.lightningPubkey !== n.lightningPubkey && c.node !== n.node   // never to itself
      && claims.findIndex((x) => x.node === c.node) === i);                                                      // each provider once
    const have = providers.filter((c) => c.channels.some((x) => x.peer === n.lightningPubkey && BigInt(x.capacitySats) >= L)).map((c) => c.node);
    if (have.length >= MAX_PROVIDERS_PER_NODE) continue;
    const candidates = providers.filter((c) => !have.includes(c.node) && BigInt(c.freeSats) >= L && !skipped.has(`${n.node}:${c.node}`))
      .sort((a, b) => { const x = liquidityTicket(n.node, a.node), y = liquidityTicket(n.node, b.node); return x < y ? -1 : x > y ? 1 : 0; });
    out.push({ node: n.node, lightningPubkey: n.lightningPubkey, have, open: candidates.slice(0, MAX_PROVIDERS_PER_NODE - have.length).map((c) => c.node) });
  }
  return out;
}

/**
 * A provider's weight for the liquidity pool: its channels to the federation's nodes + its free balance, floored to 10,000 sat - and 0
 * while its liquidity is below the deposit minimum (2026-10-18: "Once a liquidity provider has not enough funds left he never
 * receives part of the 1%"): it earns again once topped up. THE MINIMUM COUNTS FREE COINS + THE CHANNELS IT GAVE (2026-10-18,
 * "ok accepted"): a provider at exactly 5 x L that gives a channel keeps its share - giving liquidity never removes the earning.
 */
export const liquidityHeld = (claim, freeSats = BigInt(claim.freeSats)) => freeSats + claim.channels.reduce((a, x) => a + BigInt(x.capacitySats), 0n);
export function liquidityWeight(claim, federationLnKeys, network = 'testnet4', freeSats = BigInt(claim.freeSats)) {
  if (liquidityHeld(claim, freeSats) < LIQUIDITY_TERMS[network].depositSats) return 0n;
  const keys = new Set(federationLnKeys);
  const inFed = claim.channels.filter((x) => keys.has(x.peer)).reduce((a, x) => a + BigInt(x.capacitySats), 0n);
  return ((inFed + freeSats) / 10000n) * 10000n;
}

// THE FREE BALANCE, PROVEN (spec §23A.10): "the claim lists the wallet's outpoints, each with a signature by its address key (LND
// SignMessageWithAddr), and a guardian counts only outpoints that are unspent on its own chain and signed". The message names the
// provider's node, so a coin proves one provider's balance only.
export const fundsMessage = (node, txid, vout) => `BLWP/v1/LIQUIDITY_FUNDS:${String(node).toLowerCase()}:${String(txid).toLowerCase()}:${Number(vout)}`;

const varStr = (bytes) => { const n = bytes.length; const len = n < 253 ? [n] : [253, n & 255, n >> 8]; return Uint8Array.from([...len, ...bytes]); };
/** The digest Bitcoin's signmessage (and LND's SignMessageWithAddr) signs: sha256d(varstr(prefix) || varstr(message)). */
export function signedMessageDigest(message) {
  return sha256(sha256(Uint8Array.from([...varStr(utf8Encode('Bitcoin Signed Message:\n')), ...varStr(utf8Encode(message))])));
}
const fromBase64 = (s) => { try { return Uint8Array.from(atob(String(s)), (ch) => ch.charCodeAt(0)); } catch { return null; } };
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Whether `signature` (base64, 65-byte compact: header, r, s) on `message` is by the key behind `address` - a P2WPKH (the key's
 * hash160) or a P2TR address (the key's BIP-86 output key: LND signs with the internal key, ECDSA, as for every address type).
 * `curve` { recover(sig64, recoveryBit, digest) -> 33-byte key, hash160(bytes), taprootOutputKey(33-byte key) -> 32 bytes }.
 */
export function addressSigned({ address, message, signature, network = 'testnet4', curve }) {
  const script = addressScript(address, HRP_OF[network]);
  const sig = fromBase64(signature);
  if (!script || !sig || sig.length !== 65 || sig[0] < 27 || sig[0] > 42) return false;
  let key; try { key = curve.recover(sig.slice(1), (sig[0] - 27) & 3, signedMessageDigest(message)); } catch { return false; }
  if (!key) return false;
  if (script[0] === 0 && script[1] === 20) return same(curve.hash160(key), script.slice(2));
  if (script[0] === 0x51 && script[1] === 32) return same(curve.taprootOutputKey(key), script.slice(2));
  return false;
}

/**
 * A provider's proven free balance: the sum, as the guardian's own chain says it, of the claim's coins that are signed by their
 * address key for this provider and unspent paying that address. `txOut(txid, vout)` -> { sats (BigInt), script (hex) } or null when
 * spent or unknown. A coin listed twice counts once.
 */
export async function provenFreeSats({ claim, network = 'testnet4', curve, txOut }) {
  let total = 0n; const seen = new Set();
  for (const f of (claim.funds || []).slice(0, MAX_FUNDS)) {
    const k = `${f.txid}:${f.vout}`;
    if (seen.has(k)) continue; seen.add(k);
    if (!addressSigned({ address: f.address, message: fundsMessage(claim.node, f.txid, f.vout), signature: f.signature, network, curve })) continue;
    let o = null; try { o = await txOut(f.txid, Number(f.vout)); } catch { o = null; }
    if (!o || o.script !== toHex(addressScript(f.address, HRP_OF[network]))) continue;
    total += BigInt(o.sats);
  }
  return total;
}
