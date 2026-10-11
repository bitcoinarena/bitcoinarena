// THE COMMITTEE THIS CLIENT DEALS TO, BUILT BY THE CLIENT (kanban #296, spec 5A.6). It used to be asked of every node
// (`fetchSettlementSignerNodes`, GET /committee) and taken when they agreed - seats that agree can name anybody. Now:
//   1. the headers, agreed from the round's nodes' GET /headers (at least two sources, most work, from the network's
//      compiled-in anchor - directory.js chainAnchorFor);
//   2. the round's census as evidence from GET /census, every entry checked against those headers and the set against
//      the round's census_root (arena-protocol client-committee.js);
//   3. the beacon off the same headers, and the seat's own sortition.
// The nodes' /committee answers are still read, and only compared: a seat naming another set is named in the answer.
// Kept per census and committee time: every round of a series shares them, so a series' second join asks nothing new.
import { committeeFromChain } from '../../arena-protocol/src/client-committee.js';
import { blockHashOf, TESTNET4_ANCHOR_HEIGHT } from '../../arena-protocol/src/chain.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_TESTNET4, ARBITRATION_KEYS_TESTNET4, ARBITRATION_KEYS_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { agreedChain, httpProvider } from './headers.js';
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
const keptChecked = new Map();    // round's census root -> the census this client checked (entries), for the series' other rounds

const baseOf = (u) => String(u).replace(/\/+$/, '');
// ONE SOURCE PER SEAT, as join.js counts its chain sources (sourceKey): the origin and the first path segment - testnet4's
// seats share one public host and are told apart by their path
const originOf = (u) => { try { const x = new URL(u); const head = x.pathname.split('/').filter(Boolean)[0] || ''; return head ? `${x.origin}/${head}` : x.origin; } catch { return String(u); } };

/** The height of the network's anchor block: testnet4's compiled-in one, else Bitcoin's genesis. */
export const anchorHeightFor = (networkId) => (networkId instanceof Uint8Array && toHex(networkId) === toHex(NETWORK_ID_TESTNET4) ? TESTNET4_ANCHOR_HEIGHT : 0);

async function chainFor(contract, nodes, { fetcher, least, nowMs, anchorAt }) {
  const key = `${toHex(contract.networkId)}:${contract.censusHeight}:${contract.committeeTimeMs}`;
  const had = keptChains.get(key);
  if (had && nowMs - had.at < CHAIN_KEPT_MS) return had;
  const anchor = anchorAt ? anchorAt.hash : chainAnchorFor(contract.networkId);
  const providers = nodes.map((u) => httpProvider(baseOf(u) + '/headers', { tag: originOf(u), fetcher }));
  const chain = await agreedChain(providers, { least: Math.min(least, providers.length), anchor });
  if (!chain.ok) return { ok: false, why: `no agreed headers: ${chain.why}` };
  const at = chain.headers.findIndex((h) => toHex(blockHashOf(h)) === toHex(anchor));
  if (at < 0) return { ok: false, why: 'the agreed headers do not hold the anchor' };
  const got = { ok: true, at: nowMs, chain, firstHeight: (anchorAt ? anchorAt.height : anchorHeightFor(contract.networkId)) - at };
  keptChains.set(key, got);
  return got;
}

async function evidenceFor(roundIdHex, contract, nodes, { fetcher }) {
  const key = toHex(contract.censusRoot);
  if (keptCensus.has(key)) return { ok: true, entries: keptCensus.get(key), from: 'kept' };
  const refused = [];
  for (const u of nodes) {
    try {
      const r = await readWithOneRetry(fetcher, `${baseOf(u)}/census?round=${roundIdHex}`);
      if (!r.ok) { refused.push(`${u}: ${r.status}`); continue; }
      const j = await r.json();
      if (!j || !Array.isArray(j.entries)) { refused.push(`${u}: no entries`); continue; }
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
  roles = ['game', 'settlement'], anchorAt = null } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, why: 'no node to ask for the chain and the census' };
  if (!curve || typeof curve.bondTweakPoint !== 'function' || typeof curve.bondCombine !== 'function' || typeof curve.verify !== 'function')
    return { ok: false, why: 'this page brings no curve to rebuild the bonds with' };
  const network = networkOf(contract.networkId);
  if (!network) return { ok: false, why: 'that round names a network this client has no genesis for' };
  const g = BOND_TERMS[network];
  if (!g) return { ok: false, why: `this client carries no bond terms for ${network}` };
  const t0 = Date.now();
  const [chain, evidence] = await Promise.all([chainFor(contract, nodes, { fetcher, least, nowMs, anchorAt }), evidenceFor(roundIdHex, contract, nodes, { fetcher })]);
  if (!chain.ok) return chain;
  if (!evidence.ok) return evidence;
  const t1 = Date.now();
  const roundId = Uint8Array.from(roundIdHex.match(/../g).map((h) => parseInt(h, 16)));
  const got = committeeFromChain({ contract, roundId, headers: chain.chain.headers, firstHeight: chain.firstHeight, evidence: evidence.entries, roles,
    bond: { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity, tweakPoint: curve.bondTweakPoint, combine: curve.bondCombine },
    verify: curve.verify, census: keptChecked.get(toHex(contract.censusRoot)) || null });
  if (!got.ok) return got;
  keptCensus.set(toHex(contract.censusRoot), evidence.entries);
  keptChecked.set(toHex(contract.censusRoot), got.checkedCensus);
  const seats = [];
  if (compare) {
    const mine = got.committees.settlement.map(toHex).sort().join(',');
    await Promise.all(nodes.map(async (u) => {
      try {
        const r = await readWithOneRetry(fetcher, `${baseOf(u)}/committee?role=settlement&round=${roundIdHex}`);
        if (!r.ok) { seats.push({ node: u, agrees: null, why: `answered ${r.status}` }); return; }
        const b = new Uint8Array(await r.arrayBuffer());
        const keys = []; for (let i = 0; i + 32 <= b.length; i += 32) keys.push(toHex(b.subarray(i, i + 32)));
        const agrees = keys.sort().join(',') === mine;
        seats.push({ node: u, agrees, why: agrees ? null : 'names another settlement committee than the one this client derived' });
      } catch (e) { seats.push({ node: u, agrees: null, why: e.message }); }
    }));
  }
  return { ...got, headers: { from: chain.chain.from, agreed: chain.chain.agreed, firstHeight: chain.firstHeight, count: chain.chain.headers.length },
    seats, ms: { chainAndCensus: t1 - t0, total: Date.now() - t0 } };
}

/**
 * WHAT A JOIN DEALS TO (replaces `fetchSettlementSignerNodes`): the settlement committee this client derived. Refused
 * when the client cannot derive it, or when no node that answered agrees with it.
 */
export async function clientSettlementSignerNodes(roundIdHex, contract, nodes, opts = {}) {
  const got = await clientCommittee(roundIdHex, contract, nodes, opts);
  if (!got.ok) throw new Error(`this client could not build the round's committee itself: ${got.why}`);
  const answered = got.seats.filter((s) => s.agrees !== null);
  if (answered.length && !answered.some((s) => s.agrees))
    throw new Error('every node that answered names another settlement committee than the one this client derived from the chain');
  return { signerNodes: got.committees.settlement, agreed: got.seats.filter((s) => s.agrees).length,
    refused: got.seats.filter((s) => s.agrees === false).map((s) => `${s.node}: ${s.why}`), derived: got };
}

/** The census this client checked for a round's census root (its entries, with their advertisements), or null. */
export const checkedCensusFor = (contract) => { const c = keptChecked.get(toHex(contract.censusRoot)); return c ? c.entries : null; };
