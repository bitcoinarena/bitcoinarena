// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND THAT PAYS OUT NEEDS SOMEWHERE FOR THE MONEY TO COME IN.
//
// M3 (RULED 2026-09-20 11:09, named pick A): a paying round needs "inbound liquidity and >= 2
// independent gateways", and that means two LIVE testnet4 LND nodes that each have inbound - "same host is
// fine. No fake labelled gateways." (RULED 2026-09-20 19:xx, named pick (i): inbound on each of the two nodes
// from any peer, INCLUDING FROM EACH OTHER. Inbound from the public network is a later letter.)
//
// So what makes a gateway usable is not its label and not its host. It is three facts, and this counts them:
//
//   it is a SEPARATE NODE      a distinct identity pubkey, reached at its own rpc address. Two names on one
//                              node is one gateway wearing two hats, which is exactly the "fake labelled
//                              gateway" the ruling forbids. The HOST is not the test: both of ours run on the
//                              test host and that was allowed explicitly.
//   it is LIVE                 synced to its chain and holding at least one active channel. A node that is up
//                              but whose channels are all inactive cannot be paid; that is the state node A
//                              was found in, with 196530 sat of inbound it could not use because its only
//                              peer - our own node B - had been down since 2026-09-16.
//   it has INBOUND             remote_balance on its active channels, which is what somebody else can push to
//                              it. Outbound is the money it can send; inbound is the money it can RECEIVE,
//                              and a gateway that cannot receive is not a gateway.
//
// IT DECIDES NOTHING ABOUT THE GAME. This is custody, not the simulation: no outcome, no core state, nothing
// the client may recompute. It answers one question about the operator's own plumbing.
//
// MEASURED AGAINST THE REAL PAIR (testnet4, lnd 0.21.3-beta, 2026-09-20), after a real invoice was paid each
// way over channel dce6199b...:
//
//   lnd-testnet4    0274e261...  local 80000   inbound 116530   active, synced
//   lnd-testnet4-b  025f17c2...  local 116530  inbound  80000   active, synced
//
// The two payments that put it there: B -> A 100000 sat, preimage 7eb1b306...; A -> B 20000 sat, preimage
// 51f8782c... Both SUCCEEDED. Before them B had no inbound at all.

/** The least inbound a gateway must hold to count. A gateway that can receive nothing is not a gateway. */
export const GATEWAY_MIN_INBOUND_SAT = 1n;

const isHex33 = (s) => typeof s === 'string' && /^[0-9a-f]{66}$/i.test(s);

/**
 * `gateways` are what the operator's own nodes reported - one entry per node, each taken from that node's own
 * `getinfo` and `listchannels`. Nothing here is taken on trust from a label:
 *
 *   identityPubkey   getinfo.identity_pubkey, 33 bytes as hex
 *   rpc              the address it was reached at, so two entries cannot be one node answering twice
 *   syncedToChain    getinfo.synced_to_chain
 *   channels         [{ active, remoteBalanceSat }] from listchannels - remote_balance IS the inbound
 *
 * `need` is how many independent gateways the round wants, and `minInboundSat` how much each must be able to
 * receive. Returns the same { ok, why } shape the other §23 predicates use, plus what it counted.
 */
export function gatewaysAreIndependent({ gateways, need = 2, minInboundSat = GATEWAY_MIN_INBOUND_SAT } = {}) {
  if (!Array.isArray(gateways) || gateways.length === 0)
    return { ok: false, why: 'no gateway reported anything', usable: 0 };
  if (!Number.isInteger(need) || need < 2)
    return { ok: false, why: 'a paying round needs at least two gateways', usable: 0 };
  if (typeof minInboundSat !== 'bigint' || minInboundSat < 1n)
    return { ok: false, why: 'the minimum inbound must be a positive number of sats', usable: 0 };

  const identities = new Set(), rpcs = new Set();
  let usable = 0;

  for (const g of gateways) {
    if (!g || !isHex33(g.identityPubkey))
      return { ok: false, why: 'a gateway reported no 33-byte identity', usable };
    const id = g.identityPubkey.toLowerCase();
    // TWO NAMES ON ONE NODE ARE ONE GATEWAY. The host is deliberately not part of this.
    if (identities.has(id))
      return { ok: false, why: `two gateways share the identity ${id.slice(0, 8)}... - that is one node`, usable };
    identities.add(id);
    if (typeof g.rpc === 'string' && g.rpc.length) {
      if (rpcs.has(g.rpc))
        return { ok: false, why: `two gateways answer at ${g.rpc} - that is one node`, usable };
      rpcs.add(g.rpc);
    }

    if (g.syncedToChain !== true) continue;                       // up, but not caught up: cannot be paid
    const channels = Array.isArray(g.channels) ? g.channels : [];
    const inbound = channels.reduce((sum, c) => {
      if (!c || c.active !== true) return sum;                    // an inactive channel holds nothing reachable
      const r = typeof c.remoteBalanceSat === 'bigint' ? c.remoteBalanceSat : 0n;
      return sum + (r > 0n ? r : 0n);
    }, 0n);
    if (inbound >= minInboundSat) usable++;
  }

  if (usable < need)
    return { ok: false, usable,
             why: `${usable} of ${gateways.length} gateways can actually receive; the round needs ${need}` };
  return { ok: true, usable, why: '' };
}

/**
 * HOW MANY GATEWAYS A ROUND'S FEDERATION REALLY HAS, AS ITS LOCK PORT CAN SEE THEM (§23.6: "deposits and
 * withdrawals through any of at least two gateways ... run by different operators"; RULED 2026-09-23).
 *
 * `listed` is what the guardians registered and what each registered name said for itself when asked
 * (`blwp-stake-lock --mode gateways`): `{ url, live, lightningPublicKey }`. IDENTITY IS THE LIGHTNING NODE KEY -
 * it signs the gateway's invoices. A name that did not answer `routing_info` is not live and is not counted.
 * Two registered names on one node key are ONE gateway: they are merged, and then counted - the set is not
 * refused for containing them (that is `gatewaysAreIndependent`'s operator-side rule, not this one).
 *
 * INBOUND IS NOT HERE, AND IS NOT PRETENDED. The federation's API does not say what a gateway can receive,
 * and routing info is not inbound. What a door can truthfully say at open is this count; inbound is proven
 * by a deposit that commits through each gateway, and only there.
 *
 * @returns {{ distinctLive: number, registered: number, keys: string[], notLive: string[] }}
 */
export function federationGatewayCount(listed) {
  const keys = new Set();
  const notLive = [];
  const all = Array.isArray(listed) ? listed : [];
  for (const g of all) {
    const key = g && typeof g.lightningPublicKey === 'string' ? g.lightningPublicKey.toLowerCase() : '';
    if (!g || g.live !== true || !isHex33(key)) { notLive.push(g && g.url ? String(g.url) : '(unnamed)'); continue; }
    keys.add(key);
  }
  return { distinctLive: keys.size, registered: all.length, keys: [...keys], notLive };
}
