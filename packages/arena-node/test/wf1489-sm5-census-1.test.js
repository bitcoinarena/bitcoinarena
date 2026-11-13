// kanban #1489 state-machine audit round 5 (census): the roster's census cache (memory `censuses` and the store's census_kept)
// keys a round of no series by network, protocol version, view start and census height - not by its bond_min (nor its
// census_confirmations), though the derivation reads both. Two rounds at one census height with different bond floors (a higher
// bracket's round beside the lowest one) share one cache slot: whichever round a seat asks first fixes the census of the other.
// A seat that asked the 50 000-sat round first refuses the valid 100 000-sat round ("the chain gives ..."); a seat asked the
// 100 000-sat round first serves it. Two seats, one chain, two verdicts - decided by the order the rounds reached them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort } from './lock-fixture.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { chainOf, FIRST_TIME, SPACING } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
void lockPort;

const b32 = (n) => new Uint8Array(32).fill(n);
const AFTER_COMMITTEE = Number(BigInt(FIRST_TIME + 20 * SPACING) * 1000n);
const HEIGHT = 900000;
const COMMITTEE_TIME = BigInt(FIRST_TIME + 15 * SPACING) * 1000n;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const contractFor = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: COMMITTEE_TIME + 60500n, entryCloseMs: COMMITTEE_TIME + 200000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});
const advertFor = (n) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [1], roles: ['game'], hostedGames: [NEXTBLOCK_GAME_ID],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
});
const bondOf = (n, value) => bondTransaction(advertFor(n), { previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)), value });

// node 1 bonds 60 000 sat (over the 50 000 floor, under 100 000), node 2 bonds 200 000 sat
const BONDS = [bondOf(1, 60000), bondOf(2, 200000)];
// ONE CHAIN: every round a seat holds is read from the same blocks (production: this seat's bitcoind)
const VIEW = (() => { const blocks = []; for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? BONDS : [] }); return chainOf(blocks, FROM); })();

const censusOf = (over) => {
  const contract = decodeRoundContract(encodeRoundContract(contractFor(over)));
  const byTxid = new Map();
  for (const block of VIEW.blocks) for (const raw of block.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
  const c = deriveCensus(VIEW, { contract, bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
  assert.equal(c.ok, true, c.why);
  return c;
};

const seat = () => {
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const roster = new Roster(round, { chainFor: () => VIEW });
  return { round, roster };
};

test('two rounds at one census height with different bond_min: each seat derives the census of the round it asks, whatever it asked before', () => {
  const low = { bondMinSats: 50000n, startTimeMs: COMMITTEE_TIME + 60500n };
  const high = { bondMinSats: 100000n, startTimeMs: COMMITTEE_TIME + 61500n };
  const lowCensus = censusOf(low), highCensus = censusOf(high);
  assert.equal(lowCensus.entries.length, 2, 'the 50 000-sat floor takes both bonds');
  assert.equal(highCensus.entries.length, 1, 'the 100 000-sat floor takes node 2 only');
  assert.notEqual(toHex(lowCensus.root), toHex(highCensus.root));

  // seat A: the lowest bracket's round first (an ordinary listing), then the higher bracket's
  const a = seat();
  const ridLowA = a.round.open(contractFor({ ...low, censusRoot: lowCensus.root }));
  const ridHighA = a.round.open(contractFor({ ...high, censusRoot: highCensus.root }));
  const lowAtA = a.roster.censusFor(ridLowA);
  assert.equal(lowAtA.ok, true, lowAtA.why);
  const highAtA = a.roster.censusFor(ridHighA);

  // seat B: the same two rounds, the higher bracket's asked first
  const b = seat();
  const ridHighB = b.round.open(contractFor({ ...high, censusRoot: highCensus.root }));
  const highAtB = b.roster.censusFor(ridHighB);

  console.log('  seat B (high first):', highAtB.ok ? `ok, ${highAtB.entries.length} entries` : highAtB.why);
  console.log('  seat A (low first, then high):', highAtA.ok ? `ok, ${highAtA.entries.length} entries` : highAtA.why);
  assert.equal(highAtB.ok, true, highAtB.why);
  assert.equal(highAtA.ok, true, `seat A refuses the valid 100 000-sat round because it asked the 50 000-sat round first: ${highAtA.why}`);
  assert.equal(highAtA.entries.length, 1);
});

test('a round naming bond_min 100 000 is never served with the 50 000-sat census (bonds under its floor in its committee)', () => {
  const low = { bondMinSats: 50000n, startTimeMs: COMMITTEE_TIME + 60500n };
  const lowCensus = censusOf(low);
  const a = seat();
  const ridLow = a.round.open(contractFor({ ...low, censusRoot: lowCensus.root }));
  assert.equal(a.roster.censusFor(ridLow).ok, true);
  // a round of the 100 000-sat bracket naming the root of the 50 000-sat census
  const ridBad = a.round.open(contractFor({ bondMinSats: 100000n, startTimeMs: COMMITTEE_TIME + 62500n, censusRoot: lowCensus.root }));
  const got = a.roster.censusFor(ridBad);
  const fresh = seat();
  const ridBadFresh = fresh.round.open(contractFor({ bondMinSats: 100000n, startTimeMs: COMMITTEE_TIME + 62500n, censusRoot: lowCensus.root }));
  const atFresh = fresh.roster.censusFor(ridBadFresh);
  console.log('  fresh seat:', atFresh.ok ? 'served' : atFresh.why);
  console.log('  seat that asked the low round first:', got.ok ? `served with ${got.entries.length} entries (node 1 bonds 60 000 sat)` : got.why);
  assert.equal(atFresh.ok, false, 'a fresh seat refuses it: the chain gives another root at that floor');
  assert.equal(got.ok, false, 'served with a census holding a bond under its bond_min');
});
