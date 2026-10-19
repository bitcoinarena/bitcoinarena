// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GHOST: A PICTURE OF ANOTHER PLAYER'S TRUCK, WHICH IS NEVER AN INPUT.
//
// 0.9: "Other trucks are visible ghosts with no collision. Another player must
// not be able to change my financial odds by ramming me, blocking a road,
// pushing me, damaging me, drawing my enemies away, pulling enemies toward me,
// sacrificing themselves for me, or colluding physically."
//
// 0.10 states the shape of the guarantee rather than a promise about it:
//
//     financial_world(p) = deterministic_sim(RoundContract, map, player_seed,
//                                            player_inputs)
//     Ghost snapshots are never inputs to this calculation.
//
// THE GUARANTEE IS THE MISSING PARAMETER, and it is already there: the core's
// `step(st, throttle, steer, brake, handbrake, practice)` has no argument a
// ghost could arrive through, and the state holds one truck at one `O_TRUCK`
// offset. Nothing in this file is a way in - it encodes a picture and says
// whether the picture is one somebody actually drove.
//
// A GHOST IS A PICTURE FROM A TRANSCRIPT, NOT A POSITION A NODE ANNOUNCES.
// Without that, a node fans out whatever coordinates it likes: a competitor
// painted somewhere they never were, or one who never entered at all. That is
// the same fault a payout table had before `payoutInputsId` and a census had
// before `censusInputsId` - the thing being asserted has to be bound to the
// inputs it came from. Here the binding already exists on the wire: §11's
// input chain. A ghost names the head of the chain it was taken from, exactly
// as a checkpoint does, so anyone holding that transcript can say whether the
// picture belongs to it.
import { Writer, Reader } from './encode.js';
import { taggedHash, toHex } from './hash.js';
import { TAG, PROTOCOL_VERSION, speaksVersion, TYPE_GHOST } from './constants.js';
import { batchId, batchTicks } from './batch.js';
import { GENESIS } from './transcript.js';
import { entryId } from './contracts.js';

/**
 * One picture: whose, when, from where in their chain, and where the truck was.
 *
 * THREE WORDS OF TRUCK AND NO MORE. `T_X`, `T_Z` and `T_HEADING` are what
 * draws a truck on a map; the core's other nine truck words - hp, cargo,
 * flags, wheel, throttle, steer, velocities, impact - are not carried, because
 * each one would be a claim about somebody's run that this frame cannot prove
 * and that nothing needs in order to render a ghost. 0.9 allows watching
 * competitors "drive, struggle, fail and arrive"; arriving and failing are the
 * leaderboard's to say, from signed results, not a 5 Hz picture's.
 *
 * The words are Q16.16, the units the core keeps, unscaled at this boundary
 * for the reason `encodeInputBatch` gives: a rounding rule applied here is a
 * rounding rule two implementations could differ on.
 */
export function encodeGhost(g) {
  const w = new Writer();
  w.u8(TYPE_GHOST);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(g.roundId);
  w.bytes32(g.entryId);

  // WHOSE TRUCK, named rather than looked up. The entry id identifies the run,
  // but a renderer holding one frame would have to hold every Entry Contract
  // to say who is driving. It is carried AND checked: `ghostBinds` refuses a
  // frame whose key is not the one that entry was signed for, so it is not a
  // label anybody can write - and when no entry is offered it is reported as
  // unchecked rather than believed.
  w.bytes32(g.playerPubkey);

  w.u32(g.tick);

  // WHERE IN THEIR INPUT CHAIN THIS WAS TAKEN. The head, the same value a
  // checkpoint commits to, and the whole reason a ghost cannot be invented.
  w.bytes32(g.inputChainHash);

  w.i32(g.x);
  w.i32(g.z);
  w.i32(g.heading);
  return w.finish();
}

export function decodeGhost(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_GHOST) throw new Error('not a ghost');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const g = {
    roundId: r.bytes32(),
    entryId: r.bytes32(),
    playerPubkey: r.bytes32(),
    tick: r.u32(),
    inputChainHash: r.bytes32(),
    x: r.i32(),
    z: r.i32(),
    heading: r.i32(),
  };
  r.end();
  return g;
}

export const ghostId = (g) => taggedHash(TAG.ghost, encodeGhost(g));

/** Fixed: nothing here is variable-length, so a reader can cut at a stride. */
export const GHOST_BYTES = 1 + 2 + 32 + 32 + 32 + 4 + 32 + 4 + 4 + 4;

/**
 * IS THIS A PICTURE OF A RUN THAT HAPPENED?
 *
 * Answered against the transcript and nothing else - the same discipline
 * `censusRootMatchesRound` needed for its entries: whoever shows the picture
 * does not get to choose what it is checked against.
 *
 * Three things have to hold, and none of them is about the coordinates. This
 * cannot say the truck was AT x,z - only a replay says that, and a replay is
 * the objection path's job (§13A), not a 5 Hz frame's. What it can say is that
 * the frame belongs to a run somebody published inputs for:
 *
 *   - the round and the entry are this transcript's
 *   - the head it names is one this transcript actually reaches, which is
 *     §11's "a transcript whose inputs were never published cannot be
 *     replayed" applied to a picture instead of a mark
 *   - the tick is one those inputs cover
 *
 * GENESIS IS NOT A HEAD A PICTURE CAN COME FROM. It is the head before any
 * input went out, so a ghost on it is a picture of a truck that has not been
 * driven yet - which is exactly the frame a node would fabricate for a
 * competitor who never entered.
 */
export function ghostBinds(ghost, transcript, entry) {
  if (!ghost || !(ghost.inputChainHash instanceof Uint8Array))
    return { ok: false, why: 'that ghost names no input chain head' };
  if (!transcript || !Array.isArray(transcript.batches))
    return { ok: false, why: 'no transcript to check that ghost against' };

  const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
    && a.length === b.length && a.every((v, i) => v === b[i]);

  if (!same(ghost.roundId, transcript.roundId))
    return { ok: false, why: 'that ghost is for another round' };
  if (!same(ghost.entryId, transcript.entryId))
    return { ok: false, why: 'that ghost is for another entry' };

  // AND IF AN ENTRY IS OFFERED, THE KEY IS THAT ENTRY'S. Not optional in the
  // sense of nice-to-have: a caller that has the entry gets the check, and a
  // caller that does not is told the key was not checked rather than left to
  // assume it was.
  const unchecked = [];
  if (entry) {
    if (!same(entryId(entry), ghost.entryId))
      return { ok: false, why: 'that is a different entry than the ghost names' };
    if (!same(entry.playerPubkey, ghost.playerPubkey))
      return { ok: false, why: 'that ghost names a key that entry was not signed for' };
  } else {
    unchecked.push('the player key (no entry contract offered to check it against)');
  }

  if (same(ghost.inputChainHash, GENESIS))
    return {
      ok: false,
      why: 'that ghost is taken before any input went out, so there is nothing '
        + 'it could be a picture of',
    };

  // Walk the chain the way `checkTranscript` does, and stop at the head the
  // ghost names. What that head covers is every tick up to the last one of the
  // batch that produced it.
  let previous = GENESIS;
  let firstTick = null;
  for (const b of transcript.batches) {
    if (!same(b.previousHash, previous))
      return { ok: false, why: 'that transcript\'s input chain is broken' };
    const at = batchTicks(b);
    if (firstTick === null && at.length) firstTick = at[0];
    previous = batchId(b);

    if (same(previous, ghost.inputChainHash)) {
      if (!at.length)
        return { ok: false, why: 'that head carries no ticks to be a picture of' };
      if (ghost.tick < firstTick || ghost.tick > at[at.length - 1])
        return {
          ok: false,
          why: `that ghost is at tick ${ghost.tick}, and the inputs it names `
            + `cover ${firstTick} to ${at[at.length - 1]}`,
        };
      return { ok: true, throughTick: at[at.length - 1], unchecked };
    }
  }

  return {
    ok: false,
    why: `no batch of that transcript hashes to ${toHex(ghost.inputChainHash).slice(0, 16)}, `
      + 'so that picture was taken from inputs nobody published',
  };
}
