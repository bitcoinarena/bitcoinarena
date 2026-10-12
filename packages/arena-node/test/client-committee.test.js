// THE CLIENT BUILDS THE COMMITTEE ITSELF (kanban #296, spec 5A.6: "a client MUST NOT take a census, a committee or an
// endpoint on the word of any API"). Measured on the seat's own fixture chain: the census evidence a seat hands over
// (Roster.censusEvidenceFor, GET /census), checked by the client against headers alone - every bond proven, rebuilt and
// filtered, the set hashed to the round's census_root, the beacon off the same headers, the seat's sortition - gives
// exactly the game and settlement committees the seat's Roster.committeeFor draws. An entry withheld, added or altered,
// headers that stop before the beacon is deep enough, or a round naming another root: refused, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { committeeFromChain, censusFromEvidence } from '../../arena-protocol/src/client-committee.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// A CLOCK AFTER THE COMMITTEE FORMS. It was 1234 - a millisecond in 1970 -
// which is now before the round's own committee_time, and a node refuses an
// entry before that instant (27). The fixture's clock has to be a moment the
// round is actually open in.
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
// THE BEACON these rounds are seeded from, owned by the fixture the way the
// census root is: a value published ABOVE the census height, which is what
// `beaconIsAfterRound` can prove until `committee_time` exists.
// COMMITTEE_TIME IS INSIDE THIS CHAIN'S OWN CLOCK. It was 500 - 1970 - which
// is before every block a fixture ever mined, so the view could not say which
// block was FIRST after it: the true first would be Bitcoin block 1. The
// fixture chain now runs ten minutes a block from FIRST_TIME, and the round's
// committee time is a moment inside it.
const COMMITTEE_TIME = BigInt(FIRST_TIME + 15 * SPACING) * 1000n;
// THE BEACON IS THE CHAIN'S OWN. It used to be `{ hash: 0xbe repeated, height:
// 900005, timeMs: 900n }` - a block none of these fixture chains has - and the
// roster now asks whether the beacon is the block ITS chain names. One chain,
// one committee, so the fixture derives its beacon from the same blocks the
// census is derived from.
const beaconOf = (view, contract) => {
  const named = beaconFromChain(contract,
    { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight });
  if (!named.ok) throw new Error('this fixture chain names no beacon: ' + named.why);
  return { hash: named.hash, height: named.height, timeMs: named.timeMs };
};
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const contractFor = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: COMMITTEE_TIME + 60500n, entryCloseMs: COMMITTEE_TIME + 200000n,
  objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});

const advertFor = (n, roles, guardianOf = []) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [1], roles, hostedGames: [NEXTBLOCK_GAME_ID],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf, timestamp: 1788700000000n,
});
const bondOf = (n, roles = ['game'], guardianOf = []) => bondTransaction(advertFor(n, roles, guardianOf), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)),
});

/** A mined chain carrying those bonds well under the census height. */
const chainWith = (bonds, contract) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
  // AND THE ROUND'S PUBLICATION, well below any beacon (5A.5, v4.6.2): a node
  // signer nodes only a round its own chain shows published before the beacon block.
  if (contract) blocks[1] = { transactions: [publicationOf(contract)] };
  return chainOf(blocks, FROM);
};

/**
 * WHAT THE CHAIN GIVES, computed the way whoever opens a round computes it
 * before writing `censusRoot` into the contract. Every round names one, and
 * this node refuses a round whose named root is not what the blocks produce -
 * so a fixture has to be a round somebody could really have opened.
 */
function rootFor(bonds, over = {}) {
  // THROUGH THE ENCODING, because that is the contract the daemon reads: the
  // store keeps the bytes and hands back what `decodeRoundContract` makes of
  // them, protocol version and all. A root derived from the loose fixture
  // object would be a root of a contract nobody published.
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const view = chainWith(bonds);
  const byTxid = new Map();
  for (const block of view.blocks)
    for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const census = deriveCensus(view, {
    contract,
    bond: bondSetFor('regtest'),
    resolve: (e) => {
      const raw = byTxid.get(toHex(e.txid));
      return raw ? { transaction: raw } : null;
    },
  });
  assert.equal(census.ok, true, census.why);
  return census.root;
}

function daemon(bonds, over = {}) {
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const contract = contractFor({ ...over, censusRoot: rootFor(bonds, over) });
  const rid = round.open(contract);
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract) });
  return { round, rid, contract, roster };
}


const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const ROLES = [['game', 'verify', 'settlement'], ['game', 'settlement'], ['settlement'], ['game', 'verify'], ['game', 'verify', 'settlement'], ['settlement', 'game']];
const BONDS = ROLES.map((r, i) => bondOf(i + 1, r));
const OVER = { gameVerifySlots: 3, settlementSlots: 3 };
const headersOf = (view) => view.blocks.map((b) => b.header);
const keys = (list) => list.map((k) => toHex(k)).sort();

function setup() {
  const d = daemon(BONDS, OVER);
  const view = chainWith(BONDS, d.contract);
  const ev = d.roster.censusEvidenceFor(d.rid);
  assert.equal(ev.ok, true, ev.why);
  return { ...d, view, ev, contract: decodeRoundContract(new Uint8Array(d.round.get(d.rid).contract)) };
}

test('the client\'s own committee is the seat\'s: game and settlement, from headers and the census evidence alone', () => {
  const { roster, rid, view, ev, contract } = setup();
  assert.equal(ev.entries.length, 6, 'six bonds, each with its transaction and branch');
  const mine = committeeFromChain({ contract, roundId: rid, headers: headersOf(view), firstHeight: view.firstHeight, evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(mine.ok, true, mine.why);
  for (const role of ['game', 'settlement']) {
    const seat = roster.committeeFor(rid, role);
    assert.equal(seat.ok, true, seat.why);
    assert.deepEqual(keys(mine.committees[role]), keys(seat.committee.map((e) => e.pubkey)), `${role}: the client and the seat draw one committee`);
    assert.equal(mine.committees[role].length, 3);
  }
  assert.equal(toHex(mine.census.root), toHex(contract.censusRoot), 'the root the client computed is the round\'s');
});

test('a withheld, added or altered entry is another root, and the round is refused by name', () => {
  const { view, ev, contract } = setup();
  const at = { contract, headers: headersOf(view), firstHeight: view.firstHeight, bond: bondSetFor('regtest'), verify };
  const withheld = censusFromEvidence(ev.entries.slice(1), at);
  assert.equal(withheld.ok, false);
  assert.match(withheld.why, /an entry was left out, added or altered/);
  const stranger = bondOf(9, ['game']);
  // a bond in no block of the agreed headers is refused and left out: it cannot move the set, so the round still stands
  const added = censusFromEvidence([...ev.entries, { transaction: toHex(stranger), branch: [], position: 0 }], at);
  assert.equal(added.ok, true, added.why);
  assert.equal(added.entries.length, 6);
  assert.match(added.refused[0].why, /is not in any block of the agreed headers/);
  const altered = ev.entries.map((e, i) => (i === 0 ? { ...e, position: e.position + 1 } : e));
  assert.equal(censusFromEvidence(altered, at).ok, false, 'a branch that proves nothing');
  const otherRoot = censusFromEvidence(ev.entries, { ...at, contract: { ...contract, censusRoot: new Uint8Array(32).fill(7) } });
  assert.match(otherRoot.why, /this round names 0707070707070707/);
});

// SUPPORTED PROTOCOL VERSIONS (§27A.5, kanban #331): a node is counted for a round only if its bond's advertisement lists the
// round's protocol version - on the client's own check as on the seat's (census.js). The same evidence for a round that runs
// another version names nobody: every entry refused by name, so the census root is not the round's
test('an advertisement that does not list the round\'s protocol version is not counted', () => {
  const { view, ev, contract } = setup();
  const at = { contract, headers: headersOf(view), firstHeight: view.firstHeight, bond: bondSetFor('regtest'), verify };
  assert.equal(censusFromEvidence(ev.entries, at).ok, true, 'the version the adverts list: every node counted');
  const other = censusFromEvidence(ev.entries, { ...at, contract: { ...contract, protocolVersion: contract.protocolVersion + 1 } });
  assert.equal(other.ok, false);
  assert.equal(other.refused.length, ev.entries.length);
  assert.ok(other.refused.every((r) => /does not speak this round's version/.test(r.why)), other.refused[0] && other.refused[0].why);
});

test('headers that end before the beacon is deep enough name no committee', () => {
  const { rid, view, ev, contract } = setup();
  const named = beaconFromChain(contract, { headers: headersOf(view), firstHeight: view.firstHeight });
  assert.equal(named.ok, true);
  const short = headersOf(view).slice(0, named.height - view.firstHeight + contract.censusConfirmations - 1);
  const got = committeeFromChain({ contract, roundId: rid, headers: short, firstHeight: view.firstHeight, evidence: ev.entries, bond: bondSetFor('regtest'), verify });
  assert.equal(got.ok, false);
  assert.match(got.why, /no beacon: the block that seeds this round is \d+ deep and this round asks for 6/);
});

// ---- the page's own function, over what the seats serve (GET /headers, /census, /committee) ----
import { clientCommittee, clientSettlementSignerNodes, BOND_TERMS } from '../../arena-client/src/committee.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';

test('the bond terms the page carries are genesis\' own', () => {
  for (const n of ['regtest', 'testnet4']) {
    const g = genesisFor(n);
    assert.deepEqual(BOND_TERMS[n].arbitrationKeys.map(toHex), g.arbitrationKeys.map(toHex));
    assert.deepEqual([BOND_TERMS[n].arbitrationK, BOND_TERMS[n].bondMaturity], [g.arbitrationK, g.bondMaturity]);
  }
});

test('the page derives the settlement committee over the seats\' doors, deals to it, and names a seat that says otherwise', async () => {
  const { roster, rid, view, ev, contract } = setup();
  const headerBytes = Buffer.concat(headersOf(view).map((h) => Buffer.from(h)));
  const seatSet = Buffer.concat(roster.committeeFor(rid, 'settlement').committee.map((e) => Buffer.from(e.pubkey)));
  const liarSet = Buffer.concat([1, 2, 3].map((n) => Buffer.from(keyFor(n))));
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url.replace(/^https?:\/\/[^/]+/, ''));
    const liar = url.startsWith('https://liar.example');
    const body = url.endsWith('/headers') ? headerBytes : url.includes('/census?') ? Buffer.from(JSON.stringify(ev))
      : url.includes('/committee?') ? (liar ? liarSet : seatSet) : null;
    if (!body) return new Response('no', { status: 404 });
    return new Response(body, { status: 200 });
  };
  const rhex = toHex(rid);
  const nodes = ['https://seat-a.example', 'https://seat-b.example', 'https://liar.example'];
  const anchorAt = { hash: blockHashOf(headersOf(view)[0]), height: view.firstHeight };
  const got = await clientCommittee(rhex, contract, nodes, { curve: pageCurve, fetcher, anchorAt });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(keys(got.committees.settlement), keys(roster.committeeFor(rid, 'settlement').committee.map((e) => e.pubkey)));
  assert.deepEqual(got.seats.map((s) => [s.node, s.agrees]).sort(), [['https://liar.example', false], ['https://seat-a.example', true], ['https://seat-b.example', true]]);
  assert.equal(got.headers.agreed, 3, 'three sources agreed the headers');
  const dealt = await clientSettlementSignerNodes(rhex, contract, nodes, { curve: pageCurve, fetcher, anchorAt });
  assert.deepEqual(keys(dealt.signerNodes), keys(got.committees.settlement), 'the stake goes to the client\'s own committee');
  assert.match(dealt.refused[0], /^https:\/\/liar.example: names another settlement committee/);
  // and when every seat names another set, nothing is dealt
  const allLie = async (url) => (url.includes('/committee?') ? new Response(liarSet, { status: 200 }) : fetcher(url));
  await assert.rejects(clientSettlementSignerNodes(rhex, contract, nodes, { curve: pageCurve, fetcher: allLie, anchorAt, nowMs: Date.now() + 1 }),
    /every node that answered names another settlement committee/);
});
