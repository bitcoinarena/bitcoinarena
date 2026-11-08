// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Canonical genesis_parameters and the network_id they produce.
//
// 27A.6: genesis is a block, not a word. 27A.4: network_id is the tagged hash
// of that block plus the donation authority and recovery pubkeys. Changing any
// of it later is a different network.
import { Writer } from './encode.js';
import { taggedHash, toHex } from './hash.js';
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
/**
 * NODE_FEE_BPS_MAX, A GENESIS PARAMETER (§27A.7.4 RULED 2026-11-07, kanban #1300/#1335): the highest node fee a MONEY ballot may set. Raising it
 * is an UPGRADE - a new network the clients must choose to follow (§27A.8) - never a config vote, so a fee vote cannot raise its own ceiling.
 */
export const NODE_FEE_BPS_MAX = 600;

/**
 * THE SLASH CLOCKS OF TEMPLATE 3, by network (§27A.6's table, §5A.3B). Hashed into mainnet's network id. On testnet4 and regtest they are
 * read from genesis and NOT hashed: their ids are fixed and a moved id is a new network, the same reason as BOND_MATURITY_OFFSET
 * (bond-script.js) and the ruling of 2026-10-14 below. A network founded on these clocks hashes them.
 */
// THE FALLBACK OPENS BEFORE THE RETURN (RULED 2026-11-07, kanban #1287 / #1317): return 432 / 108 / 36 after fallback 288 / 72 / 24. With the
// return first (144 / 36 / 12) a slash on a mature bond landed only if both panels signed within a day, and the bonding presig (no panel leaf)
// made a mature guardian, auditor or panel member unslashable; now the census key always gets its turn
export const SLASH_CLOCKS = Object.freeze({
  mainnet: Object.freeze({ slashHoldBlocks: 6, slashReturnBlocks: 432, slashFallbackBlocks: 288 }),
  testnet4: Object.freeze({ slashHoldBlocks: 1, slashReturnBlocks: 108, slashFallbackBlocks: 72 }),
  regtest: Object.freeze({ slashHoldBlocks: 1, slashReturnBlocks: 36, slashFallbackBlocks: 24 }),
});

/**
 * A CARRIER'S PAYOUT FEE, msat, by network (§5A.3B, RULED 2026-11-03, kanban #1086): the part of the margin a carrier keeps back of a claim for its own payout's fee in the
 * players' federation, so that fee never comes out of a loss. Mainnet the same as the test networks: the spec names no other value, and one federation payout measured 352 msat.
 * Not in genesis and not hashed, beside it as CENSUS_KEY_BOND_MIN is; nor are the two below. A slash's table names their sum (carrier_margin_msat) and the escrow spend's
 * outputs[] repeat it, so no signer chooses it and every signer builds the same bytes.
 */
export const CARRIER_PAYOUT_FEE_MSAT = Object.freeze({ mainnet: 10_000n, testnet4: 10_000n, regtest: 10_000n });

/**
 * A CARRIER'S PEG-IN FEE ALLOWANCE, msat, by network (kanban #1093, "fix both"): the receiving federation takes its own fee off a deposit before it credits it. A walletv2
 * federation charges its consensus feerate (never under 1 sat/vB) times its config's receive_tx_vbytes: the safe federation of the real-Fedimint liquidation run took
 * 416 sat of a 299,594 sat output (1 sat/vB), so a margin of 10 sat left the carrier 406,016 msat short of the claims and they waited for ever. The feerate moves with
 * the chain and with the federation's pending transactions, so no seat can read one value every signer agrees on: the allowance is a network constant, as the margin
 * was, sized for the measured peg-in (416 vB) at about 4.8 sat/vB on the test networks and about 48 sat/vB on mainnet. Unused allowance is not the carrier's: what
 * the claim leaves past the players and the payout fee goes to the reserve key in the same payout (#1086's rule). A peg-in dearer than the allowance pays the
 * players pro rata (slash) or waits (liquidation), as before.
 */
export const CARRIER_PEGIN_FEE_MSAT = Object.freeze({ mainnet: 20_000_000n, testnet4: 2_000_000n, regtest: 2_000_000n });

/** What every player_carrier and claims_carrier output holds past what it carries: the peg-in allowance plus the payout fee (kanban #1086, #1093). */
export const CARRIER_PAYOUT_MARGIN_MSAT = Object.freeze(Object.fromEntries(Object.keys(CARRIER_PAYOUT_FEE_MSAT).map((n) => [n, CARRIER_PAYOUT_FEE_MSAT[n] + CARRIER_PEGIN_FEE_MSAT[n]])));

/** census_key_shares_max (§27A.6, §5A.3B, RULED 2026-11-02, kanban #1021): hashed as the slash clocks are, and for the same reason not on the test networks. */
export const CENSUS_KEY_SHARES_MAX = 1024;

/**
 * B OF THE CENSUS KEY (§5A.3B, kanban #1034 answer 3): a network number, one per network, beside genesis as BOND_MATURITY_OFFSET is. Testnet4's live
 * floor, and regtest's. Mainnet's is the lowest bracket's value and stands in its genesis, hashed, as censusKeyBondMinSats. A caller never passes B.
 */
export const CENSUS_KEY_BOND_MIN = Object.freeze({ testnet4: 50000n, regtest: 50000n });

/**
 * WHERE A NETWORK'S CENSUS KEYS BEGIN (kanban #1041 answer 2, #1021 ruling 5): the chain scan for "ARN" 'K' runs forward from this height and keeps what it
 * found across restarts, with no lookback window (a key is named by bonds for years, and #820 is what a window does). A run belongs to the epochs that
 * start at or after it, so the first key is that epoch's. Null is not named: no key and no template-3 bond on that network. Named per network by the release, as
 * FOUNDING_PRESSURE_HEIGHT is, and only after the network runs CENSUS_KEY_VERSION. Mainnet has none here: it scans from genesis_height, which its genesis commits (kanban #1048).
 */
// NAMED IN 2.0 (the owner's decision on #1083, 2026-11-03: release, fallback, payout table and panel signing are in 2.0, and the height is named for the networks the key goes
// live on). Regtest and a devnet: 0, so a private chain runs the key from its first epoch. Testnet4: 160,128, CONFIRMED by the owner 2026-11-03 (kanban #972) -
// 1112 x 144, an epoch's first block, about 10-12 days past the tip of 2026-11-03 (158,705): room for 2.0 on every seat, outside nodes on CENSUS_KEY_VERSION and
// #724's rehearsal bond. A key's run starts at that epoch's first block. Mainnet: none here, it scans from genesis_height.
export const TESTNET4_CENSUS_KEY_FIRST_HEIGHT = 160128;
export const CENSUS_KEY_FIRST_HEIGHT = Object.freeze({ testnet4: TESTNET4_CENSUS_KEY_FIRST_HEIGHT, regtest: 0 });
export function censusKeyFirstHeight(network, genesis = null) {
  if (network === 'mainnet') return genesis && Number.isInteger(genesis.genesisHeight) ? genesis.genesisHeight : null;
  return Object.prototype.hasOwnProperty.call(CENSUS_KEY_FIRST_HEIGHT, network) ? CENSUS_KEY_FIRST_HEIGHT[network] : null;
}

/**
 * WHERE A BOND IS TEMPLATE 3 OR NOTHING (5A.3B, RULED 2026-11-03, kanban #1065): template 2 counts for nothing there, so a node never falls back to it. With no census key read it posts no bond and
 * says why, by this name: that is real money locked in a bond that does not count. Every other network keeps template 2 where no key stands.
 */
export const NO_CENSUS_KEY_READ = 'no census key read yet';
export const readsTemplate3Only = (network) => network === 'mainnet';

/**
 * CENSUS_KEY_0 { public_key, holders[], threshold } (§5A.3B, kanban #1050): the founders' node keys, one share each, in share order, so holders[i] holds x = i + 1. The threshold is any
 * key's, floor(2 x shares / 3) + 1, and the founders are at least the census minimum. Answers { ok } or { ok: false, why }.
 */
export function censusKey0Stands(k0, { minHolders, sharesMax }) {
  const is32 = (x) => x instanceof Uint8Array && x.length === 32;
  if (!k0 || !is32(k0.publicKey)) return { ok: false, why: 'census key 0 names its public key' };
  if (!Array.isArray(k0.holders) || !k0.holders.every(is32)) return { ok: false, why: 'census key 0 names its holders, the founders\' node keys' };
  if (new Set(k0.holders.map(toHex)).size !== k0.holders.length) return { ok: false, why: 'census key 0 names a holder twice: one share each' };
  if (k0.holders.length < minHolders) return { ok: false, why: `census key 0 names ${k0.holders.length} holders, under the census minimum of ${minHolders}` };
  if (k0.holders.length > sharesMax) return { ok: false, why: `census key 0 names ${k0.holders.length} holders, over census_key_shares_max` };
  const threshold = Math.floor((2 * k0.holders.length) / 3) + 1;
  if (k0.threshold !== threshold) return { ok: false, why: `census key 0 names threshold ${k0.threshold}, and ${k0.holders.length} shares have ${threshold}` };
  return { ok: true };
}

export function censusKeyBondMin(network, genesis = null) {
  if (network === 'mainnet') {
    if (!genesis || typeof genesis.censusKeyBondMinSats !== 'bigint') throw new Error('mainnet reads the census key\'s bond floor from its genesis');
    return genesis.censusKeyBondMinSats;
  }
  const B = CENSUS_KEY_BOND_MIN[network];
  if (typeof B !== 'bigint') throw new Error(`no census key bond floor is set for ${network}`);
  return B;
}

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
    // TEMPLATE 3'S CLOCKS (§27A.6, §5A.3B), in this block for the reason the block exists: the test networks' bytes do not move.
    if (![p.slashHoldBlocks, p.slashReturnBlocks, p.slashFallbackBlocks].every((n) => Number.isInteger(n) && n >= 1 && n <= 0xffff))
      throw new Error('genesis names the slash clocks: hold, return and fallback blocks, each one CHECKSEQUENCEVERIFY can wait for');
    if (!(p.slashHoldBlocks < p.slashFallbackBlocks && p.slashFallbackBlocks < p.slashReturnBlocks))
      throw new Error('the slash clocks run hold, then fallback, then return: the census key gets its turn before a mature node can leave (§5A.3B, kanban #1287)');
    w.u32(p.slashHoldBlocks);
    w.u32(p.slashReturnBlocks);
    w.u32(p.slashFallbackBlocks);
    if (!Number.isInteger(p.censusKeySharesMax) || p.censusKeySharesMax < 1) throw new Error('genesis names census_key_shares_max');
    w.u32(p.censusKeySharesMax);
    if (typeof p.censusKeyBondMinSats !== 'bigint' || p.censusKeyBondMinSats <= 0n) throw new Error('genesis names the census key\'s bond floor');
    w.u64(p.censusKeyBondMinSats);
    // THE KEY THE GENESIS FOUNDERS MADE BEFORE ANY BOND (§5A.3B, kanban #1050): committed here, so it needs no anchor. It stands in for key 0's CensusKeyRecord: the holders are written
    // so the 80 % trigger can read them, and it leaves out network_id, which would be circular.
    const zero = censusKey0Stands(p.censusKey0, { minHolders: p.censusMinNodes, sharesMax: p.censusKeySharesMax });
    if (!zero.ok) throw new Error(zero.why);
    w.bytes32(p.censusKey0.publicKey);
    w.vec(p.censusKey0.holders, (h, ww) => ww.bytes32(h));
    w.u32(p.censusKey0.threshold);
    // WHERE MAINNET'S CHAIN SCAN STARTS (§27A.6, kanban #1048): scanning from height 0 is years of nothing.
    if (!Number.isInteger(p.genesisHeight) || p.genesisHeight < 0) throw new Error('genesis names genesis_height');
    w.u32(p.genesisHeight);
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
export function mainnetGenesis({ bondMarker: marker, arbitrationKeys, authorityPubkey, recoveryPubkey, genesisSeriesStartMs, bondMinGuardianSats, censusKey0, censusKeyBondMinSats, genesisHeight } = {}) {
  const is32 = (x) => x instanceof Uint8Array && x.length === 32;
  if (!is32(marker)) throw new Error('mainnet genesis needs its bond marker (32 bytes, §25.1): it has not been chosen');
  if (!Array.isArray(arbitrationKeys) || arbitrationKeys.length !== 7 || !arbitrationKeys.every(is32)) throw new Error('mainnet genesis needs its 7 arbitration keys');
  if (!is32(authorityPubkey) || !is32(recoveryPubkey)) throw new Error('mainnet genesis needs the donation authority and the cold recovery key (§27A.4)');
  if (typeof genesisSeriesStartMs !== 'bigint') throw new Error('mainnet genesis names when series 0 starts');
  if (typeof bondMinGuardianSats !== 'bigint' || bondMinGuardianSats <= 0n) throw new Error('mainnet genesis names a guardian\'s bond floor');
  if (typeof censusKeyBondMinSats !== 'bigint' || censusKeyBondMinSats <= 0n) throw new Error('mainnet genesis names the lowest bracket\'s bond_min, the census key\'s B (§5A.3B)');
  if (!censusKey0) throw new Error('mainnet genesis needs census key 0: the founders run its DKG before any bond exists (§5A.3B)');
  if (!Number.isInteger(genesisHeight) || genesisHeight < 0) throw new Error('mainnet genesis names genesis_height, where its chain scan starts (§5A.3B)');
  const genesis = {
    chain: 'bitcoin-mainnet', genesisSeriesStartMs, genesisHeight, censusKey0, censusKeySharesMax: CENSUS_KEY_SHARES_MAX, censusKeyBondMinSats,
    federationNominal: 10, federationMin: 7, bondMinGuardianSats,
    abandonBlocks: 288, departureNotice: 432, foundingWindow: 432, drainBlocks: 4032, claimBlocks: 216,
    gameVerifySlots: 7, gameVerifyThreshold: 5, settlementSlots: 7, settlementThreshold: 5, committeesBind: true,
    censusMinNodes: 10, censusConfirmations: 6, bondMaturity: 4320, ...SLASH_CLOCKS.mainnet,
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
    slashHoldBlocks: federation.slashHoldBlocks,
    slashReturnBlocks: federation.slashReturnBlocks,
    slashFallbackBlocks: federation.slashFallbackBlocks,
    censusKeySharesMax: CENSUS_KEY_SHARES_MAX,
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
      { federationNominal: 4, ...REGTEST_CLOCKS, ...SLASH_CLOCKS.regtest }, GENESIS_SERIES_START_MS.regtest);
  if (network === 'testnet4' || network === 'testnet')
    return testnetShape('bitcoin-testnet4', bondMarker('testnet'), ARBITRATION_KEYS_TESTNET4,
      { federationNominal: 4, ...TESTNET_CLOCKS, ...SLASH_CLOCKS.testnet4 }, GENESIS_SERIES_START_MS.testnet4);
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
