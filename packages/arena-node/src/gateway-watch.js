// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN WATCHES ITS FEDERATION'S GATEWAYS (spec §23A.9): every probe (10 minutes) it reads each seated guardian's
// gateway claim from that node's seat (GET /gateway-claim, signed by the node key), and asks the gateway the claim names whether it
// serves this federation (POST <gateway>/routing_info with the federation id: the LNv2 call a client makes before paying - public,
// null when the gateway does not serve it). Per epoch (144 blocks) it counts probes and answers per node; the seats are ranked by
// gateway-seats.js on the last whole epoch (the running one while there is none), with the seats it ranked before as incumbents.
// ROUTED VOLUME (gateway-volume.js): `incoming(from)` streams the federation's LNv2 incoming contracts after a stream index; each one is
// credited to the gateway whose module key (its routing_info's module_public_key) funded it, in the epoch of the probe that first
// saw it. The first probe only takes the index (history before the watch is not credited to any epoch). Outgoing is not counted.
import { checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { seatGateways, GATEWAY_EPOCH_BLOCKS } from '../../arena-protocol/src/gateway-seats.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export function createGatewayWatch({ federationId, seated, entries, tip, beaconAt, verify, fetcher = fetch, network = 'testnet4', bondMinGuardian = 50000n,
  epochBlocks = GATEWAY_EPOCH_BLOCKS, timeoutMs = 10000, incoming = null }) {
  const epochs = new Map();          // epoch -> Map(node hex -> { probes, up, claim, modulePk })
  const volumes = new Map();         // epoch -> Map(gateway module key -> msat)
  let cursor = null;
  let incumbents = [];
  // a seat's advert names its endpoint as wss://... (the guardian socket's address); its HTTP doors are the same address over https
  // (measured 2026-10-19 21:1xZ: fetch refused every wss:// claim URL - "unknown scheme" - so no claim stood and no gateway was seated)
  const baseOf = (u) => String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
  async function probe() {
    const fid = await federationId();
    if (!fid) return { ok: false, why: 'this node guards no federation' };
    const h = await tip();
    const epoch = Math.floor(h / epochBlocks);
    if (!epochs.has(epoch)) { epochs.set(epoch, new Map()); for (const e of [...epochs.keys()]) if (e < epoch - 1) { epochs.delete(e); volumes.delete(e); } }
    const rows = epochs.get(epoch);
    const all = (await entries()) || [];
    for (const node of (await seated(fid)) || []) {
      const e = all.find((x) => toHex(x.pubkey) === node);
      if (!e || !e.advert || !e.advert.endpoint) continue;
      let claim = null;
      try {
        const r = await fetcher(`${baseOf(e.advert.endpoint)}/gateway-claim`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) { const c = await r.json(); if (checkGatewayClaim(c, verify).ok && c.node === node && c.federationId === fid) claim = c; }
      } catch { claim = null; }
      if (!claim) continue;                 // no claim: this node does not stand
      const row = rows.get(node) || { probes: 0, up: 0, claim };
      row.probes++; row.claim = claim;
      try {
        const r = await fetcher(`${claim.gatewayUrl}routing_info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fid), signal: AbortSignal.timeout(timeoutMs) });
        const body = r.status === 200 ? (await r.text()).trim() : 'null';
        if (body && body !== 'null') { row.up++; try { const k = JSON.parse(body).module_public_key; if (/^0[23][0-9a-f]{64}$/.test(k || '')) row.modulePk = k; } catch { /* no key */ } }
      } catch { /* down this probe */ }
      rows.set(node, row);
    }
    let credited = 0;
    if (incoming) {
      try {
        const got = await incoming(cursor === null ? 0 : cursor);
        if (got && got.ok) {
          if (cursor !== null) {
            const v = volumes.get(epoch) || new Map();
            for (const c of got.contracts) { v.set(c.refundPk, (v.get(c.refundPk) || 0n) + BigInt(c.amountMsat)); credited++; }
            volumes.set(epoch, v);
          }
          cursor = got.next;
        }
      } catch { /* the guardian's API did not answer: next probe */ }
    }
    return { ok: true, epoch, standing: rows.size, credited };
  }
  /** The seats as this guardian ranks them now. */
  async function view() {
    const fid = await federationId();
    if (!fid) return { ok: false, why: 'this node guards no federation' };
    const h = await tip();
    const epoch = Math.floor(h / epochBlocks);
    const at = epochs.has(epoch - 1) ? epoch - 1 : epoch;
    const rows = epochs.get(at) || new Map();
    const all = (await entries()) || [];
    const seatedNow = new Set((await seated(fid)) || []);
    const candidates = [...rows].map(([node, r]) => {
      const e = all.find((x) => toHex(x.pubkey) === node);
      return { node: Uint8Array.from(Buffer.from(node, 'hex')), operatorId: (e && e.advert && e.advert.operatorId) || node, seatedGuardian: seatedNow.has(node),
        registered: r.up > 0, volumeSats: r.modulePk ? ((volumes.get(at) || new Map()).get(r.modulePk) || 0n) / 1000n : 0n, capacitySats: BigInt(r.claim.capacitySats), inboundSats: BigInt(r.claim.inboundSats || 0), outboundSats: BigInt(r.claim.outboundSats || 0), outsideInboundSats: BigInt(r.claim.outsideInboundSats || 0), pegInSats: BigInt(r.claim.pegInSats),
        availabilityPct: r.probes ? (100 * r.up) / r.probes : 0, bondSats: e ? BigInt(e.bondSats) : 0n, gatewayUrl: r.claim.gatewayUrl };
    });
    const beacon = await beaconAt(at * epochBlocks);
    if (!beacon) return { ok: false, why: `the epoch's first block ${at * epochBlocks} is not in this seat's chain` };
    const s = seatGateways({ candidates, beacon, epoch: at, incumbents, network, bondMinGuardian });
    if (at < epoch) incumbents = s.seated;
    return { ok: true, federationId: fid, epoch: at, measuredEpoch: at === epoch ? 'running' : 'whole', ...s,
      gateways: Object.fromEntries(candidates.map((c) => [toHex(c.node), { url: c.gatewayUrl, availabilityPct: Math.round(c.availabilityPct), probes: rows.get(toHex(c.node)).probes, volumeSats: String(c.volumeSats),
        inboundSats: String(c.inboundSats), outboundSats: String(c.outboundSats), outsideInboundSats: String(c.outsideInboundSats), pegInSats: String(rows.get(toHex(c.node)).claim.pegInSats || 0), lightningPubkey: rows.get(toHex(c.node)).claim.lightningPubkey, lightningAddr: rows.get(toHex(c.node)).claim.lightningAddr || '' }])) };
  }
  return { probe, view };
}
