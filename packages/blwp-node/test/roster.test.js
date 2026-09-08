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
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { toHex } from '../../protocol/src/hash.js';
import { keyFor, bondFor } from './curve.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const HEIGHT = 900000;
const TIP = HEIGHT + 10;
const FROM = HEIGHT - 20;

const contractFor = (over = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  startTimeMs: 1000n, entryCloseMs: 2000n, objectionWindowMs: 600000n,
  custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN',
  donationSetId: b32(0xd0), censusHeight: HEIGHT, censusRoot: b32(2),
  committeeSeed: b32(3), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
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

function daemon(bonds, over = {}) {
  const round = new Round(openStore(), () => 1234);
  const contract = contractFor(over);
  const rid = round.open(contract);
  const roster = new Roster(round, { chainFor: () => chainWith(bonds) });
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
    const roster = new Roster(round, { chainFor, ...tried });
    const seats = roster.committeeFor(rid, 'game', tried);
    assert.equal(seats.ok, false, `a caller lowered the minimum with ${Object.keys(tried)[0]}`);
    assert.match(seats.why, /born needing 2/);
  }
});

test('a node with no chain view holds no round, and says which it is missing', () => {
  const round = new Round(openStore(), () => 1234);
  const rid = round.open(contractFor());
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
    port: 0, funded: () => true, chainFor: () => chainWith(bonds),
  });
  try {
    const c = contractFor();
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
    port: 0, funded: () => true, chainFor: () => chainWith([bondOf(0x11)]),
  });
  try {
    const c = contractFor();
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
