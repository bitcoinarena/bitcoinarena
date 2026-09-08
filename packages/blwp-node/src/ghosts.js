// A PICTURE OF SOMEBODY ELSE'S TRUCK, BUILT FROM WHAT THEY PUBLISHED.
//
// 0.9 lets a player watch competitors "drive, struggle, fail and arrive", and
// 0.10 says what that must not become: another player's truck is a PICTURE,
// never an input to my simulation. The frame itself was already in
// `protocol/src/ghost.js` and nothing produced one - so the question this file
// answers is the one that decides whether ghosts are honest at all: where do
// the three numbers come from?
//
// They come from the run the other player published, replayed through
// `replay.js`, which is the daemon's only door to the simulator. Not from a
// position a node announces, not from a second stepping loop here, and not
// from a renderer: a node that made up coordinates would be painting a
// competitor somewhere they never were, which is the same fault a payout table
// had before `payoutInputsId`.
//
// NOTHING IN THIS FILE TOUCHES THE CORE. It asks `replay` for a picture and
// builds a frame around it, so the guard that counts the files reaching the
// simulator still counts one.
import { encodeGhost, ghostBinds } from '../../protocol/src/ghost.js';
import { batchId, batchTicks } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { replay } from './replay.js';

const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * THE HEAD THAT COVERS A TICK, walked rather than assumed.
 *
 * `ghostBinds` accepts a head whose batch reaches the tick, so the honest
 * choice is the FIRST such head: the picture is taken from the inputs that
 * produced it and not from a later batch that happens to contain it too. A
 * chain that does not link is refused here rather than producing a frame
 * nobody could check.
 */
function headCovering(batches, tick) {
  let previous = GENESIS;
  let first = null;
  for (const b of batches) {
    if (!same(b.previousHash, previous))
      return { ok: false, why: 'that transcript\'s input chain is broken' };
    const at = batchTicks(b);
    if (first === null && at.length) first = at[0];
    previous = batchId(b);
    if (at.length && tick >= first && tick <= at[at.length - 1])
      return { ok: true, head: previous, firstTick: first, throughTick: at[at.length - 1] };
  }
  return {
    ok: false,
    why: first === null
      ? 'that entry has published no inputs, so there is nothing to be a picture of'
      : `tick ${tick} is not one the published inputs cover`,
  };
}

/**
 * ONE GHOST FRAME for one entry at one tick, or the reason there is none.
 *
 * `batches` are that entry's signed input batches in chain order - what the
 * node stored on the way in - and `transcript` is the same run as ticks and
 * words, which is what a replay eats. Both are the node's own tables; neither
 * is anything the asking side gets to choose.
 */
export function ghostFor({
  transcript, entry, batches, roundId, entryId, tick, seedWord, roundRandomness,
}) {
  if (!Number.isInteger(tick) || tick < 0)
    return { ok: false, why: 'a ghost is at a whole tick' };
  if (!entry || !(entry.playerPubkey instanceof Uint8Array))
    return { ok: false, why: 'no entry contract to say whose truck that is' };
  if (!Array.isArray(batches) || !batches.length)
    return { ok: false, why: 'that entry has published no inputs, so there is nothing to be a picture of' };

  // WHERE IN THEIR CHAIN, first. A tick nobody published inputs for cannot be
  // photographed, and finding that out before the replay is the difference
  // between a refusal and a minute of simulation ending in one.
  const chain = headCovering(batches, tick);
  if (!chain.ok) return chain;

  // GENESIS IS NOT A HEAD A PICTURE COMES FROM - it is the head before any
  // input went out. `ghostBinds` refuses one; this refuses to build one, so
  // the two ends agree instead of one of them cleaning up after the other.
  if (same(chain.head, GENESIS))
    return { ok: false, why: 'that head is before any input went out' };

  const run = replay(transcript, entry, { seedWord, roundRandomness, pictures: [tick] });
  if (!run.ok) return { ok: false, why: run.why };

  const shot = run.pictures.find((p) => p.tick === tick);
  if (!shot)
    return { ok: false, why: `that run never reached tick ${tick}, so there is no picture of it` };

  const ghost = {
    roundId, entryId,
    playerPubkey: entry.playerPubkey,
    tick,
    inputChainHash: chain.head,
    x: shot.x, z: shot.z, heading: shot.heading,
  };
  return { ok: true, ghost, bytes: encodeGhost(ghost), throughTick: chain.throughTick };
}

/**
 * THE SAME FRAME, CHECKED THE WAY A STRANGER WOULD CHECK IT.
 *
 * A producer that could not be checked by its own consumer is a producer
 * nobody should trust, so this runs `ghostBinds` over what it just built. It
 * is not belt and braces: it is the only thing that would notice this file and
 * `ghost.js` drifting apart on what a tick means.
 */
export function ghostForChecked(options) {
  const made = ghostFor(options);
  if (!made.ok) return made;
  const bound = ghostBinds(made.ghost, {
    roundId: options.roundId, entryId: options.entryId, batches: options.batches,
  }, options.entry);
  if (!bound.ok) return { ok: false, why: `that picture does not bind: ${bound.why}` };
  return { ...made, unchecked: bound.unchecked };
}
