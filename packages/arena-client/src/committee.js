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
import { seriesRoundIdOf } from '../../arena-protocol/src/contracts.js';
import { agreedChain, httpProvider, headerSources } from './headers.js';
import { fetchRound } from './join.js';
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

const CHAIN_KEPT_MS = 180000;
export const COMPARE_GRACE_MS = 400;
const SEATING_ASK_MS = 6000;
/** Resolves once every promise settled, or `graceMs` after more than half did - whichever is first (kanban #625: no wait for the slowest seat). */
export function majorityThenGrace(promises, graceMs) {
  return new Promise((resolve) => {
    let done = 0, timer = null;
    const one = () => {
      done++;
      if (done === promises.length) { clearTimeout(timer); resolve(); }
      else if (!timer && done * 2 > promises.length) timer = setTimeout(resolve, graceMs);
    };
    if (!promises.length) resolve();
    for (const p of promises) Promise.resolve(p).then(one, one);
  });
}
const keptChains = new Map();     // network:explorer -> [{ at, chain, firstHeight }], newest last
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
  // ONE AGREED CHAIN FOR EVERY ROUND IT HOLDS (kanban #618, 2026-10-24: "Order submitted in 16.78 s"; measured on UI 363: 16.2 s of
  // a first order were this read, done again for every round - the lobby's round and the order's, same census and beacon - because the
  // kept chain was keyed by the round's committee time): a chain read in the last CHAIN_KEPT_MS serves any round whose census height it
  // holds and whose beacon - the first block after committee_time (beacon.js) - is already in it; else it is read again
  const key = `${toHex(contract.networkId)}:${explorer || ''}`;
  const serves = (k) => {
    if (!k || nowMs - k.at >= CHAIN_KEPT_MS) return false;
    const last = k.firstHeight + k.chain.headers.length - 1;
    if (Number(contract.censusHeight) < k.firstHeight || Number(contract.censusHeight) > last) return false;
    const timeOf = (h) => BigInt(new DataView(h.buffer, h.byteOffset + 68, 4).getUint32(0, true)) * 1000n;
    return k.chain.headers.some((h) => timeOf(h) > BigInt(contract.committeeTimeMs));
  };
  const had = (keptChains.get(key) || []).filter(serves).pop();
  if (had) return had;
  const anchor = anchorAt ? anchorAt.hash : chainAnchorFor(contract.networkId);
  // A FEW SEATS, NOT EVERY ONE (headers.js headerSources): two must agree, two may be slow
  const picked = headerSources(nodes);
  const providers = picked.map((u) => httpProvider(baseOf(u) + '/headers', { tag: originOf(u), fetcher }));
  let chain = await agreedChain(providers, { least: Math.min(least, providers.length), anchor });
  // AND THE OTHER SEATS WHEN TOO FEW OF THOSE ANSWERED (playtest 2026-10-24 21:08Z: "no agreed headers: only 1 of 4 providers gave a
  // chain" - two of the four picked were second-host seats answering /headers in 4-15 s right after a restart, while 12 others answered in
  // 0.2 s): every seat not asked yet is asked, the same two needed to agree
  if (!chain.ok) {
    const askedKeys = new Set(picked.map(originOf));
    const rest = headerSources(nodes, { n: 64 }).filter((u) => !askedKeys.has(originOf(u)));
    if (rest.length) {
      const more = rest.map((u) => httpProvider(baseOf(u) + '/headers', { tag: originOf(u), fetcher }));
      const again = await agreedChain(more, { least: Math.min(least, more.length), anchor });
      chain = again.ok ? again : { ...chain, why: `${chain.why}; the other ${rest.length} seat(s): ${again.why}` };
    }
  }
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
  keptChains.set(key, [...(keptChains.get(key) || []).filter((k) => nowMs - k.at < CHAIN_KEPT_MS).slice(-3), got]);
  return got;
}

/** How many independent providers a bond list must come from before the client pays (§25.1 RULED 2026-11-07, kanban #1312/#1333). */
export const CENSUS_PROVIDERS_TO_LOCK = 2;
/**
 * THE BOND LIST FROM TWO PROVIDERS, AS THEIR UNION (§25.1 RULED 2026-11-07, kanban #1312/#1333): "Omission is the attack, so the second source is
 * normative: a client that pays takes bond lists from at least two independent providers and uses the union ... A list that one provider serves
 * alone is enough to look, not to lock." Each provider is a distinct node (its endpoint root); the entries are joined by bond outpoint, so a bond
 * one of them left out is back in the union - and a union that no longer matches the round's census_root is then refused by the root check.
 * One provider alone answers { ok: false, lookOnly: true }. Not yet here: §25.1's completeness from BIP158 filters since a census checkpoint
 * (no filter source in the browser yet).
 */
async function evidenceFor(roundIdHex, contract, nodes, { fetcher, skip = new Set(), providers = CENSUS_PROVIDERS_TO_LOCK }) {
  const key = toHex(contract.censusRoot);
  if (keptCensus.has(key) && !skip.size) return { ok: true, entries: keptCensus.get(key), from: 'kept' };
  const refused = [], got = [], roots = new Set();
  for (const u of nodes) {
    if (skip.has(u) || got.length >= providers) continue;
    const root = String(baseOf(u)).toLowerCase();
    if (roots.has(root)) continue;
    try {
      const r = await readWithOneRetry(fetcher, `${baseOf(u)}/census?round=${roundIdHex}`);
      if (!r.ok) { refused.push(`${u}: ${r.status}`); continue; }
      const j = await r.json();
      if (!j || !Array.isArray(j.entries)) { refused.push(`${u}: no entries`); continue; }
      // the nodes this seat left out for their protocol version: shown, never counted
      if (Array.isArray(j.tooOld)) keptTooOld.set(key, j.tooOld.filter((x) => x && /^[0-9a-f]{64}$/.test(String(x.node))));
      roots.add(root); got.push({ from: u, entries: j.entries });
    } catch (e) { refused.push(`${u}: ${e.message}`); }
  }
  if (!got.length) return { ok: false, why: `no node handed over the census: ${refused.join('; ')}` };
  if (got.length < providers) return { ok: false, lookOnly: true, from: got[0].from, entries: got[0].entries, refused,
    why: `only ${got.length} provider handed over the census - a bond list one provider serves alone is enough to look, not to lock (${refused.join('; ') || 'no other answered'})` };
  return { ok: true, entries: unionOfEntries(got.map((g) => g.entries)), from: got.map((g) => g.from).join(' + '), fromNodes: got.map((g) => g.from), refused };
}
/**
 * Census entries from several providers, joined by bond; the first copy of each bond is kept. A seat's GET /census entry is the bond's evidence
 * ({ transaction, position, branch, update }), so a bond is its raw transaction there; an entry naming txid and vout is keyed by them (#1333:
 * keyed by txid:vout alone, the 18 live entries all became "undefined:undefined" - one entry, a root that never matched).
 */
const bondKeyOf = (e) => (e && e.txid !== undefined && e.vout !== undefined
  ? `o:${Array.isArray(e.txid) || e.txid instanceof Uint8Array ? toHex(Uint8Array.from(e.txid)) : String(e.txid)}:${e.vout}`
  : `t:${typeof e?.transaction === 'string' ? e.transaction : JSON.stringify(e)}`);
export function unionOfEntries(lists) {
  const byBond = new Map();
  for (const list of lists) for (const e of list || []) {
    const k = bondKeyOf(e);
    if (!byBond.has(k)) byBond.set(k, e);
  }
  return [...byBond.values()];
}
export { evidenceFor as censusEvidenceFor };

/**
 * THIS ROUND'S COMMITTEES, AS THIS CLIENT DERIVES THEM. `curve`: the page's (ARENA_CURVE: bondTweakPoint, bondCombine, verify).
 * Answers { ok, committees: { game, settlement }, beacon, census, headers: { from, agreed, firstHeight, count }, seats: [{ node,
 * agrees, why }] } or { ok: false, why }. `compare: false` skips asking the nodes' /committee.
 */
// `anchorAt` ({ hash, height }) is for a test's own chain only: a page never passes it, and takes the network's compiled-in one.
// A SEATING CERTIFICATE CHECKED ONCE (kanban #1391, Daniel 2026-11-09 "Make sure it is everything fast"; profiled on live UI 604: 2.1 s of every minute of an
// RPS page went to verifySeating - every seat hands the same table certificate, for every round of the table): its answer kept under everything it was
// checked with - the certificate, the round, the role, the drawn keys, the slots
const SEATING_CHECKED = new Map(), SEATING_CHECKED_MAX = 5000;
const seatingChecked = (certHex, o) => {
  const k = [String(certHex), toHex(o.roundId), o.role, (o.drawn || []).map((x) => toHex(x.key || x)).join(','), JSON.stringify(o.slots)].join('|');
  let v = SEATING_CHECKED.get(k);
  if (!v) { v = verifySeating(fromHex(certHex), o); if (SEATING_CHECKED.size >= SEATING_CHECKED_MAX) SEATING_CHECKED.delete(SEATING_CHECKED.keys().next().value); SEATING_CHECKED.set(k, v); }
  return v;
};
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
    // each provider of a union that did not hash to the root is skipped (#1333: skipping the joined "a + b" skipped nobody, and the same pair came back forever)
    for (const n of evidence.fromNodes || [evidence.from]) skip.add(n);
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
  // ONE READ OF A ROLE'S SEATING. `every`: wait for every seat, not for a majority and the grace.
  const askSeating = async (role, every = false) => {
    let spoke = false; const refused = [];
    // A CERTIFICATE OF ANOTHER ROUND (kanban #1389, Daniel's playtest 2026-11-09 ~11:05Z, UI 594: the old test host's seats, on an older tree, seated each
    // round of an RPS table on its own and answered that round's certificate, where the table's first round seats it): no lie about this round's
    // seating, so it does not refuse the round when a checked certificate stands - it is said in the console; with none standing it still counts
    const other = [];
    let found = null;
    // EVERY SEAT ASKED AT ONCE, EACH WITHIN SEATING_ASK_MS (kanban #625, measured 2026-10-24 20:07Z: asked one after the other with no
    // limit, a restarting seat held an order's committee 20 s): read in the seats' order once more than half answered and the grace passed
    const said = new Array(nodes.length).fill(null);
    const asked = nodes.map(async (u, i) => {
      try { const r = await fetcher(`${baseOf(u)}/seating?round=${seatHex}&role=${role}${anchor ? `&at=${toHex(roundId)}` : ''}`, { signal: AbortSignal.timeout(SEATING_ASK_MS) }); said[i] = { status: r.status, ok: r.ok, body: await r.text() }; }
      catch { said[i] = null; }
    });
    if (every) await Promise.all(asked); else await majorityThenGrace(asked, COMPARE_GRACE_MS);
    for (const [i, u] of nodes.entries()) {
      try {
        const r = said[i];
        if (!r) continue;
        const body = r.body;
        if (r.status === 404 && /no seating certificate/.test(body)) { spoke = true; continue; }
        if (!r.ok) continue;
        spoke = true;
        const { cert, index = 0 } = JSON.parse(body);
        // A TABLE'S LATER SEATING (kanban #1020): a check-in of this table at or before this round; of those a seat hands, the newest stands
        if (anchor && index > contract.roundIndex) { refused.push(`${u}: a seating of a later round of the table`); continue; }
        const v = seatingChecked(cert, { roundId: anchor && index > 0 ? seriesRoundIdOf(contract.seriesId, index) : seatId, role, drawn: got.drawn[role], slots: slotsForRole(contract, role), verify: curve.verify });
        if (v.ok) {
          if (!found || index > found.index) found = { seated: v.seating.seated, from: u, index };
          if (!anchor) break;
          continue;
        }
        if (/names another round/.test(String(v.why))) other.push(`${u}: ${v.why}`); else refused.push(`${u}: ${v.why}`);
      } catch { /* that seat says nothing */ }
    }
    // A CERTIFICATE THAT DID NOT CHECK IS KEPT BESIDE THE ONE THAT DID (measured 2026-10-16 on live testnet4: guardian-1 handing a
    // seating with another node seated was refused here, and guardian-2's standing certificate dropped that refusal - the lying seat
    // went unnamed); settlementSignerNodesFrom refuses the round on it
    if (found && other.length) console.warn(`[arena] #1389 ${role} seating of ${seatHex.slice(0, 8)}: ${other.length} seat(s) answered another round's certificate (an older seat): ${other.join('; ')}`);
    return { found, spoke, refused: found ? refused : [...refused, ...other], other, answered: said.some(Boolean) };
  };
  const keepSeating = (role, s) => {
    // NO ANSWER AT ALL IS NOT "NO SEATING" (kanban #1036, the owner's Android 2026-11-02 ~17:05Z: every seat refused, and the client's list held the offline b36828fa; reproduced
    // with the game role's read failing, 6 of 12 live rounds refused, 0 of 12 with it working): the client's draw stood in for the certificate, an offline node at the top of a
    // draw is what seating leaves out, so a read that came back empty looked like every seat lying. `unread` says so.
    got.seating[role] = s.found ? { ...s.found, refused: s.refused } : s.spoke ? { missing: true, refused: s.refused } : s.answered ? null : { unread: true, refused: s.refused };
    if (s.found) got.committees[role] = s.found.seated;
  };
  for (const role of roles) {
    let s = await askSeating(role);
    if (!s.found && !s.answered) s = await askSeating(role);
    keepSeating(role, s);
  }
  // EVERY SEAT'S ANSWER FOR EVERY ROLE, against this client's own (the settlement role alone was compared). A seat agrees
  // when every role it answered is the client's; null when it answered none (a seat that does not hold the round: not a lie)
  const seats = [];
  if (compare) {
    // NOT HELD FOR THE SLOWEST SEAT (kanban #625, measured 2026-10-24 19:10Z: one stalled seat held an order's committee 4.9 s while
    // every other seat answered in ms): once more than half the seats answered, the rest get COMPARE_GRACE_MS more; one that has not
    // answered by then is named as not answering (agrees null - as a seat that does not hold the round), and a lie it tells later is
    // still no part of the committee this client derived itself
    const judge = (role, keys) => {
      const mine = (got.committees[role] || []).map(toHex).sort().join(',');
      const agrees = keys.join(',') === mine;
      return { agrees, why: agrees ? null : `names another ${role} committee (${keys.map((k) => k.slice(0, 8)).join(', ') || 'none'}) than the one this client derived (${mine.split(',').map((k) => k.slice(0, 8)).join(', ')})` };
    };
    const verdict = (said) => {
      const answered = Object.values(said).filter((x) => x.agrees !== null);
      const differ = Object.values(said).filter((x) => x.agrees === false);
      return { agrees: answered.length ? !differ.length : null, why: differ.length ? differ.map((x) => x.why).join('; ') : answered.length ? null : Object.values(said).map((x) => x.why).join('; ') };
    };
    const answeredBy = new Set(); let closed = false;
    const each = nodes.map(async (u) => {
      const said = {};
      for (const role of roles) {
        try {
          const r = await readWithOneRetry(fetcher, `${baseOf(u)}/committee?role=${role}&round=${roundIdHex}`);
          if (!r.ok) { said[role] = { agrees: null, why: `answered ${r.status}` }; continue; }
          const b = new Uint8Array(await r.arrayBuffer());
          const keys = []; for (let i = 0; i + 32 <= b.length; i += 32) keys.push(toHex(b.subarray(i, i + 32)));
          said[role] = { keys: keys.sort(), ...judge(role, keys) };
        } catch (e) { said[role] = { agrees: null, why: e.message }; }
      }
      if (closed) return;
      seats.push({ node: u, ...verdict(said), roles: said });
      answeredBy.add(u);
    });
    await majorityThenGrace(each, COMPARE_GRACE_MS);
    closed = true;
    for (const u of nodes) if (!answeredBy.has(u)) seats.push({ node: u, agrees: null, why: `no committee answer within ${COMPARE_GRACE_MS} ms of the other seats` });
    // A SEAT THAT DIFFERS IS ASKED ABOUT ONCE MORE BEFORE ANYONE IS CALLED A LIAR (kanban #1036, the owner 2026-11-02: "Eine Runde darf fuer den client nicht fehlschlagen, nur
    // weil eine Node offline ist"): the certificate may be what this client missed, in a read that came back empty or in the seats that fell outside the grace. Every seat is
    // waited for now, and the comparison is made again on what they hand.
    if (seats.some((s) => s.agrees === false)) {
      for (const role of roles) {
        const s = await askSeating(role, true);
        if (s.found || !got.seating[role] || got.seating[role].unread) {
          if (!s.found || !got.seating[role] || !(got.seating[role].index > s.found.index)) keepSeating(role, s);
        }
      }
      for (const s of seats) {
        if (!s.roles) continue;
        for (const [role, x] of Object.entries(s.roles)) if (x.keys) Object.assign(x, judge(role, x.keys));
        Object.assign(s, verdict(s.roles));
      }
    }
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
  const named = [], who = [];
  for (const s of got.seats || []) if (s.agrees === false) { named.push(`${s.node} ${s.why}`); who.push(s.node); }
  // NOT A LIE, AN UNANSWERED READ (kanban #1036): the client has no certificate to hold the seats against, so nobody is named, the round is not closed, and the next try reads again
  if (who.length && ['game', 'settlement'].some((role) => got.seating && got.seating[role] && got.seating[role].unread)) {
    console.warn(`[arena] #1036 seating unread: ${named.join('; ')}`);
    throw new Error('the seats did not answer in time - nothing is sealed, locked or signed. Try again.');
  }
  for (const role of ['game', 'settlement']) {
    const st = got.seating && got.seating[role];
    for (const why of (st && Array.isArray(st.refused) ? st.refused : [])) named.push(`a ${role} seating certificate that does not match this client's draw - ${why}`);
  }
  if (named.length) {
    // ONE LINE ON THE SCREEN (kanban #1036, the owner's phone: nine seats with two lists of seven ids each filled it and could not be read): who, in a few words; the rest on
    // the error's `detail` and in the console, as "the lobby says which node answered what" asks
    const detail = named.join('; ');
    console.warn(`[arena] the round is refused: ${detail}`);
    const line = who.length === 1 && named.length === 1 ? `${who[0]} names other signer nodes than this client worked out` : who.length ? `${who.length} seat${who.length === 1 ? '' : 's'} name other signer nodes than this client worked out` : 'a seating certificate does not match this client\'s draw';
    const e = new Error(`the round is refused: ${line} - nothing is sealed, locked or signed`);
    e.detail = detail;
    throw e;
  }
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

/**
 * A ROUND'S DRAWN ATTESTORS, AS THIS PAGE DERIVES THEM (kanban #630): its contract read by id from the seats (it hashes to the id), and
 * the 7 drawn on the census and beacon this page checks itself (client-committee.js attestors) - hex keys, or null. Kept per round:
 * a round's draw never changes.
 */
const ATTESTORS_KEPT = new Map();
export async function roundAttestors(roundIdHex, nodes, { curve, fetcher = fetch } = {}) {
  if (ATTESTORS_KEPT.has(roundIdHex)) return ATTESTORS_KEPT.get(roundIdHex);
  let contract;
  try { contract = (await fetchRound(roundIdHex, nodes, { fetcher })).contract; } catch { return null; }
  if (!contract) return null;
  const got = await clientCommittee(roundIdHex, contract, nodes, { curve, fetcher, compare: false, roles: ['settlement'] });
  const keys = got && got.ok && Array.isArray(got.attestors) ? got.attestors.map((k) => toHex(k)) : null;
  if (keys) { ATTESTORS_KEPT.set(roundIdHex, keys); if (ATTESTORS_KEPT.size > 500) ATTESTORS_KEPT.delete(ATTESTORS_KEPT.keys().next().value); }
  return keys;
}
