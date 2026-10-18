// A GUARDIAN WATCHES ITS FEDERATION'S GATEWAYS (spec §23A.9, kanban #471): every probe (10 minutes) it reads each seated guardian's
// gateway claim from that node's seat (GET /gateway-claim, signed by the node key), and asks the gateway the claim names whether it
// serves this federation (POST <gateway>/routing_info with the federation id: the LNv2 call a client makes before paying - public,
// null when the gateway does not serve it). Per epoch (144 blocks) it counts probes and answers per node; the seats are ranked by
// gateway-seats.js on the last whole epoch (the running one while there is none), with the seats it ranked before as incumbents.
// Routed volume is not measured here yet (it is read from the federation's LNv2 contracts): every candidate's is 0 until it is.
import { checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { seatGateways, GATEWAY_EPOCH_BLOCKS } from '../../arena-protocol/src/gateway-seats.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export function createGatewayWatch({ federationId, seated, entries, tip, beaconAt, verify, fetcher = fetch, network = 'testnet4', bondMinGuardian = 50000n,
  epochBlocks = GATEWAY_EPOCH_BLOCKS, timeoutMs = 10000 }) {
  const epochs = new Map();          // epoch -> Map(node hex -> { probes, up, claim })
  let incumbents = [];
  const baseOf = (u) => String(u).replace(/\/+$/, '');
  async function probe() {
    const fid = await federationId();
    if (!fid) return { ok: false, why: 'this node guards no federation' };
    const h = await tip();
    const epoch = Math.floor(h / epochBlocks);
    if (!epochs.has(epoch)) { epochs.set(epoch, new Map()); for (const e of [...epochs.keys()]) if (e < epoch - 1) epochs.delete(e); }
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
        if (body && body !== 'null') row.up++;
      } catch { /* down this probe */ }
      rows.set(node, row);
    }
    return { ok: true, epoch, standing: rows.size };
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
        registered: r.up > 0, volumeSats: 0n, capacitySats: BigInt(r.claim.capacitySats), pegInSats: BigInt(r.claim.pegInSats),
        availabilityPct: r.probes ? (100 * r.up) / r.probes : 0, bondSats: e ? BigInt(e.bondSats) : 0n, gatewayUrl: r.claim.gatewayUrl };
    });
    const beacon = await beaconAt(at * epochBlocks);
    if (!beacon) return { ok: false, why: `the epoch's first block ${at * epochBlocks} is not in this seat's chain` };
    const s = seatGateways({ candidates, beacon, incumbents, network, bondMinGuardian });
    if (at < epoch) incumbents = s.seated;
    return { ok: true, federationId: fid, epoch: at, measuredEpoch: at === epoch ? 'running' : 'whole', ...s,
      gateways: Object.fromEntries(candidates.map((c) => [toHex(c.node), { url: c.gatewayUrl, availabilityPct: Math.round(c.availabilityPct), probes: rows.get(toHex(c.node)).probes }])) };
  }
  return { probe, view };
}
