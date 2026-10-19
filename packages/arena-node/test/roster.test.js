// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DAEMON ASKS BITCOIN WHO MAY HOLD THE ROUND.
//
// Everything letter 15 built was library code with no caller: measured at the
// start of this slice, not one file under any `src/` called `scanCensus`,
// `resolveCensus`, `deriveCensus` or `commitCensus`. A node could serve rounds
// without ever asking the chain who was bonded, and the "not deployable" line
// that closed 15 was exactly this.
//
// `src/roster.js` is that caller, and the guard below keeps it the only one.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort } from './lock-fixture.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { serve } from '../src/server.js';
import { chainOf, FIRST_TIME, SPACING, publicationOf } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { beaconFromChain } from '../../arena-protocol/src/beacon.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
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

test('one file under src/ reaches the census, and it is roster.js', () => {
  const reaches = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url).pathname)) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url).pathname, 'utf8');
    // CALLS, not mentions: a comment naming `resolveCensus` is a comment, and
    // the rule here is about which file ASKS the census anything.
    if (/\b(deriveCensus|resolveCensus|scanCensus|commitCensus|selectCommittee)\s*\(/.test(src))
      reaches.push(f);
  }
  assert.deepEqual(reaches, ['roster.js'],
    'eligibility is decided somewhere other than the one caller, or nowhere at all');

  // AND IT DOES NOT RE-DECIDE ANY OF IT. Every rule the census applies -
  // the floor, the roles, the version, the depth - stays where it lives; a
  // copy here would be the second implementation that 5A.2 exists to prevent.
  const src = readFileSync(new URL('../src/roster.js', import.meta.url).pathname, 'utf8');
  assert.ok(!/bondMinSats\s*[<>]|roles\.includes|censusMinNodes|censusConfirmations\s*[<>]/.test(src),
    'the caller re-checks eligibility beside the census');
});

test('the daemon derives the census from the chain and signer nodes a committee from it', () => {
  const { rid, roster } = daemon([bondOf(0x11), bondOf(0x12)]);

  const census = roster.censusFor(rid);
  assert.equal(census.ok, true, census.why);
  assert.equal(census.entries.length, 2, `excluded: ${census.excluded.map((e) => e.why).join(' | ')}`);
  assert.equal(census.unchecked.some((u) => /script template/.test(u)), false,
    'the daemon published a root with the bond template unchecked');

  const signerNodes = roster.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, true, signerNodes.why);
  assert.equal(signerNodes.committee.length, 2);
  assert.deepEqual(toHex(signerNodes.root), toHex(census.root));
  assert.deepEqual(
    signerNodes.committee.map((e) => toHex(e.pubkey)).sort(),
    [keyFor(0x11), keyFor(0x12)].map(toHex).sort(),
    'the committee is not the bonded nodes the chain carries');
});

test('one bonded node against a two-slot contract assigns nobody, by name', () => {
  const { rid, roster } = daemon([bondOf(0x11)]);

  const census = roster.censusFor(rid);
  assert.equal(census.ok, true, census.why);
  assert.equal(census.entries.length, 1, 'the chain carries one bond and the census disagrees');

  const signerNodes = roster.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, false, 'the daemon assigned a committee of one');
  assert.match(signerNodes.why, /that census carries 1 game node where regtest was born needing 2/);
  assert.equal(signerNodes.committee, undefined);
});

test('two bonded nodes, one game and one settlement, hold neither role', () => {
  const { rid, roster } = daemon([bondOf(0x11, ['game']), bondOf(0x12, ['settlement'])]);

  assert.equal(roster.censusFor(rid).entries.length, 2, 'both bonds are in the census');
  for (const role of ['game', 'settlement']) {
    const signerNodes = roster.committeeFor(rid, role);
    assert.equal(signerNodes.ok, false, `${role} was assigned from a census of one`);
    assert.match(signerNodes.why, new RegExp(`carries 1 ${role} node where regtest was born needing 2`));
  }
});

test('the caller cannot name a minimum of its own', () => {
  const { round, rid } = daemon([bondOf(0x11)]);
  const chainFor = ({ contract } = {}) => chainWith([bondOf(0x11)], contract);

  // Every shape a caller might try it in: on the roster, on the call, and on
  // the contract the round was opened with.
  for (const tried of [{ minimum: 1 }, { censusMinNodes: 1 }, { min: 1 }]) {
    const roster = new Roster(round, { chainFor,
      randomnessFor: ({ contract }) => beaconOf(chainFor({ contract }), contract), ...tried });
    const signerNodes = roster.committeeFor(rid, 'game', tried);
    assert.equal(signerNodes.ok, false, `a caller lowered the minimum with ${Object.keys(tried)[0]}`);
    assert.match(signerNodes.why, /born needing 2/);
  }
});

test('a node with no chain view holds no round, and says which it is missing', () => {
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const rid = round.open(contractFor({ censusRoot: rootFor([bondOf(0x11), bondOf(0x12)]) }));
  const blind = new Roster(round);        // the default: no source of blocks

  const census = blind.censusFor(rid);
  assert.equal(census.ok, false, 'a census was derived from nothing');
  assert.match(census.why, /no chain view for that round/);
  assert.match(blind.committeeFor(rid, 'game').why, /no chain view for that round/);

  // and a round this node does not hold is not a census either
  assert.match(blind.censusFor(b32(0x99)).why, /holds no such round/);
});

// A BONDED FEDERATION (RULED 2026-09-25: a paying round on an unbonded one is refused before round.open, nothing stored):
// each bond advertises one of the fixture federation's guardian keys, and the lock fixture's port answers guardians() with
// them - the same shape as guardians-bonded's fixture - so the paying round opens, is stored, and the committee door reads it.
const guardianKey = (n) => Uint8Array.from([0x02, ...b32(0x60 + n)]);
const guardingPort = (keys, threshold) => Object.assign(lockPort(), {
  async guardians() { return { federationId: TEST_FEDERATION_ID, guardians: keys.length, threshold, keys }; },
});
const guarding = (g) => [{ federationId: TEST_FEDERATION_ID, guardianKey: g }];

test('the committee door answers off the chain, and refuses a short census by name', async () => {
  const bonds = [bondOf(0x11, ['game'], guarding(guardianKey(1))), bondOf(0x12, ['game'], guarding(guardianKey(2)))];
  const node = await serve(openStore(), { plugins: HOSTED, 
    port: 0, funded: () => true, stakeLocks: guardingPort([guardianKey(1), guardianKey(2)], 2), chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract),
  });
  try {
    const c = contractFor({ censusRoot: rootFor(bonds) });
    await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    // STORED BEFORE THE DOOR IS READ: its federation is bonded, so the bond check before round.open lets it in. (The
    // answer to the POST is not what this measures: its signer nodes are refused at assignment afterwards - the fixture
    // contract names one key and the census assigns two - and the round is kept, as it always was.)
    assert.ok(node.round.get(roundId(c)), 'the round on a bonded federation was not stored');
    const rid = toHex(roundId(c));

    const got = await fetch(`http://127.0.0.1:${node.port}/committee?round=${rid}&role=game`);
    const signerNodes = new Uint8Array(await got.arrayBuffer());
    assert.equal(got.status, 200, `the door refused: ${new TextDecoder().decode(signerNodes)}`);
    assert.equal(got.headers.get('x-eligible'), '2');
    assert.equal(got.headers.get('x-signer-nodes'), '2');
    assert.equal(signerNodes.length, 64, 'the door did not answer with two keys');
    assert.deepEqual(
      [toHex(signerNodes.slice(0, 32)), toHex(signerNodes.slice(32))].sort(),
      [keyFor(0x11), keyFor(0x12)].map(toHex).sort());
  } finally { await node.close(); }

  // THE SHORT CENSUS: one bond, on a one-guardian federation it bonds - so the round opens and is stored, and the refusal
  // measured is the committee door's own.
  const thinBonds = [bondOf(0x11, ['game'], guarding(guardianKey(1)))];
  const thin = await serve(openStore(), { plugins: HOSTED, 
    port: 0, funded: () => true, stakeLocks: guardingPort([guardianKey(1)], 1), chainFor: ({ contract } = {}) => chainWith(thinBonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(thinBonds, contract), contract),
  });
  try {
    const c = contractFor({ censusRoot: rootFor(thinBonds) });
    await fetch(`http://127.0.0.1:${thin.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    // THE ROUND IS STORED - its federation is bonded - and its short census is refused at assignment and at the door.
    assert.ok(thin.round.get(roundId(c)), 'the round on a bonded federation was not stored');
    const got = await fetch(`http://127.0.0.1:${thin.port}/committee?round=${toHex(roundId(c))}&role=game`);
    assert.equal(got.status, 409, 'a short census was served as a committee');
    assert.match(await got.text(), /carries 1 game node where regtest was born needing 2/);
  } finally { await thin.close(); }
});

test('the minimum the daemon applies is the one genesis carries', () => {
  // Not a number in this file: if genesis said three, two bonded nodes would
  // not hold a round, and this reads it rather than restating it.
  const need = genesisFor('regtest').censusMinNodes;
  const { rid, roster } = daemon(Array.from({ length: need }, (_, i) => bondOf(0x20 + i)));
  assert.equal(roster.committeeFor(rid, 'game').ok, true);

  const short = daemon(Array.from({ length: need - 1 }, (_, i) => bondOf(0x30 + i)));
  assert.equal(short.roster.committeeFor(rid, 'game').ok, false);
});

test('a bond the census excluded is never assigned, however many slots there are', () => {
  // Found by a mutant that survived: joining `entries` plus `excluded` broke
  // nothing, because every fixture here was a bond that PASSED. A daemon that
  // assigned an excluded node would put a key the chain refuses on the
  // committee - unbonded, spent, or paying to somebody else's output key -
  // which is the whole of what the census is for.
  //
  // The stranger's bond is marked, committed and funded; what it is not is the
  // taproot tweak of its own advertisement, because this fixture leaves the
  // builder's filler key in place.
  const stranger = bondTransaction(advertFor(0x13, ['game']), {
    previousTxid: b32(0xb3), previousVout: 0,
  });
  const { rid, roster } = daemon([bondOf(0x11), bondOf(0x12), stranger],
    { gameVerifySlots: 3 });

  const census = roster.censusFor(rid);
  assert.equal(census.entries.length, 2, 'the stranger was counted as bonded');
  const refused = census.excluded.find((e) => toHex(e.pubkey) === toHex(keyFor(0x13)));
  assert.ok(refused, 'the stranger was dropped silently instead of named');
  assert.match(refused.why, /not the taproot tweak of the keys and maturity it declares/);

  // THREE SLOTS, TWO ELIGIBLE: the honest answer is two signer nodes, and the only
  // way to fill the third is to assign somebody the census refused.
  const signerNodes = roster.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, true, signerNodes.why);
  assert.equal(signerNodes.committee.length, 2, 'a third signer node was filled from somewhere');
  assert.equal(signerNodes.committee.some((e) => toHex(e.pubkey) === toHex(keyFor(0x13))), false,
    'a bond the chain refused was assigned to the committee');
});

test('a round whose census root is not the chain\'s is refused, not served', () => {
  // 5A.4 on a contract whose census root is not what its census derives to:
  // it "IS INVALID and no honest node will issue receipts against it". Every
  // contract names a root, and on this path nothing compared it with the
  // blocks - so a round could name any thirty-two bytes, and this node would
  // derive a different census, signer node a committee from it and serve that. Which
  // is the divergence 5A.2 removes, arriving from the round's own header.
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const honest = rootFor(bonds);

  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const rid = round.open(contractFor({ censusRoot: b32(0x5a) }));
  const roster = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract) });

  const census = roster.censusFor(rid);
  assert.equal(census.ok, false, 'a round naming somebody else\'s census root was served');
  assert.match(census.why, /names census root 5a5a5a5a5a5a5a5a and the chain gives/);
  assert.match(census.why, new RegExp(`gives ${toHex(honest).slice(0, 16)} at height ${HEIGHT}`),
    'the refusal does not say what the chain actually gives');

  // and no committee comes out of a census that was refused
  const signerNodes = roster.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, false);
  assert.equal(signerNodes.committee, undefined);

  // THE SAME BLOCKS, THE ROOT THEY REALLY PRODUCE: held.
  const good = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const goodId = good.open(contractFor({ censusRoot: honest }));
  const right = new Roster(good, { chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract) });
  assert.equal(right.committeeFor(goodId, 'game').ok, true);

  // AND A ROUND THAT NAMES NO ROOT AT ALL IS NOT A ROUND EITHER. A contract
  // always carries thirty-two bytes there, so this is the shape a caller
  // building one by hand would hit.
  const bare = new Roster(good, { chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract) });
  bare.round = { get: () => ({ contract: encodeRoundContract(contractFor({ censusRoot: b32(0) })) }) };
  assert.match(bare.censusFor(goodId).why, /names census root 0000000000000000 and the chain gives/);
});

test('the daemon signer nodes on the beacon\'s seed, and on nothing else', async () => {
  // Found by mutants that survived: every fixture above has exactly as many
  // eligible nodes as slots, so ANY seed signer nodes the same two and none of them
  // could tell which seed was used. Six bonded nodes and two slots is a census
  // where the seed decides.
  const { committeeSeedFrom } = await import('../../arena-protocol/src/beacon.js');
  const { roundId } = await import('../../arena-protocol/src/contracts.js');
  const { selectCommittee } = await import('../../arena-protocol/src/sortition.js');

  const many = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26].map((n) => bondOf(n));

  // WHAT AN AUTHOR WOULD WRITE, picked so the two seeds CAN be told apart. The contract carries the
  // core's hash, so the round id and the beacon's seed move with every core change: at 0x5e alone the
  // tank-ring core (2026-09-16) happened onto the one census where both seeds sit the same pair (a
  // chance of about one in fifteen at six nodes and two slots). The first author seed from 0x5e on that
  // separates them is taken, and the precondition below still has to hold.
  const tryWith = (byte) => {
    const chosen = b32(byte);
    const { round, rid, roster } = daemon(many, { committeeSeed: chosen });
    const contract = decodeRoundContract(new Uint8Array(round.get(rid).contract));
    const fromBeacon = committeeSeedFrom({
      censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
      roundId: rid, roundRandomness: beaconOf(chainWith(many, contract), contract).hash,
    });
    const signerNodesBy = (seed) => selectCommittee({
      entries: roster.censusFor(rid).entries, contract, role: 'game', committeeSeed: seed,
    }).map((e) => toHex(e.pubkey)).sort();
    return { chosen, rid, roster, fromBeacon, signerNodesBy };
  };
  let pick = tryWith(0x5e);
  for (let byte = 0x5f; byte < 0x7e && pick.signerNodesBy(pick.fromBeacon).join() === pick.signerNodesBy(pick.chosen).join(); byte++)
    pick = tryWith(byte);
  const { chosen, rid, roster, fromBeacon, signerNodesBy } = pick;

  const signerNodes = roster.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, true, signerNodes.why);
  assert.equal(signerNodes.committee.length, 2);

  // WHO SITS IS WHO THE BEACON'S SEED SIGNER NODES.
  assert.deepEqual(signerNodes.committee.map((e) => toHex(e.pubkey)).sort(), signerNodesBy(fromBeacon));

  // AND NOT WHO THE CONTRACT'S BYTES WOULD HAVE JOINED - which is a different
  // pair here, or this test would not be able to tell them apart.
  assert.notDeepEqual(signerNodesBy(fromBeacon), signerNodesBy(chosen),
    'the two seeds signer node the same pair, so this census cannot measure the difference');
  assert.notDeepEqual(signerNodes.committee.map((e) => toHex(e.pubkey)).sort(), signerNodesBy(chosen),
    'the daemon joined the pair the contract\'s own bytes choose');
});

test('a node with no beacon, or one the creator already had, assigns nobody', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const { round, rid } = daemon(bonds);

  // NO BEACON: refused by name, and never a fallback to the contract's bytes.
  const blind = new Roster(round, { chainFor: ({ contract } = {}) => chainWith(bonds, contract) });
  const signerNodes = blind.committeeFor(rid, 'game');
  assert.equal(signerNodes.ok, false, 'a node with no beacon assigned a committee anyway');
  assert.match(signerNodes.why, /no beacon for that round/);

  // A BEACON THE CREATOR COULD HAVE HELD: at or before the round's own
  // committee time, which is where 5A.5 draws the line now that the field
  // exists - "committee_time: beacon value appears".
  for (const timeMs of [COMMITTEE_TIME, COMMITTEE_TIME - 1n, 0n]) {
    const early = new Roster(round, {
      chainFor: ({ contract } = {}) => chainWith(bonds, contract),
      // The chain's own block, with only its TIME moved back - so what is
      // being measured is 27's rule and not a wrong block.
      randomnessFor: ({ contract }) => ({ ...beaconOf(chainWith(bonds, contract), contract), timeMs }),
    });
    const out = early.committeeFor(rid, 'game');
    assert.equal(out.ok, false, `a beacon at ${timeMs} seeded a round it predates`);
    assert.match(out.why, /at or before this round's committee time/);
  }
});

/**
 * A LATE BEACON IS NOT THE SAME AS THE RIGHT ONE, AT ASSIGNMENT TIME.
 *
 * `committeeSeedFromBeacon` can only ask whether a beacon came after
 * committee_time - it is handed a height and a time and no chain - so a node
 * whose operator hands it any LATER block would assign on a block that operator
 * chose. That is 5A.5's grinding attack with one extra step, and this is the
 * door where it is now shut: the roster has a chain view, so it asks whether
 * the beacon is the block that chain names.
 */
test('the roster refuses a beacon that is late but not the block its chain names', async () => {
  const { beaconFromChain, medianTimePast } = await import('../../arena-protocol/src/beacon.js');
  const { blockHashOf } = await import('../../arena-protocol/src/chain.js');

  const bonds = [bondOf(0x11), bondOf(0x12)];
  // The chain the daemon's round is published on - `daemon` opens exactly this
  // contract - so the later block below is a real block of the chain it reads.
  const view = chainWith(bonds, contractFor({ censusRoot: rootFor(bonds, {}) }));
  const headers = { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight };

  // THE HONEST PATH FIRST, and it says the check RAN. A green signer node that
  // skipped the check would look exactly like a green signer node that made it.
  const { rid, contract, roster } = daemon(bonds);
  const named = beaconFromChain(contract, headers);
  assert.equal(named.ok, true, named.why);
  const seeded = roster.seedFor(rid, contract);
  assert.equal(seeded.ok, true, seeded.why);
  assert.equal(seeded.checkedAgainstChain, true,
    'the roster assigned without asking its own chain which block that was');
  assert.equal(roster.committeeFor(rid, 'game').ok, true);

  // A REAL, LATER BLOCK OF THE SAME CHAIN. Not junk: it is mined, it links, and
  // it is after committee_time - everything 27 can check, and still not the
  // block the rule names.
  const later = named.height + 1;
  const wrong = {
    hash: blockHashOf(headers.headers[later - headers.firstHeight]),
    height: later,
    timeMs: BigInt(medianTimePast(headers.headers, headers.firstHeight, later)) * 1000n,
  };
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const wrongId = round.open(contractFor({ censusRoot: rootFor(bonds, {}) }));
  const crooked = new Roster(round, {
    chainFor: ({ contract } = {}) => chainWith(bonds, contract), randomnessFor: () => wrong,
  });
  const refused = crooked.seedFor(wrongId, contract);
  assert.equal(refused.ok, false, 'a later block assigned a committee');
  assert.match(refused.why, new RegExp(`is block ${later} where this chain names ${named.height}`));
  assert.match(refused.why, /a later block is a block somebody chose/);

  // and it is refused at the door a committee actually comes out of
  assert.equal(crooked.committeeFor(wrongId, 'game').ok, false);
  console.log(`  the chain names ${named.height}; block ${later} offered -> refused`);
});

test('a node with no chain view still refuses on 27 alone, and says the check did not run', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const view = chainWith(bonds);
  const contract = contractFor({ censusRoot: rootFor(bonds, {}) });
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const rid = round.open(contract);

  // No chain: the beacon cannot be checked against one, and the answer says so
  // rather than implying it was.
  const blind = new Roster(round, {
    randomnessFor: ({ contract: c }) => beaconOf(view, c),
  });
  const seeded = blind.seedFor(rid, contract);
  assert.equal(seeded.ok, true, seeded.why);
  assert.equal(seeded.checkedAgainstChain, false,
    'a node with no chain claimed it had checked the beacon against one');

  // and 27's own rule still bites without any chain at all
  const early = new Roster(round, {
    randomnessFor: ({ contract: c }) => ({ ...beaconOf(view, c), timeMs: 0n }),
  });
  assert.match(early.seedFor(rid, contract).why, /at or before this round's committee time/);
});

/**
 * AND THE CLOSING DOOR ASKS THE SAME QUESTION.
 *
 * The signer node is not the only place a beacon decides something: `replay` derives
 * every player's WORLD from it, so a node closing on a late-but-wrong block
 * computes a different world, a different state hash, and a result no honest
 * node will agree with. Before this the verifier asked only 27's rule - "was
 * it after committee_time" - and that is not "is it the block the chain
 * names".
 */
test('a node closing a round refuses a beacon its own chain does not name', async () => {
  const { Verifier } = await import('../src/verify.js');
  const { beaconFromChain, medianTimePast } = await import('../../arena-protocol/src/beacon.js');
  const { blockHashOf } = await import('../../arena-protocol/src/chain.js');
  const { encodeEntryContract, entryId: entryIdOf } = await import('../../arena-protocol/src/contracts.js');

  const bonds = [bondOf(0x11), bondOf(0x12)];
  const view = chainWith(bonds);
  const headers = { headers: view.blocks.map((b) => b.header), firstHeight: view.firstHeight };
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const contract = contractFor({ censusRoot: rootFor(bonds, {}) });
  const rid = round.open(contract);

  // one entry, so there is something to close over
  const entry = {
    roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
    worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  };
  round.enter(entry);
  assert.equal(round.entriesOf(rid).length, 1);

  const named = beaconFromChain(contract, headers);
  const later = named.height + 1;
  const wrong = {
    hash: blockHashOf(headers.headers[later - headers.firstHeight]),
    height: later,
    timeMs: BigInt(medianTimePast(headers.headers, headers.firstHeight, later)) * 1000n,
  };

  // WITH A CHAIN: refused, and the reason names both blocks.
  const seeing = new Verifier(round, { plugins: HOSTED, randomnessFor: () => wrong, chainFor: () => view });
  seeing.onRoundClosed(rid);
  assert.equal(seeing.queued.length, 1);
  assert.match(seeing.queued[0].refused,
    new RegExp(`is block ${later} where this chain names ${named.height}`));

  // THE HONEST BEACON GOES THROUGH the same door.
  const good = new Verifier(round, { plugins: HOSTED, 
    randomnessFor: ({ contract: c }) => beaconOf(view, c), chainFor: () => view,
  });
  good.onRoundClosed(rid);
  assert.equal(good.queued.length, 1);
  assert.equal(good.queued[0].refused, undefined, good.queued[0].refused);
  console.log(`  closing: chain names ${named.height}; block ${later} offered -> refused`);
});

/**
 * A ROUND EXISTS ONLY ONCE ITS HASH IS ON BITCOIN, BELOW ITS BEACON BLOCK
 * (5A.5, v4.6.2, P1). Before this a round was assigned with no publication at
 * all, so a creator could publish many candidates for free, wait for the
 * beacon, and promote the one whose committee was his.
 */
test('a round its chain never published, or published in its beacon block, is not joined', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const contract = contractFor({ censusRoot: rootFor(bonds, {}) });
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const rid = round.open(contract);

  const unpublished = new Roster(round, { chainFor: () => chainWith(bonds),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds), c) });
  assert.match(unpublished.seedFor(rid, contract).why, /no publication transaction/);

  const beaconHeight = beaconOf(chainWith(bonds), contract).height;
  const inBeacon = () => {
    const blocks = [];
    for (let h = FROM; h <= TIP; h++)
      blocks.push({ transactions: h === FROM ? bonds : h === beaconHeight ? [publicationOf(contract)] : [] });
    return chainOf(blocks, FROM);
  };
  const atBeacon = new Roster(round, { chainFor: inBeacon,
    randomnessFor: ({ contract: c }) => beaconOf(inBeacon(), c) });
  assert.match(atBeacon.seedFor(rid, contract).why, new RegExp(`at or after its beacon block ${beaconHeight}`));

  const published = new Roster(round, { chainFor: ({ contract: c } = {}) => chainWith(bonds, c),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c) });
  const seeded = published.seedFor(rid, contract);
  assert.equal(seeded.ok, true, seeded.why);
  assert.equal(seeded.checkedAgainstChain, true);
});

/**
 * A CENSUS IS DERIVED ONCE PER ROUND AND VIEW, NOT ON EVERY ASK (2026-09-17 19:15, the ghost lag).
 *
 * Deriving one parses every transaction of every block of the round's view, and the payout's `gather` asks for it on
 * the finality cadence: measured live, that held the signer node's event loop - the one that pushes another player's
 * truck - 142-209 ms every time, for an answer that cannot change. A census is fixed at the round's own census
 * height, so it is kept per round and per view start. What must not change is the answer.
 */
test('the census is derived once for a round and a view, and again when the view begins somewhere else', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const contract = contractFor({ censusRoot: rootFor(bonds) });
  const rid = round.open(contract);
  let derived = 0;
  const roster = new Roster(round, {
    chainFor: ({ contract: c } = {}) => { derived++; return chainWith(bonds, c); },
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c),
  });

  const first = roster.censusFor(rid);
  assert.equal(first.ok, true, first.why);
  const again = roster.censusFor(rid);
  assert.equal(again, first, 'the same round and view derived its census twice');
  assert.equal(derived, 2, 'the view is still read each time - only the derivation is kept');
  assert.deepEqual(toHex(again.root), toHex(contract.censusRoot), 'the kept census is not the round\'s own');

  // A VIEW THAT BEGINS SOMEWHERE ELSE IS ANOTHER VIEW, and is derived again.
  const moved = new Roster(round, {
    chainFor: ({ contract: c } = {}) => { const v = chainWith(bonds, c); return { ...v, firstHeight: v.firstHeight + 1 }; },
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c),
  });
  const elsewhere = moved.censusFor(rid);
  assert.notEqual(elsewhere, first, 'a view beginning elsewhere answered with the kept census');

  // AND A REFUSAL IS NEVER KEPT: a round whose root the chain does not give is asked again, not remembered.
  const wrong = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const rid2 = wrong.open(contractFor({ censusRoot: new Uint8Array(32).fill(0x99) }));
  const bad = new Roster(wrong, { chainFor: ({ contract: c } = {}) => chainWith(bonds, c),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c) });
  assert.equal(bad.censusFor(rid2).ok, false);
  assert.equal(bad.censuses.size, 0, 'a refusal was kept');
});

/**
 * THE COMMITTEE AND ITS SEED ARE KEPT PER ROUND AND PER VIEW, AND A NEW HEADER REBUILDS THEM.
 *
 * A V8 profile of a live signer node named `peersOf -> committeeFor -> seedFor -> beaconFromChain -> chainWork ->
 * meetsTarget -> hash256` as 39.8 s of a 417 s window: every ask re-hashed the round's whole view and re-checked its
 * proof of work, and `carryReceipts` asks twice per peer, per entry, at every close and retry. The work is not
 * skipped - it runs again for a view that grew, which is what this measures.
 */
test('the committee and the seed are kept per view, and a new header builds them again', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const contract = contractFor({ censusRoot: rootFor(bonds) });
  const rid = round.open(contract);
  let grown = 0;
  const roster = new Roster(round, {
    // The same view until it is asked to grow: a block arrives and every reader sees a longer one.
    // The same chain, handed over as a fresh object each time once `grown` is set: what a view rebuilt block by block
    // looks like to a reader.
    chainFor: ({ contract: c } = {}) => {
      const v = chainWith(bonds, c);
      return grown === 2 ? { ...v, blocks: [...v.blocks] } : grown === 1 ? { ...v, blocks: [...v.blocks, ...v.blocks.slice(-1)] } : v;
    },
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c),
  });

  const first = roster.seedFor(rid, contract);
  assert.equal(first.ok, true, first.why);
  assert.equal(roster.seedFor(rid, contract), first, 'the same round and view checked the chain twice');
  const committee = roster.committeeFor(rid, 'game');
  assert.equal(committee.ok, true, committee.why);
  assert.equal(roster.committeeFor(rid, 'game'), committee, 'the same round, role and view assigned twice');
  assert.notEqual(roster.committeeFor(rid, 'settlement'), committee, 'another role answered with the game committee');

  // ANOTHER VIEW OF THE SAME CHAIN IS THE SAME ANSWER (2026-09-18 01:30): the committee is made of the census
  // root and the seed, so a view rebuilt block by block does not assign it again - that rebuild was 132-165 ms inside a
  // pictured truck's stall. The seed's own chain check is not kept across it: `seeds` is keyed by the view.
  grown = 2;
  assert.equal(roster.committeeFor(rid, 'game'), committee, 'a fresh view of the same chain assigned the committee again');

  // AND A DIFFERENT CENSUS IS A DIFFERENT COMMITTEE: nothing is served across a chain that says something else.
  const others = [bondOf(0x21), bondOf(0x22)];
  const elsewhere = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const otherContract = contractFor({ censusRoot: rootFor(others) });
  const rid2 = elsewhere.open(otherContract);
  const second = new Roster(elsewhere, { chainFor: ({ contract: c } = {}) => chainWith(others, c),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(others, c), c) }).committeeFor(rid2, 'game');
  assert.equal(second.ok, true, second.why);
  assert.notDeepEqual(second.committee.map((e) => toHex(e.pubkey)).sort(),
    committee.committee.map((e) => toHex(e.pubkey)).sort(), 'another census gave the same committee');

  // AND A REFUSAL IS NEVER KEPT.
  const blind = new Roster(round, { chainFor: () => ({ pending: true }), randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c) });
  assert.equal(blind.seedFor(rid, contract).ok, false);
  assert.equal(blind.seeds.size, 0, 'a refusal was kept');
});


// WHAT THE SLASH-OWING DOOR ANSWERS OVER A REAL CHAIN (§5A.3, ruled 2026-09-22).
//
// The door went in measured only by its refusals: the fixture it was written against has no chain
// view, so every height it was asked for came back 409 and the body it returns on 200 had never
// executed. This is that body, over the census this file mines: real bonds, real `bondSats` off the
// funding outputs, a height above the round's own `census_height`.
test('the slash-owing door answers off the chain at a height above the round\'s own, and the census it reads there is not checked against the round\'s root', async () => {
  const { encodeSlashProof, joinSlashEvidence, slashProofId } = await import('../../arena-protocol/src/slash.js');
  // a stand-in signed result: its bytes do not matter here, its type byte does - a stream of results is cut by it
  const { TYPE_RESULT } = await import('../../arena-protocol/src/constants.js');
  const standIn = () => { const x = new Uint8Array(SIGNED_RESULT_BYTES); x[0] = TYPE_RESULT; return x; };
  const { SIGNED_RESULT_BYTES } = await import('../../arena-protocol/src/result.js');
  const { entryId: entryIdOf } = await import('../../arena-protocol/src/contracts.js');

  // FOUR BONDED NODES, so the census at the slashing height still has somebody in it once §5A.3 takes
  // the round's own seats out. The seats are not chosen here: `contract.nodes` must be EXACTLY what the
  // census assigns or the door refuses the round, and the assignment is seeded from the round id, which
  // the node list is part of - so the fixture settles it by iterating to a fixed point, the same way
  // whoever opens a round has to.
  const both = ['game', 'settlement'];
  const bonds = [bondOf(0x11, both), bondOf(0x12, both), bondOf(0x13, both), bondOf(0x14, both)];
  // TWO OF THE FOUR BONDED NODES ARE THE ROUND'S OWN SEATS, so the census at the slashing height still
  // has two nodes in it once §5A.3 takes the witnesses out. The round is opened on the store rather
  // than posted to `/round`: that door additionally requires `contract.nodes` to be EXACTLY the set the
  // census assigns, which is seeded from the round id the node list is part of - a fixed point this
  // test does not need, because the door under test reads the seats off the stored contract and never
  // asks who was assigned.
  const seats = [keyFor(0x13), keyFor(0x14)];
  const over = { nodes: seats, gameVerifySlots: 2, settlementSlots: 2 };
  const node = await serve(openStore(), { plugins: HOSTED, 
    port: 0, funded: () => true, chainFor: ({ contract } = {}) => chainWith(bonds, contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith(bonds, contract), contract),
  });
  try {
    const c = contractFor({ ...over, censusRoot: rootFor(bonds, over) });
    const rid = node.round.open(c);

    // ONE PAYING ENTRY, so the offence has somebody to have harmed.
    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
      stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
      worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
      feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    node.round.enter(entry);
    const eid = entryIdOf(entry);

    // AND ONE FILED PROOF against a node the chain really carries a bond for.
    const accused = keyFor(0x11);
    const accusedIsASeat = seats.some((k) => toHex(k) === toHex(accused));
    const proof = {
      roundId: rid, playerPubkey: entry.playerPubkey, nodePubkey: accused,
      transcriptHash: b32(0x71), signedResultId: b32(0x72),
      bondTxid: parseTransaction(bonds[0]).txid, bondVout: 0,
    };
    const evidence = joinSlashEvidence(encodeSlashProof(proof), standIn());
    node.round.putSlashProof(rid, eid, accused, slashProofId(proof), evidence);

    // AND A SECOND PROOF, AGAINST A SECOND NODE, IN THE SAME RUN (ruling 3, 2026-09-22: "nothing
    // pooled - each bond pays the players its own proof names"). The door loops over what it holds and
    // that loop had never run past one: the census is read once and shared, and each proof takes its
    // OWN accused out of it, so a second proof is where a shared list would show up as the first one's
    // exclusion leaking into the second.
    const second = keyFor(0x12);
    const alsoProof = { ...proof, nodePubkey: second, bondTxid: parseTransaction(bonds[1]).txid };
    node.round.putSlashProof(rid, eid, second,
      slashProofId(alsoProof), joinSlashEvidence(encodeSlashProof(alsoProof), standIn()));

    // THE ROUND'S OWN CENSUS STILL CHECKS AGAINST ITS ROOT; the one at another height must not, which
    // is the bug this door found. Both read here, off the same node.
    const own = node.roster.censusFor(rid);
    const above = node.roster.censusAtHeight(rid, HEIGHT + 5);

    const got = await fetch(`http://127.0.0.1:${node.port}/slash-owing?round=${toHex(rid)}&entry=${toHex(eid)}&height=${HEIGHT + 5}`);
    const body = got.status === 200 ? await got.json() : await got.text();

    const facts = {
      ownCensus: [own.ok, own.ok ? own.entries.length : own.why],
      aboveCensus: [above.ok, above.ok ? above.entries.length : above.why],
      // THE BOND VALUE IS THE CHAIN'S, not the proof's - a proof names an outpoint and no amount.
      bondSatsAreBigInt: above.ok && above.entries.every((e) => typeof e.bondSats === 'bigint'),
      seats: seats.map((k) => toHex(k).slice(0, 8)),
      accusedIsASeat,
      accusedInCensus: above.ok && above.entries.some((e) => toHex(e.pubkey) === toHex(accused)),
      status: got.status,
      body,
    };
    console.log('  FACTS (the slash-owing door on a real chain):', JSON.stringify(facts, null, 1));

    assert.equal(facts.ownCensus[0], true, `the round's own census stopped deriving: ${facts.ownCensus[1]}`);
    assert.equal(facts.aboveCensus[0], true, `no census above the round's height: ${facts.aboveCensus[1]}`);
    assert.equal(facts.bondSatsAreBigInt, true, 'a census entry carries no bond value for the door to read');
    assert.equal(facts.status, 200, `the door did not answer: ${JSON.stringify(body)}`);

    assert.equal(body.owing.length, 2, 'the door answered for one proof where the node holds two');
    const owed = body.owing.find((o) => o.node === toHex(accused));
    const also = body.owing.find((o) => o.node === toHex(second));
    // THE BOND'S VALUE IS THE CHAIN'S, off the funding output - not a number the proof carries.
    assert.equal(owed.bondSats, '100000000');
    assert.deepEqual([owed.toPlayers, owed.toNodes, owed.toDevelopers], ['50000000', '37500000', '12500000']);
    // THE HARMED PLAYER IS NOT A NODE. The two halves used to share one map, so he was listed here too.
    assert.deepEqual(owed.players.map((p) => p.player), [toHex(entry.playerPubkey)]);
    assert.equal(owed.nodes.some((n) => n.node === toHex(entry.playerPubkey)), false,
      'the harmed player is listed among the census nodes, owed the players\' half a second time');
    // AND THE ACCUSED IS NOT PAID OUT OF THE BOND IT IS SLASHED FOR.
    assert.equal(owed.nodes.some((n) => n.node === toHex(accused)), false,
      'the slashed node was paid a share of its own bond');
    // THE SEATS ARE SUBTRACTED, so of four bonded nodes only the one that is neither seat nor accused
    // is left - and it takes the whole 75%.
    assert.deepEqual(owed.nodes, [{ node: toHex(second), sats: '37500000' }]);
    assert.equal(owed.nodes.reduce((a, n) => a + BigInt(n.sats), 0n), BigInt(owed.toNodes),
      'the nodes\' half did not reach the nodes');

    // THE SECOND PROOF IS COMPUTED OUT OF THE SAME CENSUS AND EXCLUDES ITS OWN ACCUSED, not the first's:
    // it pays 0x11 and not 0x12. A census the loop mutated once would pay neither.
    assert.deepEqual(also.nodes, [{ node: toHex(accused), sats: '37500000' }],
      'the second proof did not pay out of a census holding the first proof\'s accused');
    // NOTHING IS POOLED ACROSS THEM: the harmed player is paid the players' half out of EACH bond.
    assert.deepEqual([owed.players, also.players].map((ps) => ps.map((p) => p.sats)),
      [['50000000'], ['50000000']]);
    // AND EVERY ANSWER ADDS UP TO ITS OWN BOND, so no satoshi of a slashed bond goes unreported.
    for (const o of body.owing)
      assert.equal(BigInt(o.toPlayers) + BigInt(o.toNodes) + BigInt(o.toDevelopers), BigInt(o.bondSats),
        `the three amounts do not sum to the bond for ${o.node.slice(0, 16)}`);

    // AND A HEIGHT BELOW THE ROUND'S OWN IS REFUSED WITHOUT DERIVING A CENSUS AT IT.
    const low = await fetch(`http://127.0.0.1:${node.port}/slash-owing?round=${toHex(rid)}&entry=${toHex(eid)}&height=${HEIGHT - 1}`);
    const lowSaid = await low.text();
    console.log('  FACTS (a height below the round\'s own):', JSON.stringify([low.status, lowSaid.trim()]));
    assert.equal(low.status, 409);
    assert.match(lowSaid, /below the round's census height/);
  } finally { await node.close(); }
});

// A CENSUS KEPT ACROSS A RESTART (OPEN-LIST-2140 item 4): one derivation held a starting seat's loop 2.7 s. A census this
// node checked against its round's own root is stored, and a new Roster over the same store reads it back without
// deriving - the chain view is still asked for (its first height is in the key), the census is not computed again.
test('a census checked against its round\'s root is kept in the store and read back by a restarted roster', () => {
  const { round, rid, roster } = daemon([bondOf(0x11), bondOf(0x12)]);
  const first = roster.censusFor(rid);
  assert.equal(first.ok, true, first.why);
  // a fresh roster over the same store
  const kept = new Roster(round, { chainFor: ({ contract } = {}) => chainWith([bondOf(0x11), bondOf(0x12)], contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith([bondOf(0x11), bondOf(0x12)], contract), contract) });
  const again = kept.censusFor(rid);
  assert.equal(again.ok, true, again.why);
  assert.equal(Buffer.from(again.root).toString('hex'), Buffer.from(first.root).toString('hex'));
  assert.deepEqual(again.entries.map((e) => [Buffer.from(e.pubkey).toString('hex'), e.roles, String(e.bondSats)]),
    first.entries.map((e) => [Buffer.from(e.pubkey).toString('hex'), e.roles, String(e.bondSats)]));
  assert.equal(typeof again.work, 'bigint');
  assert.ok(round.db.prepare('SELECT count(*) n FROM census_kept').get().n >= 1, 'nothing kept in the store');
  // a stored census whose root is not the round's is not taken
  round.db.prepare('UPDATE census_kept SET body = ?').run(JSON.stringify({ ok: true, root: { u8: '00'.repeat(32) }, entries: [] }));
  const third = new Roster(round, { chainFor: ({ contract } = {}) => chainWith([bondOf(0x11), bondOf(0x12)], contract),
    randomnessFor: ({ contract }) => beaconOf(chainWith([bondOf(0x11), bondOf(0x12)], contract), contract) });
  const derivedAgain = third.censusFor(rid);
  assert.equal(derivedAgain.ok, true);
  assert.equal(Buffer.from(derivedAgain.root).toString('hex'), Buffer.from(first.root).toString('hex'), 'a kept census with another root was used');
});

// ONE CENSUS FOR THE ROUNDS OF NO SERIES THAT NAME ONE: an RPS grid's rounds share a census height and a
// network, and a derivation per round cost every seat 0.5-1.3 s per posted round. Kept by what the census is read from,
// and still checked against each round's own root on every ask.
test('rounds of no series naming one census share one derivation, and a round naming another root is still refused', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const round = new Round(openStore(), () => AFTER_COMMITTEE, { plugins: HOSTED });
  const a = round.open(contractFor({ censusRoot: rootFor(bonds), publicationRelays: ['wss://r.example/a'] }));
  const b = round.open(contractFor({ censusRoot: rootFor(bonds), publicationRelays: ['wss://r.example/b'] }));
  const forged = round.open(contractFor({ censusRoot: new Uint8Array(32).fill(0x77), publicationRelays: ['wss://r.example/c'] }));
  const roster = new Roster(round, { chainFor: ({ contract: c } = {}) => chainWith(bonds, c),
    randomnessFor: ({ contract: c }) => beaconOf(chainWith(bonds, c), c) });
  const first = roster.censusFor(a);
  assert.equal(first.ok, true, first.why);
  const second = roster.censusFor(b);
  assert.equal(second, first, 'a second round naming the same census derived it again');
  assert.equal(roster.censuses.size, 1);
  const refused = roster.censusFor(forged);
  assert.equal(refused.ok, false, 'a round naming another root was served the kept census');
  assert.match(refused.why, /^that round names census root 7777777777777777 and the chain gives /);
});
