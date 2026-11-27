// kanban #1489 audit r40 census-2 (P4, one seat of many stalls every join): clientCommittee compares each seat's unsigned GET /committee
// answer; when ANY seat differs (agrees === false) it reads every role's seating again with every=true - Promise.all over every seat, each
// read allowed SEATING_ASK_MS (6 s), the roles one after the other. One listed seat that answers /committee with a made-up list (named, not
// refusing, #2643) and lets its GET /seating run to the timeout makes every player's join wait ~12 s more, on every round: an RPS tap or a
// Next Block entry near its close is too late. The kept-seating cache (#1449) is skipped by every=true, so it repeats on each join.
// SAFE: one seat's differing unsigned answer plus a slow /seating does not hold a join for several seconds beyond the honest seats' answers.
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


import { clientCommittee, clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { encodeSeatingCertificate, signSeating } from '../../arena-protocol/src/seating.js';


test('wf1489 r40 census-2: one seat with a made-up /committee answer and a slow /seating does not stall the join', async () => {
  // (2.0: no kept seating answers to forget, #1449 is not on 2.0)
  const { roster, rid, view, ev, contract } = setup();
  const headerBytes = Buffer.concat(headersOf(view).map((h) => Buffer.from(h)));
  const secretOf = new Map([1, 2, 3, 4, 5, 6].map((n) => [toHex(keyFor(n)), new Uint8Array(32).fill(n)]));
  const certFor = (role, seated) => {
    const s = { roundId: rid, role, seated };
    const signatures = seated.map((k) => ({ nodePubkey: k, signature: signSeating(s, (m) => schnorr.sign(m, secretOf.get(toHex(k)))) }));
    return toHex(encodeSeatingCertificate({ ...s, signatures }));
  };
  const drawn = (role) => roster.committeeFor(rid, role).drawn.map((e) => e.pubkey);
  const CERT = { game: certFor('game', drawn('game')), settlement: certFor('settlement', drawn('settlement')) };
  const keysOf = (role) => Buffer.concat(drawn(role).map((k) => Buffer.from(k)));
  const hang = (signal) => new Promise((_, reject) => { if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const fetcher = async (url, opts = {}) => {
    const bad = url.startsWith('https://bad.example');
    const role = /role=game/.test(url) ? 'game' : 'settlement';
    if (url.endsWith('/headers')) return new Response(headerBytes, { status: 200 });
    if (url.includes('/census?')) return new Response(JSON.stringify(ev), { status: 200 });
    if (url.includes('/seating?')) { if (bad) return hang(opts.signal); return new Response(JSON.stringify({ cert: CERT[role], index: 0 }), { status: 200 }); }
    // the bad seat names a committee of one made-up key: unsigned, so it is named and does not refuse (#2643)
    if (url.includes('/committee?')) return new Response(bad ? Buffer.from(new Uint8Array(32).fill(0x66)) : keysOf(role), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const nodes = ['https://seat-a.example', 'https://seat-b.example', 'https://seat-c.example', 'https://seat-d.example', 'https://bad.example'];
  const anchorAt = { hash: blockHashOf(headersOf(view)[0]), height: view.firstHeight };
  // honest baseline: the same seats with the bad one left out
  // (2.0: no kept seating answers to forget, #1449 is not on 2.0)
  let t = Date.now();
  await clientSettlementSignerNodes(toHex(rid), contract, nodes.slice(0, 4), { curve: pageCurve, fetcher, anchorAt });
  const honestMs = Date.now() - t;
  // (2.0: no kept seating answers to forget, #1449 is not on 2.0)
  t = Date.now();
  let refused = null, got = null;
  try { got = await clientSettlementSignerNodes(toHex(rid), contract, nodes, { curve: pageCurve, fetcher, anchorAt }); } catch (e) { refused = e.message; }
  const attackedMs = Date.now() - t;
  console.log('  MEASURED r40 census-2:', JSON.stringify({ honestMs, attackedMs, refused, signerNodes: got && got.signerNodes && got.signerNodes.length }));
  assert.equal(refused, null, `refused: ${refused}`);
  assert.ok(attackedMs < honestMs + 3000, `one seat held the join ${attackedMs} ms (honest seats alone: ${honestMs} ms)`);
});
