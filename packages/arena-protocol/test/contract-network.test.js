// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5d / 27A.4: THE FIELDS A SIGNED CONTRACT MUST CARRY BEFORE ANYTHING USES
// THEM.
//
// "Anything the Round Contract carries has to be in its FIRST version, because
// adding a field to something signed is a format break." After the first bond
// exists, a break costs every node its census entry: capital timelocked, entry
// void. So the fields go in now, while nothing is committed.
//
// 27A.4: `network_id = H(genesis_parameters || donation_authority_pubkey ||
// donation_recovery_pubkey || predecessor || fork_certificate_hash)`. "Round
// Contracts carry it, nodes and clients reject contracts that do not match the
// one they were built for, and censuses are per-network."
//
// 27A.7.5: "A round is bound to the config it was created under. The Round
// Contract carries `config_hash` alongside `network_id`."
//
// NEITHER VALUE CAN BE COMPUTED HERE and neither is faked. `network_id`'s
// preimage names `bond_marker`, which is null by decision, and two keys nobody
// has generated; `genesis_config_hash` is H(canonical(game_config)) and there
// is no game_config to canonicalise. Both anchors are null and both accessors
// refuse - the fields exist, the values wait.
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../src/donation.js';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  NETWORK_ID, networkAnchor, GENESIS_CONFIG_HASH, genesisConfigHash,
} from '../src/constants.js';
import {
  encodeRoundContract, decodeRoundContract, roundId, contractIsForThisBuild,
} from '../src/contracts.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sample = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: 1788200000000n, entryCloseMs: 1788200060000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000,
  exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792,
  timeFloor: 16384, timeCeil: 98304, minScore: 1,
  rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4), b32(7), b32(9)],
});

/**
 * BOTH FIELDS SURVIVE THE ROUND TRIP, which is the whole of what 5d asks for
 * at this stage: they exist, they are signed, and they come back.
 */
test('a round contract carries its network and its config, and they round-trip', () => {
  const c = sample();
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(toHex(back.networkId), toHex(c.networkId));
  assert.equal(toHex(back.configHash), toHex(c.configHash));

  // and the version that was always on the wire is now handed back too, which
  // is what lets the census filter on the ROUND's version instead of a default
  assert.equal(back.protocolVersion, 1);
});

/**
 * AND EACH MOVES THE ROUND ID. A field that did not would be decoration: two
 * rounds on different networks, or under different rules, would share an id
 * and every signature over one would count for the other.
 */
test('the network and the config are each in the round id', () => {
  const c = sample();
  const base = toHex(roundId(c));

  assert.notEqual(toHex(roundId({ ...c, networkId: b32(0x4f) })), base,
    'a contract for another network shares this one\'s id');
  assert.notEqual(toHex(roundId({ ...c, configHash: b32(0x44) })), base,
    'a round under other rules shares this one\'s id');

  // and the same contract twice is the same id, so the movement is the field
  assert.equal(toHex(roundId(sample())), base);
});

/**
 * THE DEPTH RULE AND THE TWO SIGNER NODE COUNTS ARE THE ROUND'S, AND THEY ARE THREE
 * DIFFERENT NUMBERS.
 *
 * 5A.11 pairs the depth with the height: "The Round Contract contains:
 * `census_height, census_confirmations`". Section 6 carries the signer node counts and
 * says what a disagreement means: "MUST equal genesis_parameters... A contract
 * disagreeing with the network it names is invalid, NOT A SMALLER COMMITTEE."
 *
 * The two counts are tested UNEQUAL. A mutant that swapped them survived while
 * every fixture used seven and seven, which proved only that seven is seven.
 */
test('the depth and the two signer node counts round-trip as three separate numbers', () => {
  const c = { ...sample(), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 3 };
  const back = decodeRoundContract(encodeRoundContract(c));
  assert.equal(back.censusConfirmations, 6);
  assert.equal(back.gameVerifySlots, 7);
  assert.equal(back.settlementSlots, 3, 'the settlement signer nodes came back as the game signer nodes');

  const base = toHex(roundId(c));
  assert.notEqual(toHex(roundId({ ...c, censusConfirmations: 7 })), base, 'the depth');
  assert.notEqual(toHex(roundId({ ...c, gameVerifySlots: 5 })), base, 'the game signer nodes');
  assert.notEqual(toHex(roundId({ ...c, settlementSlots: 5 })), base, 'the settlement signer nodes');

  // and swapping the two is a different round, which it would not be if the
  // encoder wrote them in one order and the decoder read them in the other
  const swapped = { ...c, gameVerifySlots: c.settlementSlots, settlementSlots: c.gameVerifySlots };
  assert.notEqual(toHex(roundId(swapped)), base);
  assert.equal(decodeRoundContract(encodeRoundContract(swapped)).gameVerifySlots, 3);
});

/**
 * A CONTRACT MISSING EITHER IS REFUSED BY NAME rather than encoded as zeros. A
 * zero network is a network, and it is one nobody can be built for.
 */
test('a contract that names no network, or no config, cannot be encoded', () => {
  const c = sample();
  assert.throws(() => encodeRoundContract({ ...c, networkId: undefined }),
    /expected 32 bytes/);
  assert.throws(() => encodeRoundContract({ ...c, configHash: undefined }),
    /expected 32 bytes/);
  assert.throws(() => encodeRoundContract({ ...c, networkId: b32(0x4e).slice(0, 16) }),
    /expected 32 bytes/);
});

/**
 * 27A.4: "nodes and clients reject contracts that do not match the one they
 * were built for". 27A.9: "The trust anchor is the client's own built-in
 * `network_id`, NEVER A VALUE FROM THE CONTRACT" - so the anchor is handed in,
 * and is not read off the thing being judged.
 */
test('a contract for another network is refused, and the anchor is not the contract\'s', () => {
  const c = sample();
  const anchor = b32(0x4e);
  const config = b32(0x43);

  assert.equal(contractIsForThisBuild(c, { anchor, config }).ok, true);

  const foreign = contractIsForThisBuild({ ...c, networkId: b32(0x4f) }, { anchor, config });
  assert.equal(foreign.ok, false);
  assert.match(foreign.why, /for another network/);

  // "Someone who forks the code and writes their own donation address in has
  // not captured the donations - they have left." So the refusal is not an
  // error condition, it is the fork being visible.
  const otherWay = contractIsForThisBuild(c, { anchor: b32(0x4f), config });
  assert.equal(otherWay.ok, false, 'the contract talked this build into its own network');
});

/**
 * 27A.7.5: a node on other rules "simply stops being selectable for rounds
 * naming the new hash... It is not ejected and it is not slashed; it serves
 * nothing." Which is why this answers rather than throwing.
 */
test('a round under rules this build is not running is not served', () => {
  const c = sample();
  const out = contractIsForThisBuild(c, { anchor: b32(0x4e), config: b32(0x44) });
  assert.equal(out.ok, false);
  assert.match(out.why, /not selectable for it - not ejected, not slashed/);
});

/**
 * AND IT REFUSES IN BOTH DIRECTIONS: a contract with nothing to check, and a
 * build with nothing to check it against. The second is this build's actual
 * state, and it is the safe direction: a build that names no network accepts
 * no contract.
 */
test('a missing field on either side is a refusal, and each says which', () => {
  const c = sample();
  const anchor = b32(0x4e);
  const config = b32(0x43);

  assert.match(contractIsForThisBuild({ ...c, networkId: undefined }, { anchor, config }).why,
    /contract names no network/);
  assert.match(contractIsForThisBuild({ ...c, configHash: undefined }, { anchor, config }).why,
    /contract names no config/);
  assert.match(contractIsForThisBuild(c, { config }).why,
    /this build names no network/);
  assert.match(contractIsForThisBuild(c, { anchor }).why,
    /this build names no config/);
  assert.equal(contractIsForThisBuild(undefined, { anchor, config }).ok, false);
  assert.equal(contractIsForThisBuild(c).ok, false);
});

/**
 * AND A SHORT ID IS NOT A SHORT ID, IT IS NOT AN ID.
 *
 * Found by a mutant that survived: the length check dropped to an instanceof,
 * and nothing noticed - because the comparison walks the CONTRACT's bytes. A
 * sixteen-byte `networkId` that matches the anchor's first sixteen would then
 * pass `.every` and be accepted as this network, which is a prefix collision
 * an attacker gets to choose the length of.
 */
test('a truncated network or config is refused, not prefix-matched', () => {
  const c = sample();
  const anchor = b32(0x4e);
  const config = b32(0x43);

  const half = contractIsForThisBuild({ ...c, networkId: b32(0x4e).slice(0, 16) }, { anchor, config });
  assert.equal(half.ok, false, 'sixteen bytes of the anchor passed for all of it');
  assert.match(half.why, /contract names no network/);

  const halfConfig = contractIsForThisBuild({ ...c, configHash: b32(0x43).slice(0, 16) }, { anchor, config });
  assert.equal(halfConfig.ok, false);
  assert.match(halfConfig.why, /contract names no config/);

  // and the same on this build's side of the comparison
  assert.match(contractIsForThisBuild(c, { anchor: anchor.slice(0, 16), config }).why,
    /this build names no network/);
  assert.match(contractIsForThisBuild(c, { anchor, config: config.slice(0, 16) }).why,
    /this build names no config/);
});

/**
 * NEITHER VALUE IS INVENTED HERE. `network_id` commits to `genesis_parameters`,
 * which names the `bond_marker` that is null one constant above it, and to two
 * keys nobody has generated. Writing a plausible one into this tree would
 * settle the network's identity by accident - the same reason `bondMarker()`
 * throws, and the reason there is no `networkId()` deriver at all.
 */
test('the network and the config this build is for are testnet4 and the live core', () => {
  assert.equal(NETWORK_ID.length, 32);
  assert.equal(GENESIS_CONFIG_HASH.length, 32);
  assert.equal(toHex(networkAnchor()), toHex(NETWORK_ID));
  assert.equal(toHex(networkAnchor('testnet4')), toHex(NETWORK_ID));
  assert.equal(networkAnchor('regtest').length, 32);
  assert.notEqual(toHex(networkAnchor('regtest')), toHex(NETWORK_ID));
  assert.throws(() => networkAnchor('mainnet'), /has not been chosen/);
  assert.equal(toHex(genesisConfigHash()), toHex(GENESIS_CONFIG_HASH));

  // a sample contract is not this network, so the build still refuses it
  assert.equal(contractIsForThisBuild(sample(), { anchor: NETWORK_ID, config: GENESIS_CONFIG_HASH }).ok,
    false);
});
