// THE COMMITTEE SEED, AND WHY IT CANNOT BE A NUMBER THE ROUND'S CREATOR KNOWS.
//
// Section 5A.5:
//
//     committee_seed = H(census_root_game_verify || census_root_settlement
//                        || round_id || round_randomness)
//
// with the hard rule that `round_randomness` is "a public randomness beacon
// value that DOES NOT EXIST YET when round_id is published. The Round Contract
// commits to WHICH beacon round will be used, not to its value."
//
// THE ATTACK THIS CLOSES, in the spec's own words: in v4.4 "the creator chose
// round_id while public_randomness was already known, so committee selection
// was a pure function of a value the attacker controlled. Grinding round_ids
// offline until both committees consisted of his own nodes was trivial and
// undetectable - 5A.11's 'committee cannot be overwritten' check passed,
// because nothing was overwritten."
//
// So the ordering is the security property, not the hashing. Two nodes given
// the same published value must reach the same seat list, and a value the
// creator could have known when they chose their round must not be usable at
// all. The first is arithmetic; the second is evidence, and evidence is what
// this file asks the caller for and refuses to assume.
import { toHex, taggedHash } from './hash.js';
import { TAG, networkOf } from './constants.js';
import { genesisFor } from './genesis.js';

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

/**
 * THE SEED, EXACTLY AS 5A.5 WRITES IT.
 *
 * Four 32-byte inputs in that order and nothing else. The order is not a
 * detail: two nodes concatenating differently would select different
 * committees from identical facts, which is the one thing a committee cannot
 * survive.
 */
export function committeeSeedFrom({
  censusRootGameVerify, censusRootSettlement, roundId, roundRandomness,
}) {
  for (const [name, value] of [
    ['the game/verify census root', censusRootGameVerify],
    ['the settlement census root', censusRootSettlement],
    ['the round id', roundId],
    ['the round randomness', roundRandomness],
  ]) if (!is32(value)) throw new TypeError(`${name} is not 32 bytes`);

  return taggedHash(TAG.committeeSeed,
    cat(censusRootGameVerify, censusRootSettlement, roundId, roundRandomness));
}

/**
 * WAS THIS VALUE UNKNOWABLE WHEN THE ROUND WAS MADE?
 *
 * A beacon is only worth anything if it came AFTER the round it seeds, and a
 * hash on its own carries no date - so the caller brings the height it was
 * published at, and the contract is asked what it already knew.
 *
 * WHAT THE CONTRACT CAN PROVE TODAY, and it is less than the whole rule: it
 * commits to `census_height`, so a beacon at or below that height is one whose
 * chain state the creator demonstrably had in hand - refused. Above it, this
 * check cannot yet say whether the creator had already seen the block, because
 * the contract carries no publication height and no `committee_time`: 5A.5
 * ties the beacon to `committee_time`, and that field does not exist here.
 * Until it does, this refuses what it can prove and says so rather than
 * implying a guarantee it cannot make.
 *
 * It is deliberately not a default: a caller with no height gets a refusal,
 * because "I do not know when this was published" and "it was published late
 * enough" must never be the same answer.
 */
export function beaconIsAfterRound(contract, { height, timeMs } = {}) {
  // WHICH BEACON, AND WHEN: both are the contract's now, and 5A.5 ties the
  // randomness to `committee_time` rather than to anything about the census.
  // Before this the check measured the beacon against `census_height` and said
  // so - what it could prove, not what the rule asks - because the field did
  // not exist. It does now.
  if (!contract || typeof contract.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no committee time, so nothing says when its beacon is due' };
  if (typeof contract.randomnessRule !== 'string' || !contract.randomnessRule)
    return { ok: false, why: 'that round names no randomness rule, so nothing says which beacon seeds it' };

  const network = contract.networkId ? networkOf(contract.networkId) : null;
  if (network === null)
    return { ok: false, why: 'that round names a network this build has no genesis for' };
  const source = genesisFor(network).randomnessSource;
  if (contract.randomnessRule !== source)
    return {
      ok: false,
      why: `that round names randomness rule "${contract.randomnessRule}" where ${network} was `
        + `born reading "${source}"`,
    };

  // A BEACON WITH NO TIME IS NOT A LATE BEACON. "I do not know when this was
  // published" and "it was published after committee_time" must never be the
  // same answer, so a caller with no timestamp gets a refusal.
  if (typeof timeMs !== 'bigint')
    return { ok: false, why: 'that randomness names no time, so nothing says it came after committee_time' };
  if (timeMs <= contract.committeeTimeMs)
    return {
      ok: false,
      why: `that randomness is from ${timeMs}, at or before this round's committee time `
        + `${contract.committeeTimeMs} - the creator could have held it when the round was made`,
    };

  return { ok: true, height, timeMs, provenAfter: contract.committeeTimeMs };
}

export function committeeSeedFromBeacon(contract, { roundId, randomness, height, timeMs }) {
  const later = beaconIsAfterRound(contract, { height, timeMs });
  if (!later.ok) return later;
  if (!is32(contract.censusRoot))
    return { ok: false, why: 'that round names no census root' };

  // ONE ROOT WHERE THE SPEC NAMES TWO. 5A.5 hashes the game/verify root and
  // the settlement root; this contract carries a single `censusRoot`, so both
  // positions are filled from it and the seed is honest about that rather than
  // silently hashing 32 fewer bytes. Two roots is a contract field and belongs
  // with the letter that adds one.
  try {
    return {
      ok: true,
      seed: committeeSeedFrom({
        censusRootGameVerify: contract.censusRoot,
        censusRootSettlement: contract.censusRoot,
        roundId,
        roundRandomness: randomness,
      }),
      height,
      timeMs,
      rootsAreOne: true,
    };
  } catch (err) { return { ok: false, why: err.message }; }
}
