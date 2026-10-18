// LIQUIDITY PROVIDERS (spec §23A.10, kanban #494; the owner 2026-10-18: "On main net everybody needs incoming liquidity. Spec a fourth
// service for nodes: lnd liquidity provider ... We try to have at least one connection to each node, maximum 2. So this service needs to
// communicate with other nodes who opens liquidity to a new node").
//
// A provider says what it holds in a LIQUIDITY CLAIM its seat serves (GET /liquidity-claim), signed by its node key: its LND key and
// address, its free balance, and its channels to nodes. Every provider reads every other's claim and the nodes' gateway claims, and
// runs the same ASSIGNMENT: for each node with fewer than 2 provider channels of at least L, the providers without one and with free
// funds of at least L, ranked by a ticket on (node, provider), lowest first - the top 2 - count open. No coordinator; the claims are
// the communication, and a provider stops as soon as the others' claims show 2.
import { Writer } from './encode.js';
import { taggedHash, fromHex, toHex, bytesToBigInt } from './hash.js';

export const LIQUIDITY_CLAIM_TAG = 'BLWP/v1/LIQUIDITY_CLAIM';
export const LIQUIDITY_TICKET_TAG = 'BLWP/v1/LIQUIDITY';
/** The liquidity amount L (one channel to one node) and the deposit a provider keeps, per network (§23A.10). */
export const LIQUIDITY_TERMS = Object.freeze({
  testnet4: Object.freeze({ channelSats: 100_000n, depositSats: 500_000n }),     // 5 x L
  mainnet: Object.freeze({ channelSats: 250_000n, depositSats: 2_500_000n }),    // 10 x L (the owner: "250k per node")
  regtest: Object.freeze({ channelSats: 20_000n, depositSats: 100_000n }),
});
export const MAX_PROVIDERS_PER_NODE = 2;

const LN_KEY = /^0[23][0-9a-f]{64}$/;

/** The 32 bytes a claim's signature covers. */
export function liquidityClaimHash(c) {
  const w = new Writer();
  w.bytes32(fromHex(c.node)); w.bytes(fromHex(c.lightningPubkey), 33); w.str(String(c.lightningAddr || ''));
  w.u64(BigInt(c.freeSats)); w.u64(BigInt(c.atMs));
  w.vec([...c.channels].sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)), (x, ww) => { ww.bytes(fromHex(x.peer), 33); ww.u64(BigInt(x.capacitySats)); });
  w.str(String(c.depositAddress || ''));   // where the provider is topped up (its LND wallet): the owner page and dashboard show it
  return taggedHash(LIQUIDITY_CLAIM_TAG, w.finish());
}

/** A claim signed with `sign(hash32) -> sig64` by node key `node` (hex). */
export function signLiquidityClaim(f, sign) {
  const c = { node: String(f.node).toLowerCase(), lightningPubkey: String(f.lightningPubkey).toLowerCase(), lightningAddr: String(f.lightningAddr || ''),
    freeSats: String(f.freeSats), atMs: String(f.atMs), depositAddress: String(f.depositAddress || ''),
    channels: (f.channels || []).map((x) => ({ peer: String(x.peer).toLowerCase(), capacitySats: String(x.capacitySats) })) };
  return { ...c, signature: toHex(sign(liquidityClaimHash(c))) };
}

/** Whether `c` is a well-formed claim signed by its node. Answers { ok, why }. */
export function checkLiquidityClaim(c, verify) {
  if (!c || !/^[0-9a-f]{64}$/.test(c.node || '')) return { ok: false, why: 'a liquidity claim names its node key' };
  if (!LN_KEY.test(c.lightningPubkey || '')) return { ok: false, why: 'a liquidity claim names its Lightning key' };
  for (const k of ['freeSats', 'atMs']) if (!/^\d+$/.test(String(c[k] || ''))) return { ok: false, why: `a liquidity claim's ${k} is a whole number` };
  if (!Array.isArray(c.channels) || c.channels.some((x) => !LN_KEY.test(x.peer || '') || !/^\d+$/.test(String(x.capacitySats || ''))))
    return { ok: false, why: 'a liquidity claim lists its channels: peer key and capacity' };
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
    const providers = claims.filter((c) => c.lightningPubkey !== n.lightningPubkey && c.node !== n.node);   // never to itself
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
 * while its free balance is below the deposit minimum (the owner 2026-10-18: "Once a liquidity provider has not enough funds left he never
 * receives part of the 1%"): it earns again once topped up.
 */
export function liquidityWeight(claim, federationLnKeys, network = 'testnet4') {
  if (BigInt(claim.freeSats) < LIQUIDITY_TERMS[network].depositSats) return 0n;
  const keys = new Set(federationLnKeys);
  const inFed = claim.channels.filter((x) => keys.has(x.peer)).reduce((a, x) => a + BigInt(x.capacitySats), 0n);
  return ((inFed + BigInt(claim.freeSats)) / 10000n) * 10000n;
}
