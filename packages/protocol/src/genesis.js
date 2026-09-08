// Canonical genesis_parameters and the network_id they produce.
//
// 27A.6: genesis is a block, not a word. 27A.4: network_id is the tagged hash
// of that block plus the donation authority and recovery pubkeys. Changing any
// of it later is a different network.
import { Writer } from './encode.js';
import { taggedHash } from './hash.js';
import { bondMarker } from './constants.js';
import { NODE_FEE_BPS } from './fee.js';
import {
  EXPOSURE_REFERENCE, APRON_RADIUS, FRONT_SCORE_SPAN, T_FLOOR, T_CEIL,
  REFERENCE_TICKS,
} from '../../core/src/rules/score.js';
import { HALF_MOUTH, BLOCK_TICKS } from '../../core/src/rules/gate.js';
import {
  HEAT_REACH_ARMOUR, HEAT_REACH_RIFLE, HEAT_OUTRANK, HEAT_SHELL,
} from '../../core/src/rules/army.js';

export const TAG_GAME_CONFIG = 'BLWP/v1/GameConfig';
export const TAG_GENESIS = 'BLWP/v1/GenesisParameters';
export const TAG_NETWORK_ID = 'BLWP/v1/NetworkId';

/** Opening fee and difficulty as the live core plays them. */
export function encodeGameConfig() {
  const w = new Writer();
  w.u32(EXPOSURE_REFERENCE);
  w.u32(HALF_MOUTH);
  w.u32(APRON_RADIUS);
  w.u32(FRONT_SCORE_SPAN);
  w.u32(T_FLOOR);
  w.u32(T_CEIL);
  w.u32(1);
  w.u8(3);
  w.u8(4);
  w.u16(BLOCK_TICKS);
  w.u16(NODE_FEE_BPS);
  w.u32(HEAT_REACH_ARMOUR);
  w.u32(HEAT_REACH_RIFLE);
  w.u32(HEAT_OUTRANK);
  w.u32(HEAT_SHELL);
  w.u32(REFERENCE_TICKS);
  return w.finish();
}

export const computeGenesisConfigHash = () => taggedHash(TAG_GAME_CONFIG, encodeGameConfig());

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
  return w.finish();
}

export function testnetShape(chain, marker) {
  return {
    chain,
    gameVerifySlots: 2,
    gameVerifyThreshold: 2,
    settlementSlots: 2,
    settlementThreshold: 2,
    censusMinNodes: 2,
    censusConfirmations: 1,
    bondMaturity: 100,
    arbitrationK: 5,
    arbitrationM: 7,
    noticePeriod: 144,
    bondMarker: marker,
    randomnessSource: RANDOMNESS_SOURCE,
    genesisConfigHash: computeGenesisConfigHash(),
    brackets: [{ minSats: 1000n, maxSats: 10_000_000n }],
  };
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

/** 2 slots → 2-of-2 (this build). 7 slots → 5-of-7. */
export function receiptsNeeded(slots) {
  if (slots === 2) return 2;
  if (slots === 7) return 5;
  throw new Error(`no committee threshold for ${slots} slots`);
}

export function genesisFor(network) {
  if (network === 'regtest')
    return testnetShape('bitcoin-regtest', bondMarker('regtest'));
  if (network === 'testnet4' || network === 'testnet')
    return testnetShape('bitcoin-testnet4', bondMarker('testnet'));
  throw new Error('no genesis for ' + network);
}
