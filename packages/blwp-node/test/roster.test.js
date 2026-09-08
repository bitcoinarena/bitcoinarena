// THE DAEMON ASKS BITCOIN WHO MAY HOLD THE ROUND.
//
// Everything letter 15 built was library code with no caller: measured at the
// start of this slice, not one file under any `src/` called `scanCensus`,
// `resolveCensus`, `deriveCensus` or `commitCensus`. A node could serve rounds
// without ever asking the chain who was bonded, and the "not deployable" line
// that closed 15 was exactly this.
//
// `src/roster.js` is that caller, and the guard below keeps it the only one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Roster } from '../src/roster.js';
import { serve } from '../src/server.js';
import { chainOf } from '../../protocol/tools/chainview.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { encodeRoundContract, decodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { toHex } from '../../protocol/src/hash.js';
import { keyFor, bondFor } from './curve.js';
import { deriveCensus } from '../../protocol/src/census.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { bondSetFor } from '../src/curve.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
// THE BEACON these rounds are seeded from, owned by the fixture the way the
// census root is: a value published ABOVE the census height, which is what
// `beaconIsAfterRound` can prove until `committee_time` exists.
const COMMITTEE_TIME = 500n;
const BEACON = { hash: new Uint8Array(32).fill(0xbe), height: 900005, timeMs: 900n };
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const contractFor = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN',
  donationSetId: b32(0xd0), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeTimeMs: COMMITTEE_TIME, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)], ...over,
});

const advertFor = (n, roles) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [1], roles,
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), timestamp: 1788700000000n,
});
const bondOf = (n, roles = ['game']) => bondTransaction(advertFor(n, roles), {
  previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)),
});

/** A mined chain carrying those bonds well under the census height. */
const chainWith = (bonds) => {
  const blocks = [];
  for (let h = FROM; h <= TIP; h++) blocks.push({ transactions: h === FROM ? bonds : [] });
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
  const round = new Round(openStore(), () => 1234);
  const contract = contractFor({ ...over, censusRoot: rootFor(bonds, over) });
  const rid = round.open(contract);
  const roster = new Roster(round, { chainFor: () => chainWith(bonds), randomnessFor: () => BEACON });
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

test('the daemon derives the census from the chain and seats a committee from it', () => {
  const { rid, roster } = daemon([bondOf(0x11), bondOf(0x12)]);

  const census = roster.censusFor(rid);
  assert.equal(census.ok, true, census.why);
  assert.equal(census.entries.length, 2, `excluded: ${census.excluded.map((e) => e.why).join(' | ')}`);
  assert.equal(census.unchecked.some((u) => /script template/.test(u)), false,
    'the daemon published a root with the bond template unchecked');

  const seats = roster.committeeFor(rid, 'game');
  assert.equal(seats.ok, true, seats.why);
  assert.equal(seats.committee.length, 2);
  assert.deepEqual(toHex(seats.root), toHex(census.root));
  assert.deepEqual(
    seats.committee.map((e) => toHex(e.pubkey)).sort(),
    [keyFor(0x11), keyFor(0x12)].map(toHex).sort(),
    'the committee is not the bonded nodes the chain carries');
});

test('one bonded node against a two-slot contract seats nobody, by name', () => {
  const { rid, roster } = daemon([bondOf(0x11)]);

  const census = roster.censusFor(rid);
  assert.equal(census.ok, true, census.why);
  assert.equal(census.entries.length, 1, 'the chain carries one bond and the census disagrees');

  const seats = roster.committeeFor(rid, 'game');
  assert.equal(seats.ok, false, 'the daemon seated a committee of one');
  assert.match(seats.why, /that census carries 1 game node where regtest was born needing 2/);
  assert.equal(seats.committee, undefined);
});

test('two bonded nodes, one game and one settlement, hold neither role', () => {
  const { rid, roster } = daemon([bondOf(0x11, ['game']), bondOf(0x12, ['settlement'])]);

  assert.equal(roster.censusFor(rid).entries.length, 2, 'both bonds are in the census');
  for (const role of ['game', 'settlement']) {
    const seats = roster.committeeFor(rid, role);
    assert.equal(seats.ok, false, `${role} was seated from a census of one`);
    assert.match(seats.why, new RegExp(`carries 1 ${role} node where regtest was born needing 2`));
  }
});

test('the caller cannot name a minimum of its own', () => {
  const { round, rid } = daemon([bondOf(0x11)]);
  const chainFor = () => chainWith([bondOf(0x11)]);

  // Every shape a caller might try it in: on the roster, on the call, and on
  // the contract the round was opened with.
  for (const tried of [{ minimum: 1 }, { censusMinNodes: 1 }, { min: 1 }]) {
    const roster = new Roster(round, { chainFor, randomnessFor: () => BEACON, ...tried });
    const seats = roster.committeeFor(rid, 'game', tried);
    assert.equal(seats.ok, false, `a caller lowered the minimum with ${Object.keys(tried)[0]}`);
    assert.match(seats.why, /born needing 2/);
  }
});

test('a node with no chain view holds no round, and says which it is missing', () => {
  const round = new Round(openStore(), () => 1234);
  const rid = round.open(contractFor({ censusRoot: rootFor([bondOf(0x11), bondOf(0x12)]) }));
  const blind = new Roster(round);        // the default: no source of blocks

  const census = blind.censusFor(rid);
  assert.equal(census.ok, false, 'a census was derived from nothing');
  assert.match(census.why, /no chain view for that round/);
  assert.match(blind.committeeFor(rid, 'game').why, /no chain view for that round/);

  // and a round this node does not hold is not a census either
  assert.match(blind.censusFor(b32(0x99)).why, /holds no such round/);
});

test('the committee door answers off the chain, and refuses a short census by name', async () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const node = await serve(openStore(), {
    port: 0, funded: () => true, chainFor: () => chainWith(bonds), randomnessFor: () => BEACON,
  });
  try {
    const c = contractFor({ censusRoot: rootFor(bonds) });
    await fetch(`http://127.0.0.1:${node.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const rid = toHex(roundId(c));

    const got = await fetch(`http://127.0.0.1:${node.port}/committee?round=${rid}&role=game`);
    const seats = new Uint8Array(await got.arrayBuffer());
    assert.equal(got.status, 200, `the door refused: ${new TextDecoder().decode(seats)}`);
    assert.equal(got.headers.get('x-eligible'), '2');
    assert.equal(got.headers.get('x-seats'), '2');
    assert.equal(seats.length, 64, 'the door did not answer with two keys');
    assert.deepEqual(
      [toHex(seats.slice(0, 32)), toHex(seats.slice(32))].sort(),
      [keyFor(0x11), keyFor(0x12)].map(toHex).sort());
  } finally { await node.close(); }

  const thin = await serve(openStore(), {
    port: 0, funded: () => true, chainFor: () => chainWith([bondOf(0x11)]), randomnessFor: () => BEACON,
  });
  try {
    const c = contractFor({ censusRoot: rootFor([bondOf(0x11)]) });
    await fetch(`http://127.0.0.1:${thin.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
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

test('a bond the census excluded is never seated, however many slots there are', () => {
  // Found by a mutant that survived: seating `entries` plus `excluded` broke
  // nothing, because every fixture here was a bond that PASSED. A daemon that
  // seated an excluded node would put a key the chain refuses on the
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

  // THREE SLOTS, TWO ELIGIBLE: the honest answer is two seats, and the only
  // way to fill the third is to seat somebody the census refused.
  const seats = roster.committeeFor(rid, 'game');
  assert.equal(seats.ok, true, seats.why);
  assert.equal(seats.committee.length, 2, 'a third seat was filled from somewhere');
  assert.equal(seats.committee.some((e) => toHex(e.pubkey) === toHex(keyFor(0x13))), false,
    'a bond the chain refused was seated on the committee');
});

test('a round whose census root is not the chain\'s is refused, not served', () => {
  // 5A.4 on a contract whose census root is not what its census derives to:
  // it "IS INVALID and no honest node will issue receipts against it". Every
  // contract names a root, and on this path nothing compared it with the
  // blocks - so a round could name any thirty-two bytes, and this node would
  // derive a different census, seat a committee from it and serve that. Which
  // is the divergence 5A.2 removes, arriving from the round's own header.
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const honest = rootFor(bonds);

  const round = new Round(openStore(), () => 1234);
  const rid = round.open(contractFor({ censusRoot: b32(0x5a) }));
  const roster = new Roster(round, { chainFor: () => chainWith(bonds), randomnessFor: () => BEACON });

  const census = roster.censusFor(rid);
  assert.equal(census.ok, false, 'a round naming somebody else\'s census root was served');
  assert.match(census.why, /names census root 5a5a5a5a5a5a5a5a and the chain gives/);
  assert.match(census.why, new RegExp(`gives ${toHex(honest).slice(0, 16)} at height ${HEIGHT}`),
    'the refusal does not say what the chain actually gives');

  // and no committee comes out of a census that was refused
  const seats = roster.committeeFor(rid, 'game');
  assert.equal(seats.ok, false);
  assert.equal(seats.committee, undefined);

  // THE SAME BLOCKS, THE ROOT THEY REALLY PRODUCE: held.
  const good = new Round(openStore(), () => 1234);
  const goodId = good.open(contractFor({ censusRoot: honest }));
  const right = new Roster(good, { chainFor: () => chainWith(bonds), randomnessFor: () => BEACON });
  assert.equal(right.committeeFor(goodId, 'game').ok, true);

  // AND A ROUND THAT NAMES NO ROOT AT ALL IS NOT A ROUND EITHER. A contract
  // always carries thirty-two bytes there, so this is the shape a caller
  // building one by hand would hit.
  const bare = new Roster(good, { chainFor: () => chainWith(bonds), randomnessFor: () => BEACON });
  bare.round = { get: () => ({ contract: encodeRoundContract(contractFor({ censusRoot: b32(0) })) }) };
  assert.match(bare.censusFor(goodId).why, /names census root 0000000000000000 and the chain gives/);
});

test('the daemon seats on the beacon\'s seed, and on nothing else', async () => {
  // Found by mutants that survived: every fixture above has exactly as many
  // eligible nodes as slots, so ANY seed seats the same two and none of them
  // could tell which seed was used. Six bonded nodes and two slots is a census
  // where the seed decides.
  const { committeeSeedFrom } = await import('../../protocol/src/beacon.js');
  const { roundId } = await import('../../protocol/src/contracts.js');
  const { selectCommittee } = await import('../../protocol/src/sortition.js');

  const many = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26].map((n) => bondOf(n));
  const chosen = b32(0x5e);                       // what an author would write
  const { round, rid, roster } = daemon(many, { committeeSeed: chosen });

  const seats = roster.committeeFor(rid, 'game');
  assert.equal(seats.ok, true, seats.why);
  assert.equal(seats.committee.length, 2);

  const contract = decodeRoundContract(new Uint8Array(round.get(rid).contract));
  const fromBeacon = committeeSeedFrom({
    censusRootGameVerify: contract.censusRoot, censusRootSettlement: contract.censusRoot,
    roundId: rid, roundRandomness: BEACON.hash,
  });
  const seatedBy = (seed) => selectCommittee({
    entries: roster.censusFor(rid).entries, contract, role: 'game', committeeSeed: seed,
  }).map((e) => toHex(e.pubkey)).sort();

  // WHO SITS IS WHO THE BEACON'S SEED SEATS.
  assert.deepEqual(seats.committee.map((e) => toHex(e.pubkey)).sort(), seatedBy(fromBeacon));

  // AND NOT WHO THE CONTRACT'S BYTES WOULD HAVE SEATED - which is a different
  // pair here, or this test would not be able to tell them apart.
  assert.notDeepEqual(seatedBy(fromBeacon), seatedBy(chosen),
    'the two seeds seat the same pair, so this census cannot measure the difference');
  assert.notDeepEqual(seats.committee.map((e) => toHex(e.pubkey)).sort(), seatedBy(chosen),
    'the daemon seated the pair the contract\'s own bytes choose');
});

test('a node with no beacon, or one the creator already had, seats nobody', () => {
  const bonds = [bondOf(0x11), bondOf(0x12)];
  const { round, rid } = daemon(bonds);

  // NO BEACON: refused by name, and never a fallback to the contract's bytes.
  const blind = new Roster(round, { chainFor: () => chainWith(bonds) });
  const seats = blind.committeeFor(rid, 'game');
  assert.equal(seats.ok, false, 'a node with no beacon seated a committee anyway');
  assert.match(seats.why, /no beacon for that round/);

  // A BEACON THE CREATOR COULD HAVE HELD: at or before the round's own
  // committee time, which is where 5A.5 draws the line now that the field
  // exists - "committee_time: beacon value appears".
  for (const timeMs of [COMMITTEE_TIME, COMMITTEE_TIME - 1n, 0n]) {
    const early = new Roster(round, {
      chainFor: () => chainWith(bonds),
      randomnessFor: () => ({ hash: BEACON.hash, height: BEACON.height, timeMs }),
    });
    const out = early.committeeFor(rid, 'game');
    assert.equal(out.ok, false, `a beacon at ${timeMs} seeded a round it predates`);
    assert.match(out.why, /at or before this round's committee time/);
  }
});
