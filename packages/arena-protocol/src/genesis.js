// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Canonical genesis_parameters and the network_id they produce.
//
// 27A.6: genesis is a block, not a word. 27A.4: network_id is the tagged hash
// of that block plus the donation authority and recovery pubkeys. Changing any
// of it later is a different network.
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { TESTNET_CLOCKS, REGTEST_CLOCKS } from './federation-slash.js';
import { bondMarker } from './constants.js';
import { receiptsNeeded } from './threshold.js';
import {
  ARBITRATION_KEYS_REGTEST, ARBITRATION_KEYS_TESTNET4,
  AUTHORITY_PUBKEY_REGTEST, RECOVERY_PUBKEY_REGTEST,
  AUTHORITY_PUBKEY_TESTNET4, RECOVERY_PUBKEY_TESTNET4, GENESIS_CONFIG_HASH,
} from './genesis-ids.js';
// THE GAME CONFIG THE NETWORK WAS FOUNDED ON, NOT THE LIVE CORE'S (2026-10-04): the network id commits to this config's
// hash, and every contract, bond and donation set is signed under that id - so it is read from the core the network was
// founded on, kept frozen in core/frozen/2069b4c2, and does not follow a later core. When par moved from 3900 ticks to
// 1800 (T sinks from 20 s, the owner 09:17) the live core's constants would have moved the network id: a refound. A later
// core's own rules are named by its core hash, which every round carries beside this config.
// THE GAME'S CONFIGS ARE THE GAME'S: nextblock's config encoders v1-v4 and their hashes moved to
// packages/nextblock/config/game-config.js. The genesis parameters name the founding config only by its hash, the fixed
// GENESIS_CONFIG_HASH (genesis-ids.js); nextblock/test/engine-shared.test.js holds the founding config to it.
export const TAG_GENESIS = 'ARENA/v1/GenesisParameters';
export const TAG_NETWORK_ID = 'ARENA/v1/NetworkId';

/**
 * Randomness nobody in this protocol can grind: the Bitcoin block hash at a
 * height after committee_time. Entry closes before that height is known.
 */
export const RANDOMNESS_SOURCE = 'bitcoin-block-hash';

export function encodeGenesisParameters(p) {
  const w = new Writer();
  w.str(p.chain);
  w.u8(p.gameVerifySlots);
  w.u8(p.gameVerifyThreshold);
  w.u8(p.settlementSlots);
  w.u8(p.settlementThreshold);
  w.u16(p.censusMinNodes);
  w.u32(p.censusConfirmations);
  w.u32(p.bondMaturity);
  // §27A.6's federation parameters, hashed here since v4.6.5 so the network id commits to them.
  w.u16(p.federationNominal);
  w.u32(p.abandonBlocks);
  w.u32(p.departureNotice);
  w.u32(p.foundingWindow);
  w.u32(p.drainBlocks);
  w.u32(p.claimBlocks);

  // WHO CAN SLASH, AND HOW MANY OF THEM. 5A.3B's script path B is
  // "<k-of-m arbitration keys> CHECKMULTISIG - the arbitration quorum, any
  // time before maturity", and the two numbers decide what the bond output
  // key even is: the leaf hashes them, the tapbranch hashes the leaf, and the
  // output key is the tweak of that. A round that disagreed about k or m
  // would compute a different output key for the same node and refuse a bond
  // that is perfectly good.
  //
  // They are genesis and not contract, the same class as `bondMaturity`: a
  // per-round k is a per-round arbitration set, and the set is what the
  // residual in 5A.3B is about. Five of seven, matching every other committee
  // in this protocol.
  w.u8(p.arbitrationK);
  w.u8(p.arbitrationM);

  // AND WHICH KEYS THEY ARE. k and m alone say how many signatures a slash
  // needs; they do not say whose. The slash leaf hashes the keys themselves,
  // so a bond's output key is a function of this set - and a poster free to
  // name their own would name themselves and hold a bond nobody could slash.
  // Sorted, because a set is a set: two nodes listing them differently must
  // not compute two different networks.
  if (!Array.isArray(p.arbitrationKeys) || p.arbitrationKeys.length !== p.arbitrationM)
    throw new Error(`genesis names ${p.arbitrationM} arbitration signer nodes and lists a different number`);
  w.vec([...p.arbitrationKeys].sort(compareGenesis32), (k, ww) => ww.bytes32(k), { sortedBy: compareGenesis32 });
  w.u32(p.noticePeriod);
  w.bytes32(p.bondMarker);
  w.str(p.randomnessSource);
  w.bytes32(p.genesisConfigHash);
  if (!Array.isArray(p.brackets) || p.brackets.length < 1 || p.brackets.length > 255)
    throw new Error('genesis needs 1..255 stake brackets');
  w.u8(p.brackets.length);
  for (const b of p.brackets) {
    w.u64(b.minSats);
    w.u64(b.maxSats);
  }
  // WHEN SERIES 0 STARTS (ALL-BUT-MIN-1727; multiplayer_p2p.md "The series is a function of the clock":
  // series_start(k) = genesis_series_start + k * series_max). A genesis parameter, so the network id commits to it
  // and no series names its own start.
  if (typeof p.genesisSeriesStartMs !== 'bigint' || p.genesisSeriesStartMs < 0n) throw new Error('genesis names when series 0 starts');
  w.u64(p.genesisSeriesStartMs);
  // THE REST OF §27A.6, FROM MAINNET'S GENESIS ON (RULED 2026-10-14 ~13:20Z: "Fix it but no new series
  // or delays because of it"): federation_min, bond_min_guardian, the governance schedule, and whether the committees bind every
  // contract. Written only by a genesis that names them - testnet4's and regtest's do not, so their bytes and their network ids
  // stay as they were and no series moves to a new network.
  if (p.federationMin !== undefined) {
    if (!Number.isInteger(p.federationMin) || p.federationMin < 1 || p.federationMin > p.federationNominal)
      throw new Error('federation_min is 1..federation_nominal');
    if (typeof p.bondMinGuardianSats !== 'bigint' || p.bondMinGuardianSats <= 0n) throw new Error('genesis names a guardian\'s bond floor in sats');
    const sched = p.governanceSchedule;
    if (!sched || !['design', 'money', 'upgrade'].every((k) => sched[k] && ['review', 'voting', 'cooldown'].every((x) => Number.isInteger(sched[k][x]) && sched[k][x] >= 0)))
      throw new Error('genesis names the governance schedule: review, voting and cooldown blocks for design, money and upgrade');
    w.u16(p.federationMin);
    w.u64(p.bondMinGuardianSats);
    for (const k of ['design', 'money', 'upgrade']) { w.u32(sched[k].review); w.u32(sched[k].voting); w.u32(sched[k].cooldown); }
    w.u8(p.committeesBind ? 1 : 0);
  }
  return w.finish();
}

/**
 * MAINNET'S GENESIS (§27A.6, the "Three networks" table), built from the parts only a launch can name: the
 * bond marker (§25.1), the seven arbitration keys, the donation authority and the cold recovery key (§27A.4 - the recovery key
 * belongs in a safe), and when series 0 starts. Nothing here invents them: without each one it throws, and this build runs no
 * mainnet. The rest is the table's: committees of 7 slots, threshold 5 for both roles, binding every contract; a census of 10;
 * 6 confirmations; federations of 10 with federation_min 7; the fast clocks the owner set; ~30 days of bond maturity and notice;
 * governance 1008 / 1440 / 2016 (upgrades 2016 / 2016 / 4320, ballot.js).
 */
export function mainnetGenesis({ bondMarker: marker, arbitrationKeys, authorityPubkey, recoveryPubkey, genesisSeriesStartMs, bondMinGuardianSats } = {}) {
  const is32 = (x) => x instanceof Uint8Array && x.length === 32;
  if (!is32(marker)) throw new Error('mainnet genesis needs its bond marker (32 bytes, §25.1): it has not been chosen');
  if (!Array.isArray(arbitrationKeys) || arbitrationKeys.length !== 7 || !arbitrationKeys.every(is32)) throw new Error('mainnet genesis needs its 7 arbitration keys');
  if (!is32(authorityPubkey) || !is32(recoveryPubkey)) throw new Error('mainnet genesis needs the donation authority and the cold recovery key (§27A.4)');
  if (typeof genesisSeriesStartMs !== 'bigint') throw new Error('mainnet genesis names when series 0 starts');
  if (typeof bondMinGuardianSats !== 'bigint' || bondMinGuardianSats <= 0n) throw new Error('mainnet genesis names a guardian\'s bond floor');
  const genesis = {
    chain: 'bitcoin-mainnet', genesisSeriesStartMs,
    federationNominal: 10, federationMin: 7, bondMinGuardianSats,
    abandonBlocks: 288, departureNotice: 432, foundingWindow: 432, drainBlocks: 4032, claimBlocks: 216,
    gameVerifySlots: 7, gameVerifyThreshold: 5, settlementSlots: 7, settlementThreshold: 5, committeesBind: true,
    censusMinNodes: 10, censusConfirmations: 6, bondMaturity: 4320,
    arbitrationK: 5, arbitrationM: 7, arbitrationKeys, noticePeriod: 4320,
    bondMarker: marker, randomnessSource: RANDOMNESS_SOURCE, genesisConfigHash: GENESIS_CONFIG_HASH,
    brackets: [{ minSats: 1000n, maxSats: 10_000_000n }],
    governanceSchedule: { design: { review: 1008, voting: 1440, cooldown: 2016 }, money: { review: 1008, voting: 1440, cooldown: 2016 },
      upgrade: { review: 2016, voting: 2016, cooldown: 4320 } },
  };
  return { genesis, networkId: computeNetworkId({ genesis, authorityPubkey, recoveryPubkey }) };
}

/**
 * EVERY CONTRACT BOUND TO ITS GENESIS (§5A.7 / §27A.62026-10-16: "the client refuses to join
 * and names the mismatched parameter"): where the genesis says its committees bind, a Round Contract names exactly its slots per role,
 * the threshold of those slots (threshold.js) is the genesis's, and its census confirmations are the genesis's. Each mismatch is named
 * by its parameter. A genesis that does not bind (testnet4, regtest - per the 2026-10-14 ruling, no new series) leaves each contract its
 * own values. The seat (POST /round) and the client (the join) ask this one function.
 */
export function committeesStand(contract, genesis) {
  if (!genesis || !genesis.committeesBind) return { ok: true, bound: false };
  const off = [];
  const g = Number(contract && contract.gameVerifySlots), st = Number(contract && contract.settlementSlots);
  if (g !== genesis.gameVerifySlots) off.push(`game_verify_slots ${g}, the genesis binds ${genesis.gameVerifySlots}`);
  if (st !== genesis.settlementSlots) off.push(`settlement_slots ${st}, the genesis binds ${genesis.settlementSlots}`);
  if (g === genesis.gameVerifySlots && receiptsNeeded(g) !== genesis.gameVerifyThreshold)
    off.push(`game_verify_threshold ${receiptsNeeded(g)}, the genesis binds ${genesis.gameVerifyThreshold}`);
  if (st === genesis.settlementSlots && receiptsNeeded(st) !== genesis.settlementThreshold)
    off.push(`settlement_threshold ${receiptsNeeded(st)}, the genesis binds ${genesis.settlementThreshold}`);
  const conf = contract && contract.censusConfirmations;
  if (conf !== undefined && conf !== null && Number(conf) !== genesis.censusConfirmations)
    off.push(`census_confirmations ${Number(conf)}, the genesis binds ${genesis.censusConfirmations}`);
  if (off.length) return { ok: false, off, why: `this network's genesis binds the contract, and it names ${off.join('; ')}` };
  return { ok: true, bound: true };
}

/**
 * WHEN EACH NETWORK'S SERIES 0 STARTS, midnight UTC (ALL-BUT-MIN-1727). The spec names the parameter and not its value;
 * these are this build's: regtest 2026-01-01, testnet4 2026-10-01. Series k starts 24 h * k after it.
 */
export const GENESIS_SERIES_START_MS = Object.freeze({ regtest: 1767225600000n, testnet4: 1790812800000n });

export function testnetShape(chain, marker, arbitrationKeys, federation, genesisSeriesStartMs) {
  return {
    chain,
    genesisSeriesStartMs,
    // THE FEDERATION'S OWN PARAMETERS ARE GENESIS PARAMETERS (§27A.6), so they are hashed into the
    // network id like every other rule a player is held to. Without them two networks could share an id
    // while one drains a federation in 24 h and the other in 28 d, and a contract naming that id would
    // not say how long its holder's money can be frozen or how long he has to claim it.
    federationNominal: federation.federationNominal,
    abandonBlocks: federation.abandonBlocks,
    departureNotice: federation.departureNotice,
    foundingWindow: federation.foundingWindow,
    drainBlocks: federation.drainBlocks,
    claimBlocks: federation.claimBlocks,
    gameVerifySlots: 2,
    gameVerifyThreshold: 2,
    settlementSlots: 2,
    settlementThreshold: 2,
    censusMinNodes: 2,
    censusConfirmations: 1,
    bondMaturity: 100,
    arbitrationK: 5,
    arbitrationM: 7,
    arbitrationKeys,
    noticePeriod: 144,
    bondMarker: marker,
    randomnessSource: RANDOMNESS_SOURCE,
    genesisConfigHash: GENESIS_CONFIG_HASH,
    brackets: [{ minSats: 1000n, maxSats: 10_000_000n }],
  };
}

/** Two 32-byte keys in byte order, so a set is a set and not an arrangement. */
function compareGenesis32(a, b) {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const concat = (...parts) => {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const zeros32 = () => new Uint8Array(32);

export function computeNetworkId({ genesis, authorityPubkey, recoveryPubkey }) {
  if (!(authorityPubkey instanceof Uint8Array) || authorityPubkey.length !== 32)
    throw new Error('donation authority pubkey is 32 bytes');
  if (!(recoveryPubkey instanceof Uint8Array) || recoveryPubkey.length !== 32)
    throw new Error('donation recovery pubkey is 32 bytes');
  const body = encodeGenesisParameters(genesis);
  return taggedHash(
    TAG_NETWORK_ID,
    concat(body, authorityPubkey, recoveryPubkey, zeros32(), zeros32()),
  );
}

/** 2 slots → 2-of-2 (this build). 7 slots → 5-of-7. One rule: threshold.js. */
export { receiptsNeeded };

export function genesisFor(network) {
  if (network === 'regtest')
    return testnetShape('bitcoin-regtest', bondMarker('regtest'), ARBITRATION_KEYS_REGTEST,
      { federationNominal: 4, ...REGTEST_CLOCKS }, GENESIS_SERIES_START_MS.regtest);
  if (network === 'testnet4' || network === 'testnet')
    return testnetShape('bitcoin-testnet4', bondMarker('testnet'), ARBITRATION_KEYS_TESTNET4,
      { federationNominal: 4, ...TESTNET_CLOCKS }, GENESIS_SERIES_START_MS.testnet4);
  throw new Error('no genesis for ' + network);
}

/**
 * THE TWO KEYS 27A.4 PUTS IN THE NETWORK'S NAME, looked up by network.
 *
 * They have been generated, written into `genesis-ids.js` and hashed into
 * `network_id` by `computeNetworkId` since letter 24 - and until `authority.js`
 * nothing read them. A key that decides where donations go and that no code
 * consults is not a control; it is a comment.
 *
 * The authority is what a published donation set is checked against, and the
 * recovery key is what a rotation is checked against - never the other way
 * round. 27A.4's table is exhaustive: the authority signs sets and nothing
 * else, the recovery key names a new authority and nothing else.
 *
 * 2026-09-08: these are test keys on disk for regtest and testnet4.
 * A mainnet recovery key belongs in a safe, and this build has no mainnet.
 */
export function donationKeysFor(network) {
  if (network === 'regtest')
    return { authority: AUTHORITY_PUBKEY_REGTEST, recovery: RECOVERY_PUBKEY_REGTEST };
  if (network === 'testnet4' || network === 'testnet')
    return { authority: AUTHORITY_PUBKEY_TESTNET4, recovery: RECOVERY_PUBKEY_TESTNET4 };
  throw new Error('no donation authority has been generated for ' + network);
}

// THE SAME TWO KEYS BY NETWORK ID: donation-keys.js, re-exported (M3.2 6e).
export { donationKeysForNetworkId } from './donation-keys.js';
