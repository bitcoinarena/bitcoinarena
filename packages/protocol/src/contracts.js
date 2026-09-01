// The two artifacts everything else hangs off.
//
// A RoundContract is what every participant must agree on byte for byte before
// a round can start; its digest IS the round_id. An EntryContract is one
// player's commitment to that round.
//
// Field order is protocol. Adding a field means a new version, not an append -
// an old implementation reading a new contract must fail rather than silently
// mis-parse, which is why the version comes second, right after the type.

import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import {
  TAG, PROTOCOL_VERSION, TYPE_ROUND_CONTRACT, TYPE_ENTRY_CONTRACT, ROLES,
} from './constants.js';

/**
 * The balance constants live in the contract because 18A.7 says they must:
 * a contract that leaves the rank curve flat or exposure additive is one whose
 * safe route is +EV, and a client has to be able to see that before entering.
 */
export function encodeRoundContract(c) {
  const w = new Writer();
  w.u8(TYPE_ROUND_CONTRACT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(c.simCoreHash);
  w.u64(c.startTimeMs);
  w.u64(c.entryCloseMs);
  w.u32(c.censusHeight);
  w.bytes32(c.censusRoot);
  w.bytes32(c.committeeSeed);
  w.u64(c.stakeMsat);
  w.u64(c.bondMinSats);
  w.u16(c.blockTicks);

  // balance, all integers
  w.u32(c.exposureReference);
  w.u32(c.corridorHalfWidth);
  w.u32(c.spawnFreeRadius);
  w.u32(c.timeFloor);
  w.u32(c.timeCeil);
  w.u32(c.minScore);
  w.u8(c.rankNumerator);          // 3 of 4 = the 0.75 curve
  w.u8(c.rankDenominator);

  w.vec([...c.nodes].sort(compare32), (n, ww) => ww.bytes32(n), { sortedBy: compare32 });
  return w.finish();
}

export function decodeRoundContract(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_ROUND_CONTRACT) throw new Error('not a RoundContract: type ' + type);
  const version = r.u16();
  if (version !== PROTOCOL_VERSION)
    throw new Error('protocol version ' + version + ', this build speaks ' + PROTOCOL_VERSION);

  const c = {
    simCoreHash: r.bytes32(),
    startTimeMs: r.u64(),
    entryCloseMs: r.u64(),
    censusHeight: r.u32(),
    censusRoot: r.bytes32(),
    committeeSeed: r.bytes32(),
    stakeMsat: r.u64(),
    bondMinSats: r.u64(),
    blockTicks: r.u16(),
    exposureReference: r.u32(),
    corridorHalfWidth: r.u32(),
    spawnFreeRadius: r.u32(),
    timeFloor: r.u32(),
    timeCeil: r.u32(),
    minScore: r.u32(),
    rankNumerator: r.u8(),
    rankDenominator: r.u8(),
    nodes: r.vec((rr) => rr.bytes32()),
  };
  r.end();
  return c;
}

export const roundId = (c) => taggedHash(TAG.roundContract, encodeRoundContract(c));

export function encodeEntryContract(e) {
  const w = new Writer();
  w.u8(TYPE_ENTRY_CONTRACT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(e.roundId);
  w.bytes32(e.playerPubkey);
  w.bytes32(e.sessionPubkey);
  w.bytes32(e.stakeCommitment);      // H(P), the hold-invoice preimage commitment
  w.u64(e.stakeMsat);
  w.u64(e.feeMsat);
  w.u64(e.donationMsat);
  w.u32(e.joinTick);
  return w.finish();
}

export function decodeEntryContract(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ENTRY_CONTRACT) throw new Error('not an EntryContract');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const e = {
    roundId: r.bytes32(),
    playerPubkey: r.bytes32(),
    sessionPubkey: r.bytes32(),
    stakeCommitment: r.bytes32(),
    stakeMsat: r.u64(),
    feeMsat: r.u64(),
    donationMsat: r.u64(),
    joinTick: r.u32(),
  };
  r.end();
  return e;
}

export const entryId = (e) => taggedHash(TAG.entryContract, encodeEntryContract(e));

function compare32(a, b) {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Warnings a client must show before a player stakes anything.
 *
 * Spec 18A.7: a contract whose rank curve is flat, or whose paying ranks cover
 * most of the field, is one whose safe route is positive expected value. The
 * protocol does not forbid it - balance is not protocol - but a player is
 * entitled to know before paying.
 */
export function contractWarnings(c) {
  const out = [];
  const r = c.rankNumerator / c.rankDenominator;
  if (!(r < 0.95)) out.push('flat_rank_curve');
  if (c.exposureReference === 0) out.push('exposure_ignored');
  if (c.timeFloor >= c.timeCeil) out.push('time_factor_degenerate');
  if (c.minScore > 0 && c.minScore > 100) out.push('minimum_score_is_a_danger_rule');
  return out;
}
