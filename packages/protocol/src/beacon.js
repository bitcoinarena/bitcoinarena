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
import { blockHashOf, blockTimeOf, chainWork } from './chain.js';

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

  // AND A FALLBACK IS THE SAME BEACON OR IT IS NOTHING.
  //
  // Spec v4.6.2 has no fallback beacon: §6 dropped `randomness_fallback`, and
  // 5A.5's beacon is the first Bitcoin block after committee_time. On a network
  // born reading `bitcoin-block-hash` that IS the rule - there is nothing else
  // a fallback could name - so the only honest values are absent, empty, or
  // the born rule itself. Anything else is a
  // SECOND randomness source, and a second source is a second committee: a
  // creator who could fall back to a beacon of their own choosing would pick
  // the one that seats their nodes, which is 5A.5's whole attack with an extra
  // step.
  //
  // The field does not encode, so a foreign fallback cannot arrive over the
  // wire at all - `decodeRoundContract` produces none. This refuses one on a
  // contract OBJECT, which is the only place it could still appear.
  const fallback = contract.randomnessFallback;
  if (fallback !== undefined && fallback !== null && fallback !== ''
      && fallback !== source)
    return {
      ok: false,
      why: `that round names randomness fallback "${fallback}" where ${network} was born `
        + `reading "${source}" - a fallback is the same beacon or it is nothing`,
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

/**
 * BIP-113's span: a block's time is the median of ELEVEN, itself included.
 *
 * Bitcoin Core's `CBlockIndex::GetMedianTimePast` walks back eleven entries
 * starting at the block itself, so the median covers heights N-10..N. Written
 * out rather than guessed, because eleven-with-itself and eleven-before-it are
 * different numbers on the same chain.
 */
export const MEDIAN_TIME_SPAN = 11;

/**
 * The median time past at `at`, in seconds, from headers in height order.
 *
 * `headers[0]` is `firstHeight`. Answers null when the view does not reach
 * back far enough - "I cannot compute it here" and "it is early" must never
 * be the same answer.
 */
export function medianTimePast(headers, firstHeight, at) {
  const last = at - firstHeight;
  const first = last - MEDIAN_TIME_SPAN + 1;
  if (first < 0 || last >= headers.length) return null;
  const times = [];
  for (let i = first; i <= last; i++) times.push(blockTimeOf(headers[i]));
  times.sort((a, b) => a - b);
  return times[(MEDIAN_TIME_SPAN - 1) >> 1];
}

/**
 * WHICH BLOCK SEEDS THIS ROUND'S COMMITTEE, from the chain and nothing else.
 *
 * 5A.5 (spec v4.6.2) names a beacon by TIME - the first Bitcoin block whose
 * median-time-past is after committee_time - so that every node lands on the
 * same value without anybody naming it (`genesis.randomnessSource` is
 * `bitcoin-block-hash`). The spec then takes round_randomness =
 * H(hash(beacon_block) || height(beacon_block)); the callers here still seed
 * with the block hash itself, which this function does not change. But a
 * source is not a selection: two honest nodes
 * polling at different moments would take different tips, derive different
 * seeds and seat different committees. This is the missing half.
 *
 * THE HEIGHT IS DERIVED, NEVER NAMED. It is not on the contract, not on the
 * entry and not an argument: an author who names the height picks the block,
 * and picking the block is grinding the committee, which is the whole attack
 * 5A.5 exists to close. What the contract commits to is `committee_time` and
 * the source, and that is the commitment.
 *
 * THE FIRST BLOCK WHOSE MEDIAN TIME PAST IS AFTER `committee_time`. Not the
 * tip, which moves; not the header's own nTime, which a miner may write two
 * hours ahead and which need not increase. STRICTLY after, and that is a
 * correction to the instruction rather than a liberty: `beaconIsAfterRound`
 * already refuses a beacon AT committee_time - the creator could have held it
 * when the round was made - so selecting a block at that instant would hand
 * the validator a block it must reject. Selection and validation agree, and
 * the stricter of the two wins.
 *
 * AND DEEP ENOUGH, by the round's own `censusConfirmations` rather than a
 * second knob. A hash one block deep can be reorged out, and a reorg that
 * changes the seed changes who sits. Too shallow is refused - not seated on,
 * not closed on, not invented around.
 */
export function beaconFromChain(contract, view) {
  if (!contract || typeof contract.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no committee time, so nothing says which block seeds it' };
  if (!Number.isInteger(contract.censusConfirmations) || contract.censusConfirmations < 1)
    return { ok: false, why: 'that round names no confirmation depth, so nothing says when a beacon is settled' };

  // HEADERS, WHICH IS WHAT A PROVIDER SERVES. 25.1's sources hand 80-byte
  // headers back to back and `agreedChain` weighs those; a beacon needs a
  // hash and a time and neither is in a transaction, so asking for whole
  // blocks here would demand of a provider something the protocol never asks
  // it for. Mined and linked are still checked, by the same function the
  // work comparison uses.
  if (!view || !Array.isArray(view.headers) || !view.headers.length)
    return { ok: false, why: 'a chain view is at least one header' };
  if (!Number.isInteger(view.firstHeight))
    return { ok: false, why: 'a chain view says which height it starts at' };
  const chain = chainWork(view.headers);
  if (!chain.ok)
    return { ok: false, why: `this view is not a chain: ${chain.why}` };

  const headers = view.headers;
  const firstHeight = view.firstHeight;
  const tipHeight = firstHeight + headers.length - 1;
  const after = contract.committeeTimeMs;
  let chosen = null;
  for (let h = firstHeight; h <= tipHeight; h++) {
    const mtp = medianTimePast(headers, firstHeight, h);
    if (mtp === null) continue;                  // no median here yet
    if (BigInt(mtp) * 1000n > after) { chosen = { height: h, mtp }; break; }
  }

  if (chosen === null) {
    const reach = medianTimePast(headers, firstHeight, tipHeight);
    return {
      ok: false,
      why: reach === null
        ? `this view is ${headers.length} blocks and a median time past is taken over `
          + `${MEDIAN_TIME_SPAN}, so it says nothing about when any of them was`
        : `no block in this view is after this round's committee time ${after}: the `
          + `last one's median time past is ${BigInt(reach) * 1000n}`,
    };
  }

  // AND THE VIEW HAS TO REACH BACK FAR ENOUGH TO KNOW IT IS THE FIRST.
  //
  // Found by running this on a real regtest, not by reading it: the answer was
  // window-dependent. A node reading 64 headers to the tip named block 69; a
  // node whose view began at 103 named block 112 - of the same chain, for the
  // same round. "The first block in THIS VIEW after committee_time" is not
  // "the first block after committee_time" unless the view starts before that
  // instant, and two honest nodes with different windows would have seated
  // different committees, which is the whole property this rule exists for.
  //
  // So: if the EARLIEST median this view can compute is already after
  // committee_time, the view may be starting too late to see the real first
  // block, and it says so instead of answering. A view that reaches back
  // before the instant can answer, and every such view answers the same.
  const earliest = medianTimePast(headers, firstHeight, firstHeight + MEDIAN_TIME_SPAN - 1);
  if (earliest !== null && BigInt(earliest) * 1000n > after)
    return {
      ok: false,
      why: `this view begins at height ${firstHeight} and its earliest median time is `
        + `${BigInt(earliest) * 1000n}, already after this round's committee time ${after}: `
        + 'it cannot say which block is the FIRST one, only which is the first it holds',
    };

  const depth = tipHeight - chosen.height + 1;
  if (depth < contract.censusConfirmations)
    return {
      ok: false,
      why: `the block that seeds this round is ${depth} deep and this round asks for `
        + `${contract.censusConfirmations}: a hash that shallow can be reorged out, and a `
        + 'reorg that changes the seed changes who sits',
    };

  return {
    ok: true,
    height: chosen.height,
    hash: blockHashOf(headers[chosen.height - firstHeight]),
    timeMs: BigInt(chosen.mtp) * 1000n,
    depth,
  };
}

/**
 * IS THE BEACON SOMEBODY HANDED ME THE ONE THIS CHAIN NAMES?
 *
 * `beaconFromChain` derives the answer; this refuses a different one. They are
 * two directions of the same rule and both are needed, because a node does not
 * always derive its own: `roster.js` and `verify.js` take a beacon from their
 * caller, and `beaconIsAfterRound` only asks whether it came AFTER
 * committee_time. Late is not the same as right. A block six hours past
 * committee_time is late, and if it is not the FIRST such block then whoever
 * chose it chose the seed, which is the grinding this letter closes with one
 * extra step.
 *
 * So: same height, same hash, same time, or a refusal that names both.
 */
export function beaconIsTheChains(contract, beacon, view) {
  const named = beaconFromChain(contract, view);
  if (!named.ok) return named;
  if (!beacon || typeof beacon !== 'object')
    return { ok: false, why: 'no beacon was offered to check against the chain' };

  if (beacon.height !== named.height)
    return {
      ok: false,
      why: `that beacon is block ${beacon.height} where this chain names ${named.height} `
        + `as the first after committee time ${contract.committeeTimeMs}: a later block is `
        + 'a block somebody chose',
    };
  if (!(beacon.hash instanceof Uint8Array) || toHex(beacon.hash) !== toHex(named.hash))
    return {
      ok: false,
      why: `that beacon carries a hash block ${named.height} does not have`,
    };
  if (beacon.timeMs !== named.timeMs)
    return {
      ok: false,
      why: `that beacon says it was published at ${beacon.timeMs} where block `
        + `${named.height}'s median time past is ${named.timeMs}`,
    };
  return { ok: true, height: named.height, hash: named.hash, timeMs: named.timeMs, depth: named.depth };
}
