// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE THIS CLIENT DEALS TO, BUILT BY THE CLIENT (spec 5A.6). It used to be asked of every node
// (`fetchSettlementSignerNodes`, GET /committee) and taken when they agreed - seats that agree can name anybody. Now:
//   1. the headers, agreed from the round's nodes' GET /headers (at least two sources, most work, from the network's
//      compiled-in anchor - directory.js chainAnchorFor);
//   2. the round's census as evidence from GET /census, every entry checked against those headers and the set against
//      the round's census_root (arena-protocol client-committee.js);
//   3. the beacon off the same headers, and the seat's own sortition.
// The nodes' /committee answers are still read, and only compared: a seat naming another set is named in the answer.
// Kept per census and committee time: every round of a series shares them, so a series' second join asks nothing new.
import { verifySeating } from '../../arena-protocol/src/seating.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { committeeFromChain } from '../../arena-protocol/src/client-committee.js';
import { blockHashOf, TESTNET4_ANCHOR_HEIGHT } from '../../arena-protocol/src/chain.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_TESTNET4, ARBITRATION_KEYS_TESTNET4, ARBITRATION_KEYS_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { genesisFor, committeesStand } from '../../arena-protocol/src/genesis.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { agreedChain, httpProvider, headerSources } from './headers.js';
import { explorerAgrees } from './explorer-check.js';
import { chainAnchorFor } from './directory.js';
import { readWithOneRetry } from './reread.js';

/**
 * THE ARBITRATION SET AND BOND TERMS A BOND IS REBUILT WITH, per network: genesis' own (testnetShape: 5 of the 7 keys,
 * template-1 maturity 100). Read from genesis-ids.js rather than genesis.js, which the page's bundle does not carry;
 * client-committee.test.js holds them equal to genesisFor(network).
 */
export const BOND_TERMS = Object.freeze({
  testnet4: Object.freeze({ arbitrationKeys: ARBITRATION_KEYS_TESTNET4, arbitrationK: 5, bondMaturity: 100 }),
  regtest: Object.freeze({ arbitrationKeys: ARBITRATION_KEYS_REGTEST, arbitrationK: 5, bondMaturity: 100 }),
});

const CHAIN_KEPT_MS = 60000;
const keptChains = new Map();     // network:censusHeight:committeeTime -> { at, chain, firstHeight }
const keptCensus = new Map();     // round's census root -> evidence
const keptTooOld = new Map();     // round's census root -> the nodes a seat left out for their protocol version
const keptChecked = new Map();    // round's census root -> the census this client checked (entries), for the series' other rounds

const baseOf = (u) => String(u).replace(/\/+$/, '');
// ONE SOURCE PER SEAT, as join.js counts its chain sources (sourceKey): the origin and the first path segment - testnet4's
// seats share one public host and are told apart by their path
const originOf = (u) => { try { const x = new URL(u); const head = x.pathname.split('/').filter(Boolean)[0] || ''; return head ? `${x.origin}/${head}` : x.origin; } catch { return String(u); } };

/** The height of the network's anchor block: testnet4's compiled-in one, else Bitcoin's genesis. */
export const anchorHeightFor = (networkId) => (networkId instanceof Uint8Array && toHex(networkId) === toHex(NETWORK_ID_TESTNET4) ? TESTNET4_ANCHOR_HEIGHT : 0);

async function chainFor(contract, nodes, { fetcher, least, nowMs, anchorAt, explorer = null }) {
  const key = `${toHex(contract.networkId)}:${contract.censusHeight}:${contract.committeeTimeMs}:${explorer || ''}`;
  const had = keptChains.get(key);
  if (had && nowMs - had.at < CHAIN_KEPT_MS) return had;
  const anchor = anchorAt ? anchorAt.hash : chainAnchorFor(contract.networkId);
  // A FEW SEATS, NOT EVERY ONE (headers.js headerSources): two must agree, two may be slow
  const providers = headerSources(nodes).map((u) => httpProvider(baseOf(u) + '/headers', { tag: originOf(u), fetcher }));
  const chain = await agreedChain(providers, { least: Math.min(least, providers.length), anchor });
  if (!chain.ok) return { ok: false, why: `no agreed headers: ${chain.why}` };
  const at = chain.headers.findIndex((h) => toHex(blockHashOf(h)) === toHex(anchor));
  if (at < 0) return { ok: false, why: 'the agreed headers do not hold the anchor' };
  const firstHeight = (anchorAt ? anchorAt.height : anchorHeightFor(contract.networkId)) - at;
  // A PARTY OUTSIDE THE NETWORK (§5A.4): with an explorer named, the agreed chain's block at the CENSUS HEIGHT must be the
  // explorer's - another block refuses the round by name. The TIP is asked too and only said: testnet4 reorganises 11-14 blocks deep,
  // so a tip that differs can be either side's lag. An explorer that cannot be asked is said, never taken as agreement.
  let explorerSaid = null;
  if (explorer) {
    const at = (height) => (height >= firstHeight && height < firstHeight + chain.headers.length ? [{ height, hash: blockHashOf(chain.headers[height - firstHeight]) }] : []);
    const census = await explorerAgrees({ base: explorer, points: at(Number(contract.censusHeight)), fetcher });
    if (census.mismatch) return { ok: false, why: `the census does not stand outside the network: ${census.why}`, explorer: { census } };
    const tip = await explorerAgrees({ base: explorer, points: at(firstHeight + chain.headers.length - 1), fetcher });
    explorerSaid = { census, tip };
  }
  const got = { ok: true, at: nowMs, chain, firstHeight, explorer: explorerSaid };
  keptChains.set(key, got);
  return got;
}

async function evidenceFor(roundIdHex, contract, nodes, { fetcher, skip = new Set() }) {
  const key = toHex(contract.censusRoot);
  if (keptCensus.has(key) && !skip.size) return { ok: true, entries: keptCensus.get(key), from: 'kept' };
  const refused = [];
  for (const u of nodes) {
    if (skip.has(u)) continue;
    try {
      const r = await readWithOneRetry(fetcher, `${baseOf(u)}/census?round=${roundIdHex}`);
      if (!r.ok) { refused.push(`${u}: ${r.status}`); continue; }
      const j = await r.json();
      if (!j || !Array.isArray(j.entries)) { refused.push(`${u}: no entries`); continue; }
      // the nodes this seat left out for their protocol version: shown, never counted
      if (Array.isArray(j.tooOld)) keptTooOld.set(key, j.tooOld.filter((x) => x && /^[0-9a-f]{64}$/.test(String(x.node))));
      return { ok: true, entries: j.entries, from: u, refused };
    } catch (e) { refused.push(`${u}: ${e.message}`); }
  }
  return { ok: false, why: `no node handed over the census: ${refused.join('; ')}` };
}

/**
 * THIS ROUND'S COMMITTEES, AS THIS CLIENT DERIVES THEM. `curve`: the page's (BLWP_CURVE: bondTweakPoint, bondCombine, verify).
 * Answers { ok, committees: { game, settlement }, beacon, census, headers: { from, agreed, firstHeight, count }, seats: [{ node,
 * agrees, why }] } or { ok: false, why }. `compare: false` skips asking the nodes' /committee.
 */
// `anchorAt` ({ hash, height }) is for a test's own chain only: a page never passes it, and takes the network's compiled-in one.
export async function clientCommittee(roundIdHex, contract, nodes, { curve, fetcher = fetch, least = 2, compare = true, nowMs = Date.now(),
  roles = ['game', 'settlement'], anchorAt = null, explorer = null, genesis = null } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, why: 'no node to ask for the chain and the census' };
  if (!curve || typeof curve.bondTweakPoint !== 'function' || typeof curve.bondCombine !== 'function' || typeof curve.verify !== 'function')
    return { ok: false, why: 'this page brings no curve to rebuild the bonds with' };
  const network = networkOf(contract.networkId);
  // A CONTRACT BOUND TO ITS GENESIS (§5A.7 / §27A.62026-10-16: "the client refuses to join and names the
  // mismatched parameter, at join time"): where the network's genesis binds (mainnet; a binding test genesis passed as `genesis`), a
  // contract naming other committee slots, threshold or census confirmations is refused by that parameter's name, as the seat refuses
  // it at POST /round. testnet4's genesis does not bind (2026-10-14 ruling): its contracts keep their own values.
  const binds = committeesStand(contract, genesis || (network ? genesisFor(network) : null));
  if (!binds.ok) return { ok: false, why: `the round is refused: ${binds.why}`, genesisOff: binds.off };
  if (!network) return { ok: false, why: 'that round names a network this client has no genesis for' };
  const g = BOND_TERMS[network];
  if (!g) return { ok: false, why: `this client carries no bond terms for ${network}` };
  const t0 = Date.now();
  let [chain, evidence] = await Promise.all([chainFor(contract, nodes, { fetcher, least, nowMs, anchorAt, explorer }), evidenceFor(roundIdHex, contract, nodes, { fetcher })]);
  if (!chain.ok) {
    // A CENSUS THAT DOES NOT STAND OUTSIDE THE NETWORK IS OBJECTED (§5A.4): handed to every seat, each checks it on its
    // own chain against the same explorer; upheld, the round takes no new entry there - so other clients refuse it too
    if (chain.explorer && chain.explorer.census && chain.explorer.census.mismatch && explorer) {
      chain.objected = await Promise.all(nodes.map(async (u) => {
        try { const r = await fetcher(`${baseOf(u)}/census-objection`, { method: 'POST', body: JSON.stringify({ round: roundIdHex, explorer }) }); return { node: u, upheld: r.ok }; }
        catch { return { node: u, upheld: false }; }
      }));
    }
    return chain;
  }
  const t1 = Date.now();
  const roundId = Uint8Array.from(roundIdHex.match(/../g).map((h) => parseInt(h, 16)));
  // A CENSUS THAT DOES NOT HASH TO THE CONTRACT'S ROOT NAMES ITS SEAT, AND THE NEXT SEAT IS ASKED (the spec's "The client computes the
  // committee itself": "A census entry missing from what a node sent shows as a root that does not match the contract's census_root,
  // and the client asks another source"measured 2026-10-16: one seat's census with an entry dropped refused the whole
  // round and named nobody)
  const censusRefused = []; const skip = new Set();
  let got;
  for (;;) {
    if (!evidence.ok) return { ...evidence, why: evidence.why + (censusRefused.length ? `; ${censusRefused.map((x) => `${x.node}: ${x.why}`).join('; ')}` : ''), censusRefused };
    got = committeeFromChain({ contract, roundId, headers: chain.chain.headers, firstHeight: chain.firstHeight, evidence: evidence.entries, roles,
      bond: { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity, tweakPoint: curve.bondTweakPoint, combine: curve.bondCombine },
      verify: curve.verify, census: skip.size ? null : keptChecked.get(toHex(contract.censusRoot)) || null });
    if (got.ok || evidence.from === 'kept' || !/^the census the seats handed over hashes to /.test(String(got.why))) break;
    censusRefused.push({ node: evidence.from, why: `its census ${String(got.why).replace(/^the census the seats handed over /, '')}` });
    skip.add(evidence.from);
    evidence = await evidenceFor(roundIdHex, contract, nodes, { fetcher, skip });
  }
  if (!got.ok) return { ...got, censusRefused };
  keptCensus.set(toHex(contract.censusRoot), evidence.entries);
  keptChecked.set(toHex(contract.censusRoot), got.checkedCensus ? { ...got.checkedCensus, height: Number(contract.censusHeight) } : got.checkedCensus);
  // THE SEATING (§5A.7 reserve seats): each role's certificate, asked of the seats and checked against the draw
  // this client made itself - every seated node signed it, in score order, within the seats and at least the threshold. A
  // checked certificate's seated are the committee. `seating[role]`: { seated, from } checked; { missing } when a seat
  // speaks seating but none handed one that stands; null where no seat speaks seating at all (seats before).
  got.seating = {};
  // A TABLE'S ROUND IS SEATED BY ITS TABLE'S FIRST ROUND (pick (c)): that round's certificate, asked and checked as its own
  const anchor = tableAnchorOf(contract);
  const seatId = anchor ? anchor.anchorId : roundId;
  const seatHex = toHex(seatId);
  for (const role of roles) {
    let spoke = false; const refused = [];
    let found = null;
    for (const u of nodes) {
      try {
        const r = await fetcher(`${baseOf(u)}/seating?round=${seatHex}&role=${role}`);
        const body = await r.text();
        if (r.status === 404 && /no seating certificate/.test(body)) { spoke = true; continue; }
        if (!r.ok) continue;
        spoke = true;
        const cert = JSON.parse(body).cert;
        const v = verifySeating(fromHex(cert), { roundId: seatId, role, drawn: got.drawn[role], slots: slotsForRole(contract, role), verify: curve.verify });
        if (v.ok) { found = { seated: v.seating.seated, from: u }; break; }
        refused.push(`${u}: ${v.why}`);
      } catch { /* that seat says nothing */ }
    }
    // A CERTIFICATE THAT DID NOT CHECK IS KEPT BESIDE THE ONE THAT DID (measured 2026-10-16 on live testnet4: guardian-1 handing a
    // seating with another node seated was refused here, and guardian-2's standing certificate dropped that refusal - the lying seat
    // went unnamed); settlementSignerNodesFrom refuses the round on it
    got.seating[role] = found ? { ...found, refused } : spoke ? { missing: true, refused } : null;
    if (found) got.committees[role] = found.seated;
  }
  // EVERY SEAT'S ANSWER FOR EVERY ROLE, against this client's own (the settlement role alone was compared). A seat agrees
  // when every role it answered is the client's; null when it answered none (a seat that does not hold the round: not a lie)
  const seats = [];
  if (compare) {
    await Promise.all(nodes.map(async (u) => {
      const said = {};
      for (const role of roles) {
        const mine = (got.committees[role] || []).map(toHex).sort().join(',');
        try {
          const r = await readWithOneRetry(fetcher, `${baseOf(u)}/committee?role=${role}&round=${roundIdHex}`);
          if (!r.ok) { said[role] = { agrees: null, why: `answered ${r.status}` }; continue; }
          const b = new Uint8Array(await r.arrayBuffer());
          const keys = []; for (let i = 0; i + 32 <= b.length; i += 32) keys.push(toHex(b.subarray(i, i + 32)));
          const agrees = keys.sort().join(',') === mine;
          said[role] = { agrees, why: agrees ? null : `names another ${role} committee (${keys.map((k) => k.slice(0, 8)).join(', ') || 'none'}) than the one this client derived (${mine.split(',').map((k) => k.slice(0, 8)).join(', ')})` };
        } catch (e) { said[role] = { agrees: null, why: e.message }; }
      }
      const answered = Object.values(said).filter((x) => x.agrees !== null);
      const differ = Object.values(said).filter((x) => x.agrees === false);
      seats.push({ node: u, agrees: answered.length ? !differ.length : null, why: differ.length ? differ.map((x) => x.why).join('; ') : answered.length ? null : Object.values(said).map((x) => x.why).join('; '), roles: said });
    }));
  }
  return { ...got, censusRefused, explorer: chain.explorer || null, headers: { from: chain.chain.from, agreed: chain.chain.agreed, firstHeight: chain.firstHeight, count: chain.chain.headers.length },
    seats, ms: { chainAndCensus: t1 - t0, total: Date.now() - t0 } };
}

/**
 * WHAT A JOIN DEALS TO (replaces `fetchSettlementSignerNodes`): the settlement committee this client derived. Refused when the client
 * cannot derive it - and, by the spec's "The client computes the committee itself" (RULED 2026-09-28), when ANY seat's committee
 * answer or seating certificate differs from the client's own computation: "the round is refused, the lobby says which node answered
 * what, and no share is sealed, no stake locked, no entry signed" (measured 2026-10-16 on live testnet4: one seat
 * forging its /committee was named and the join still dealt to the client's seven).
 */
export async function clientSettlementSignerNodes(roundIdHex, contract, nodes, opts = {}) {
  return settlementSignerNodesFrom(await clientCommittee(roundIdHex, contract, nodes, opts));
}
/** The decision of clientSettlementSignerNodes over a derivation (clientCommittee's answer): the signer nodes, or a refusal naming who answered what. */
export function settlementSignerNodesFrom(got) {
  if (!got || !got.ok) throw new Error(`this client could not build the round's committee itself: ${got ? got.why : 'nothing derived'}`);
  // NO ENTRY WITHOUT A CHECKED SEATING where the seats seat (§5A.7): the stake is dealt to who a certificate seats
  for (const role of ['game', 'settlement']) {
    const st = got.seating && got.seating[role];
    if (st && st.missing) throw new Error(`that round has no signer nodes yet: no certificate naming its ${role} signer nodes stands${st.refused.length ? ` (${st.refused[0]})` : ''} - nothing is entered (§5A.7)`);
  }
  const named = [];
  for (const s of got.seats || []) if (s.agrees === false) named.push(`${s.node} ${s.why}`);
  for (const role of ['game', 'settlement']) {
    const st = got.seating && got.seating[role];
    for (const why of (st && Array.isArray(st.refused) ? st.refused : [])) named.push(`a ${role} seating certificate that does not match this client's draw - ${why}`);
  }
  if (named.length)
    throw new Error(`the round is refused: ${named.join('; ')} - nothing is sealed, locked or signed`);
  return { signerNodes: got.committees.settlement, agreed: (got.seats || []).filter((s) => s.agrees).length,
    refused: (got.censusRefused || []).map((x) => `${x.node}: ${x.why}`), derived: got };
}

/**
 * THE NODES LEFT OUT FOR THEIR PROTOCOL VERSION (scope 3, "the page shows node X: protocol too old"): as the seat that
 * handed over the census named them ([{ node, speaks }]), or []. Shown beside the facts, never counted: the census root decides.
 */
export const tooOldFor = (contract) => keptTooOld.get(toHex(contract.censusRoot)) || [];
/** The census this client checked for a round's census root (its entries, with their advertisements), or null. */
// null for a contract naming no census root (the page hands this whole, and names no contract field itself: join.test.js)
export const checkedCensusFor = (contract) => { if (!contract || !(contract.censusRoot instanceof Uint8Array)) return null; const c = keptChecked.get(toHex(contract.censusRoot)); return c ? c.entries : null; };
/**
 * THE NEWEST CENSUS THIS CLIENT CHECKED, and how many nodes it bonds (2026-10-12: "in the same settings
 * window show how many nodes the network currently has"): the census at the highest height among the rounds this page checked,
 * its distinct node keys counted. null before any census is checked.
 */
export function newestCheckedCensus() {
  let best = null;
  for (const c of keptChecked.values()) if (c && Array.isArray(c.entries) && (!best || (c.height || 0) > (best.height || 0))) best = c;
  if (!best) return null;
  const keys = new Set(best.entries.map((e) => toHex(e.pubkey)));
  return { height: best.height || null, nodes: keys.size, entries: best.entries };
}
