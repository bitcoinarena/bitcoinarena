// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN WATCHES ITS FEDERATION'S GATEWAYS (spec §23A.9): every probe (10 minutes) it reads each seated guardian's
// gateway claim from that node's seat (GET /gateway-claim, signed by the node key), and asks the gateway the claim names whether it
// serves this federation (POST <gateway>/routing_info with the federation id: the LNv2 call a client makes before paying - public,
// null when the gateway does not serve it). Per epoch (144 blocks) it counts probes and answers per node; the seats are ranked by
// gateway-seats.js on the last whole epoch (the running one while there is none); the seats ROTATE every epoch, so the epoch before's
// holders step back - the seating its guardians signed for that epoch (`seatingFor`), else this guardian's own ranking of it.
// ROUTED VOLUME (gateway-volume.js): `incoming(from)` streams the federation's LNv2 incoming contracts after a stream index; each one is
// credited to the gateway whose module key (its routing_info's module_public_key) funded it, in the epoch of the probe that first
// saw it. The first probe only takes the index (history before the watch is not credited to any epoch). Outgoing is not counted.
import { checkGatewayClaim, pegInOutpointsOf, pegInItem, pegInAgeStands } from '../../arena-protocol/src/gateway-claim.js';
import { seatingRulesActive } from '../../arena-protocol/src/gateway-seating.js';
import { seatingRulesEpochOf, pegInMaxAgeOf } from '../../arena-protocol/src/constants.js';
import { seatGateways, feesOfRoutingInfo, GATEWAY_EPOCH_BLOCKS, GATEWAY_SEATS, GATEWAY_MINIMUMS } from '../../arena-protocol/src/gateway-seats.js';
import { GATEWAY_FEE_MAX_REFERENCE } from '../../arena-protocol/src/federation-record.js';
import { pegInPressure } from '../../arena-protocol/src/capacity.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { nodeBondOf } from '../../arena-protocol/src/census.js';
import { heldLockCounted } from '../../arena-protocol/src/held-proof.js';

// `endpointOf(entry)`: where that node answers now - its newest signed address announcement before its advert's endpoint (kanban
// #577, measured 2026-10-22: the three installer guardians of 89ce310e restarted on an update, their quick tunnels took new names,
// the seats held the announcements, and still read every claim at the advert's dead address - "0 of 2 gateway seats filled")
export function createGatewayWatch({ federationId, seated, entries, tip, beaconAt, verify, fetcher = fetch, network = 'testnet4', bondMinGuardian = 50000n,
  endpointOf = (e) => (e && e.advert ? e.advert.endpoint : null),
  epochBlocks = GATEWAY_EPOCH_BLOCKS, timeoutMs = 10000, incoming = null, keep = null,
  // THE SIGNED SEATING OF AN EPOCH (gateway-seating.js), where one stands: async (fid, epoch) -> [node hex] | null
  seatingFor = async () => null,
  // THE FEDERATION'S OWN COINS (gateway-volume.js federationCoins): async () -> Map(outpoint -> sat) | null - a claim's peg-in outpoint found
  // among them is a proved peg-in (§23A.3a); none given: no peg-in is proved
  federationCoins = async () => null,
  // A PEG-IN'S AGE (§23A.3a, kanban #999/#1026): from `rulesEpoch`, a seating of an epoch counts an outpoint only if the height its claim
  // names holds it (`outpointAt(height, 'txid:vout')` -> true, false, or null when the block is not read) and it is at most `maxAge` blocks old
  // at the epoch's first height, so every guardian signs the same amounts whatever its tip. `rulesNetwork` the seat's own chain: `network`
  // above stays what it has always been, the gateway minimums' table
  rulesNetwork = network, rulesEpoch = seatingRulesEpochOf(rulesNetwork), maxAge = pegInMaxAgeOf(rulesNetwork), outpointAt = null,
  // WHO JUDGES A HELD LOCK (§23A.3a, kanban #998): async (fid, epoch) -> { seated: [node hex], threshold } | null, the record in force at the
  // epoch's proof height. From `rulesEpoch` a proved peg-in counts only up to what the claim's held lock shows, and with no record none
  heldSetFor = async () => null,
  // THE SEATS A FEDERATION NEEDS (2026-10-20, hard rule: "All federations need 2 of 2 gateways, draining gateways at least 1"): async (fid) -> n
  seatsFor = async () => GATEWAY_SEATS,
  // THE FEDERATION'S RESERVE AND CAP from its record (§23A.3a part 2): async (fid) -> { reserveSats, exposureCapSats } | null; with them,
  // under peg-in pressure the proved peg-in ranks before volume
  pressureFor = async () => null,
  // A PEG-IN PAST THE CAP (kanban #1093 part 6): async (fid, height) -> true when a peg-in confirmed at that height went into the federation at
  // load >= 1 (gateway-seats.js pegInPastCap over the record in force before it); a candidate with one is not seated
  pastCapAt = async () => false }) {
  const epochs = new Map();          // epoch -> Map(node hex -> { probes, up, claim, modulePk })
  const volumes = new Map();         // epoch -> Map(gateway module key -> msat)
  let cursor = null;
  const seatedBy = new Map();        // epoch -> [node hex] this guardian ranked into the seats
  // a seat's advert names its endpoint as wss://... (the guardian socket's address); its HTTP doors are the same address over https
  // (measured 2026-10-19 21:1xZ: fetch refused every wss:// claim URL - "unknown scheme" - so no claim stood and no gateway was seated)
  const baseOf = (u) => String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
  // THE LAST PROBE, SAID (kanban #552, 2026-10-20 10:35Z: after a restart the seats' view stayed "0 of 2" for 30 min while the same probe
  // run by hand seated the claim at once - nothing said where it stopped): when, the seated guardians it read, how many had an endpoint
  // in the census and a claim for this federation, and an error
  let lastProbe = null;
  const blockSaid = new Map();       // 'txid:vout@height' -> whether that block holds it, once buried deep enough not to move
  // A HELD LOCK JUDGED ONCE: a view runs on every /gateway-seats and /pending, and each read is a signature check on the seat's loop
  const heldSaid = new Map();
  const heldSatsOf = (fid, e, node, heldLock, set) => {
    if (!heldLock || !set) return 0n;
    const k = JSON.stringify([fid, e, node, heldLock, set.threshold, set.seated]);
    if (!heldSaid.has(k)) { if (heldSaid.size >= 64) heldSaid.clear(); heldSaid.set(k, heldLockCounted({ heldLock, federationId: fid, epoch: e, node, seated: set.seated, threshold: set.threshold, verify, epochBlocks }).sats); }
    return heldSaid.get(k);
  };
  const holds = async (o, height, tipNow) => {
    const k = `${o}@${height}`;
    if (blockSaid.has(k)) return blockSaid.get(k);
    let got = null; try { got = outpointAt ? await outpointAt(height, o) : null; } catch { got = null; }
    if (typeof got === 'boolean' && height <= tipNow - 6) { if (blockSaid.size >= 4096) blockSaid.clear(); blockSaid.set(k, got); }
    return got === true;
  };
  async function probe() {
    try { return await probeOnce(); } catch (e) { lastProbe = { atMs: Date.now(), why: String(e && e.message || e).slice(0, 200) }; throw e; }
  }
  // THE EPOCH'S PROBES OUTLIVE A RESTART (kanban #552, 2026-10-20: "Shows 0 of 2 again. Why is this so hard to fix?" - every seat
  // restart cleared them and the seats said "0 of 2" until new probes came in): `keep` { load(fid) -> { epoch: { node: row } }, save(fid,
  // epoch, rows) } - the seat's own database; a claim is kept as the node signed it and is checked again when it is read back
  // AND THE REST OUTLIVES IT TOO (kanban #559, 2026-10-20: "Fix all of it"): the seats this guardian ranked per epoch (the next
  // epoch's holders step back), the epoch's routed volume and the contract stream's index - `keep.state` { load(fid), save(fid, state) }
  let loaded = false;
  const stateOut = () => ({ cursor, seatedBy: Object.fromEntries(seatedBy), volumes: Object.fromEntries([...volumes].map(([e, m]) => [e, Object.fromEntries([...m].map(([k, v]) => [k, String(v)]))])) });
  const saveState = async (fid) => { if (keep && keep.state) { try { await keep.state.save(fid, stateOut()); } catch { /* the next probe */ } } };
  const rowsOut = (rows) => Object.fromEntries([...rows].map(([k, r]) => [k, { probes: r.probes, up: r.up, claim: r.claim, modulePk: r.modulePk || null, fees: r.fees || null }]));
  async function loadKept(fid) {
    if (loaded || !keep) return; loaded = true;
    try {
      const got = (await keep.load(fid)) || {};
      for (const [e, rows] of Object.entries(got)) {
        const m = new Map();
        for (const [node, r] of Object.entries(rows || {})) if (r && r.claim && checkGatewayClaim(r.claim, verify).ok && r.claim.node === node) m.set(node, { probes: Number(r.probes) || 0, up: Number(r.up) || 0, claim: r.claim, ...(r.modulePk ? { modulePk: r.modulePk } : {}), ...(r.fees ? { fees: r.fees } : {}) });
        if (m.size && !epochs.has(Number(e))) epochs.set(Number(e), m);
      }
    } catch { /* none kept */ }
    try {
      const st = keep.state ? (await keep.state.load(fid)) || {} : {};
      if (Number.isInteger(st.cursor)) cursor = st.cursor;
      for (const [e, list] of Object.entries(st.seatedBy || {})) if (Array.isArray(list)) seatedBy.set(Number(e), list.map(String));
      for (const [e, m] of Object.entries(st.volumes || {})) volumes.set(Number(e), new Map(Object.entries(m || {}).map(([k, v]) => [k, BigInt(v)])));
    } catch { /* none kept */ }
  }
  async function probeOnce() {
    const fid = await federationId();
    if (fid) await loadKept(fid);
    if (!fid) return { ok: false, why: 'this node guards no federation' };
    const h = await tip();
    const epoch = Math.floor(h / epochBlocks);
    if (!epochs.has(epoch)) { epochs.set(epoch, new Map()); for (const e of [...epochs.keys()]) if (e < epoch - 1) epochs.delete(e); }
    for (const e of [...volumes.keys()]) if (e < epoch - 1) volumes.delete(e);
    for (const e of [...seatedBy.keys()]) if (e < epoch - 3) seatedBy.delete(e);
    const rows = epochs.get(epoch);
    const all = (await entries()) || [];
    const seatedList = (await seated(fid)) || [];
    const said = { atMs: Date.now(), epoch, seated: seatedList.length, census: all.length, withEndpoint: 0, claims: 0 };
    for (const node of seatedList) {
      const e = all.find((x) => toHex(x.pubkey) === node);
      const ep = e ? endpointOf(e) : null;
      if (!ep) continue;
      said.withEndpoint++;
      let claim = null;
      try {
        // its claim FOR THIS FEDERATION (kanban #552: a seat may stand for a gateway in each federation it guards; an older seat answers its one)
        const r = await fetcher(`${baseOf(ep)}/gateway-claim?federation=${fid}`, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) { const c = await r.json(); if (checkGatewayClaim(c, verify).ok && c.node === node && c.federationId === fid) claim = c; }
      } catch { claim = null; }
      if (!claim) continue;                 // no claim: this node does not stand
      said.claims++;
      const row = rows.get(node) || { probes: 0, up: 0, claim };
      row.probes++; row.claim = claim;
      try {
        const r = await fetcher(`${claim.gatewayUrl}routing_info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fid), signal: AbortSignal.timeout(timeoutMs) });
        const body = r.status === 200 ? (await r.text()).trim() : 'null';
        if (body && body !== 'null') { row.up++; try { const ri = JSON.parse(body), k = ri.module_public_key; if (/^0[23][0-9a-f]{64}$/.test(k || '')) row.modulePk = k;
          // ITS PUBLISHED FEES, the newest probe's (kanban #1324, §23A.9): ranked against the federation's gateway fee cap
          const f = feesOfRoutingInfo(ri); if (f) row.fees = f; } catch { /* no key */ } }
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
    lastProbe = { ...said, standing: rows.size };
    if (keep && rows.size) { try { await keep.save(fid, epoch, rowsOut(rows)); } catch { /* kept next probe */ } }
    await saveState(fid);
    return { ok: true, epoch, standing: rows.size, credited };
  }
  /** The seats as this guardian ranks them now. */
  async function view() {
    const fid = await federationId();
    if (fid) await loadKept(fid);
    if (!fid) return { ok: false, why: 'this node guards no federation' };
    const h = await tip();
    const epoch = Math.floor(h / epochBlocks);
    const at = epochs.has(epoch - 1) ? epoch - 1 : epoch;
    const all = (await entries()) || [];
    // NO CENSUS READ, NO RANKING (2026-10-20 "is this correct?" - a seat right after its restart ranked with no census and said both of
    // Federation 1's gateways had a "bond below bond_min_guardian"): a seat that holds no census yet says so, and judges nothing
    if (!all.length) return { ok: false, federationId: fid, why: 'this seat has not read its census yet (just restarted): ask again in a few minutes' };
    const seatedNow = new Set((await seated(fid)) || []);
    let seats = GATEWAY_SEATS; try { const n = Number(await seatsFor(fid)); if (Number.isInteger(n) && n >= 1) seats = n; } catch { /* two */ }
    // WHERE A GATEWAY ANSWERS NOW, not where it answered in the epoch being ranked (2026-10-30, after a test host reboot: "no gateway made a
    // deposit invoice: https://viewers-propose-businesses-..." - the seats ranked the last whole epoch and said the address of its last probe, a
    // quick tunnel gone with the reboot, while the running epoch's probes already held the gateway's signed new claim). The ranking is the
    // measured epoch's; the address is the newest signed one
    const newestUrlOf = (node, url) => { const r = (epochs.get(epoch) || new Map()).get(node); return (r && r.claim && r.claim.gatewayUrl) || url; };
    // ONE EPOCH RANKED: its probes' candidates, by gateway-seats.js, the epoch before's holders (`inc`) stepping back
    const rank = async (e, inc) => {
      const rows = epochs.get(e) || new Map();
      const candidates = [...rows].map(([node, r]) => {
        const x = all.find((y) => toHex(y.pubkey) === node);
        return { node: Uint8Array.from(Buffer.from(node, 'hex')), operatorId: (x && x.advert && x.advert.operatorId) || node, seatedGuardian: seatedNow.has(node),
          registered: r.up > 0, volumeSats: r.modulePk ? ((volumes.get(e) || new Map()).get(r.modulePk) || 0n) / 1000n : 0n, capacitySats: BigInt(r.claim.capacitySats), inboundSats: BigInt(r.claim.inboundSats || 0), outboundSats: BigInt(r.claim.outboundSats || 0), outsideInboundSats: BigInt(r.claim.outsideInboundSats || 0), pegInSats: BigInt(r.claim.pegInSats),
          availabilityPct: r.probes ? (100 * r.up) / r.probes : 0, bondSats: x ? nodeBondOf(all, node).bondSats : 0n, gatewayUrl: r.claim.gatewayUrl, fees: r.fees || null };
      });
      // PROVED PEG-INS: each claimed outpoint that is one of the federation's own coins, counted once - an outpoint two claims name counts
      // for neither (kanban #559/#543)
      let coins = null; try { coins = await federationCoins(); } catch { coins = null; }
      const named = new Map();
      const itemsOf = (r) => pegInOutpointsOf(r.claim).map(pegInItem);
      for (const [node, r] of rows) for (const { outpoint } of itemsOf(r)) named.set(outpoint, [...(named.get(outpoint) || []), node]);
      const aged = seatingRulesActive(e, rulesEpoch), epochStart = e * epochBlocks, tipNow = aged ? await tip() : null;
      // THE HELD LOCK (§23A.3a, rulings #1029/#1030): from the rules epoch the money must still be there, so the count is min(proved, held);
      // no proof counts 0, and a lock two claims name counts for neither
      let heldSet = null; if (aged) { try { heldSet = await heldSetFor(fid, e); } catch { heldSet = null; } }
      const lockNamed = new Map();
      for (const [, r] of rows) { const o = r.claim.heldLock && String(r.claim.heldLock.outpoint || '').toLowerCase(); if (o) lockNamed.set(o, (lockNamed.get(o) || 0) + 1); }
      const heldOf = (node, r) => { const h = r.claim.heldLock; return h && lockNamed.get(String(h.outpoint || '').toLowerCase()) === 1 ? heldSatsOf(fid, e, node, h, heldSet) : 0n; };
      const proved = new Map(), pastCap = new Map();
      for (const [node, r] of rows) {
        if (!coins) { proved.set(node, null); continue; }
        let sum = 0n;
        for (const { outpoint, height } of itemsOf(r)) {
          if (!coins.has(outpoint) || named.get(outpoint).length !== 1) continue;
          if (!pastCap.has(node)) { let past = false; try { past = await pastCapAt(fid, height); } catch { past = false; } if (past) pastCap.set(node, outpoint); }
          if (aged && !(pegInAgeStands({ height, epochStart, maxAge }) && await holds(outpoint, height, tipNow))) continue;
          sum += coins.get(outpoint);
        }
        if (aged) { const held = heldOf(node, r); if (held < sum) sum = held; }
        proved.set(node, sum);
      }
      const provedOf = (node) => proved.get(node);
      const beacon = await beaconAt(e * epochBlocks);
      if (!beacon) return { ok: false, why: `the epoch's first block ${e * epochBlocks} is not in this seat's chain` };
      for (const c of candidates) { const v = provedOf(toHex(c.node)); c.provedPegInSats = v === null ? 0n : v; if (pastCap.has(toHex(c.node))) c.pegInPastCap = pastCap.get(toHex(c.node)); }
      // PEG-IN PRESSURE, judged on the gateways holding the seats now (the epoch before's): their proved peg-ins against P*
      let pegInStarSats = null;
      try {
        const rec = await pressureFor(fid);
        const holders = candidates.filter((c) => (inc || []).includes(toHex(c.node)));
        const p = rec && holders.length ? pegInPressure({ pegIns: holders.map((c) => ({ node: toHex(c.node), pegInSats: c.provedPegInSats })),
          reserveSats: rec.reserveSats, exposureCapSats: rec.exposureCapSats, band: rec.band || null, status: rec.status || null, pegInMinSats: (GATEWAY_MINIMUMS[network] || GATEWAY_MINIMUMS.mainnet).pegInSats, seats }) : null;
        if (p) pegInStarSats = p.targetPegInSats;
      } catch { pegInStarSats = null; }
      // THE FEE CAP (§23A.9 RULED 2026-11-07, kanban #1324), from the 2.0 seating rules' epoch: the record's gatewayFeeMax, else the reference
      let feeCap = null;
      if (aged) { let rec = null; try { rec = await pressureFor(fid); } catch { rec = null; } feeCap = (rec && rec.gatewayFeeMax) || GATEWAY_FEE_MAX_REFERENCE; }
      const s = seatGateways({ candidates, beacon, epoch: e, incumbents: inc, network, bondMinGuardian, seats, pegInStarSats, feeCap });
      return { ok: true, s: { ...s, ...(pegInStarSats !== null ? { pegInPressure: { targetPegInSats: String(pegInStarSats) } } : {}) }, gateways: Object.fromEntries(candidates.map((c) => [toHex(c.node), { url: newestUrlOf(toHex(c.node), c.gatewayUrl), availabilityPct: Math.round(c.availabilityPct), probes: rows.get(toHex(c.node)).probes, volumeSats: String(c.volumeSats),
        inboundSats: String(c.inboundSats), outboundSats: String(c.outboundSats), outsideInboundSats: String(c.outsideInboundSats), pegInSats: String(rows.get(toHex(c.node)).claim.pegInSats || 0), lightningPubkey: rows.get(toHex(c.node)).claim.lightningPubkey, lightningAddr: rows.get(toHex(c.node)).claim.lightningAddr || '',
        // what the operator states is still on its way (peg-ins confirming, kanban #552): beside the signed claim, shown as stated
        pending: rows.get(toHex(c.node)).claim.pending || null,
        fees: c.fees || null,
        provedPegInSats: (() => { const v = provedOf(toHex(c.node)); return v === null ? null : String(v); })(),
        ...(aged ? { heldLockSats: String(heldOf(toHex(c.node), rows.get(toHex(c.node)))) } : {}) }])) };
    };
    // THE HOLDERS OF THE EPOCH BEFORE: the seating its guardians signed, else this guardian's own ranking of it
    let held = null; try { held = await seatingFor(fid, at - 1); } catch { held = null; }
    const w = await rank(at, Array.isArray(held) ? held : (seatedBy.get(at - 1) || []));
    if (!w.ok) return w;
    if (at < epoch && JSON.stringify(seatedBy.get(at)) !== JSON.stringify(w.s.seated)) { seatedBy.set(at, w.s.seated); await saveState(fid); }
    // AND THE RUNNING EPOCH, AS IT STANDS (kanban #552, measured 2026-10-20 08:36Z: claims for B and its successor stood from 08:07Z, in
    // epoch 1091, which began at 157,104 - the seats rank the last whole epoch, 1090, so every page said "0 of 2" for a day and nothing
    // said why): what the running epoch would seat at its end, and the block it ends at
    let next = null;
    if (at < epoch) { const r = await rank(epoch, w.s.seated); if (r.ok) next = { epoch, fromBlock: (epoch + 1) * epochBlocks, seated: r.s.seated, why: r.s.why, gateways: r.gateways }; }
    return { ok: true, federationId: fid, epoch: at, measuredEpoch: at === epoch ? 'running' : 'whole', seats, ...w.s, gateways: w.gateways, ...(next ? { next } : {}), lastProbe };
  }
  return { probe, view, lastProbe: () => lastProbe };
}
