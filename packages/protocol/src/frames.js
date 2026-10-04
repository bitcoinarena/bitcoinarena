// WHICH FRAMES CARRY AUTHORITY, AND WHICH ONE IS ONLY A PICTURE.
//
// 0.10: "Ghost snapshots are never inputs to this calculation." The core
// enforces the "never an input" half by having no argument one could arrive
// through. This file is the other half: a ghost must not be able to stand in
// for anything that DECIDES something either - a batch that becomes a tick, a
// mark that becomes a receipt, a census leaf that becomes a signer node, an
// advertisement that becomes a bond.
//
// WHY A LIST AND NOT A COMMENT. Measured before this existed: the node's
// dispatch read the first byte, sent checkpoints and receipts to their
// handlers, and passed EVERYTHING ELSE to `round.batch`. A ghost was refused
// there - `decodeInputBatch` checks its own type byte - but by accident of the
// decoder rather than by a rule, and the answer it gave was "not an input
// batch", which says what the frame is not. The frame is a picture, and a door
// that only knows what it is not will let the next non-input through the
// moment somebody adds one.
import {
  TYPE_ROUND_CONTRACT, TYPE_ENTRY_CONTRACT, TYPE_ADVERT, TYPE_CENSUS_LEAF,
  TYPE_CHECKPOINT, TYPE_RESULT, TYPE_PAYOUT_TABLE, TYPE_INPUT_BATCH,
  TYPE_TRANSCRIPT, TYPE_CHECKPOINT_RECEIPT, TYPE_OBJECTION, TYPE_SLASH_PROOF,
  TYPE_SETTLEMENT_RECORD, TYPE_FEE_CLAIM, TYPE_SERVICE_RECORD,
  TYPE_DONATION_SET, TYPE_GHOST, TYPE_VSS_HANDOUT,
  TYPE_DKG_CONTRIBUTION, TYPE_SIGNED_DONATION_SET, TYPE_DONATION_SET_KEYS, TYPE_AUTHORITY_ROTATION,
  TYPE_CLAIM_KEY_ATTESTATION, TYPE_DKG_AGREEMENT, TYPE_TRANSCRIPT_POSTING, TYPE_RERUN_RESULT, TYPE_FINAL_SIGNATURE,
} from './constants.js';

/**
 * Every type this package can be handed, and whether it decides anything.
 *
 * `authority: true` means a frame of this type, accepted, changes what the
 * protocol will do: it becomes a tick, a receipt, a signer node, a bond, a payout, a
 * slash. `authority: false` is a picture.
 *
 * The map is exhaustive on purpose. A type byte missing from it is refused
 * rather than assumed harmless, because the assumption that runs the other way
 * is the one that costs money.
 */
export const FRAMES = new Map([
  [TYPE_ROUND_CONTRACT, { name: 'RoundContract', authority: true }],
  [TYPE_ENTRY_CONTRACT, { name: 'EntryContract', authority: true }],
  [TYPE_ADVERT, { name: 'Advert', authority: true }],
  [TYPE_CENSUS_LEAF, { name: 'CensusLeaf', authority: true }],
  [TYPE_CHECKPOINT, { name: 'Checkpoint', authority: true }],
  [TYPE_RESULT, { name: 'Result', authority: true }],
  [TYPE_PAYOUT_TABLE, { name: 'PayoutTable', authority: true }],
  [TYPE_INPUT_BATCH, { name: 'InputBatch', authority: true }],
  [TYPE_TRANSCRIPT, { name: 'Transcript', authority: true }],
  [TYPE_CHECKPOINT_RECEIPT, { name: 'CheckpointReceipt', authority: true }],
  [TYPE_OBJECTION, { name: 'Objection', authority: true }],
  [TYPE_SLASH_PROOF, { name: 'SlashProof', authority: true }],
  [TYPE_SETTLEMENT_RECORD, { name: 'SettlementRecord', authority: true }],
  [TYPE_FEE_CLAIM, { name: 'FeeClaim', authority: true }],
  [TYPE_SERVICE_RECORD, { name: 'ServiceRecord', authority: true }],
  [TYPE_VSS_HANDOUT, { name: 'VssHandout', authority: true }],
  [TYPE_DONATION_SET, { name: 'DonationSet', authority: true }],
  // THE NINE DECLARED AFTER THE HANDOUT AND NEVER ENTERED HERE (the spec audit of 2026-10-04): each decides something -
  // a settlement key, a donation set, the authority, a claim key, a posted transcript, a re-run, a FINAL - so each is
  // authority. Missing, `bearsAuthority` refused all nine as unknown.
  [TYPE_DKG_CONTRIBUTION, { name: 'DkgContribution', authority: true }],
  [TYPE_SIGNED_DONATION_SET, { name: 'SignedDonationSet', authority: true }],
  [TYPE_AUTHORITY_ROTATION, { name: 'AuthorityRotation', authority: true }],
  [TYPE_CLAIM_KEY_ATTESTATION, { name: 'ClaimKeyAttestation', authority: true }],
  [TYPE_DKG_AGREEMENT, { name: 'DkgAgreement', authority: true }],
  [TYPE_TRANSCRIPT_POSTING, { name: 'TranscriptPosting', authority: true }],
  [TYPE_RERUN_RESULT, { name: 'RerunResult', authority: true }],
  [TYPE_FINAL_SIGNATURE, { name: 'FinalSignature', authority: true }],
  [TYPE_DONATION_SET_KEYS, { name: 'DonationSetKeys', authority: true }],

  // THE ONLY ONE. 0.9's ghost: something to look at, and nothing else.
  [TYPE_GHOST, { name: 'Ghost', authority: false }],
]);

export const frameOf = (bytes) =>
  (bytes && bytes.length ? FRAMES.get(bytes[0]) : undefined);

/**
 * May this frame stand as the thing the caller is about to use it for?
 *
 * `as` is what the door wants - 'an input', 'a receipt', 'a census entry' -
 * and it is repeated back in the refusal, because "refused" without the role
 * makes a caller guess which of its doors said no.
 */
export function bearsAuthority(bytes, as) {
  const frame = frameOf(bytes);
  if (!frame)
    return {
      ok: false,
      why: bytes && bytes.length
        ? `no frame of this protocol begins with 0x${bytes[0].toString(16).padStart(2, '0')}`
        : 'an empty frame is not a message',
    };
  if (!frame.authority)
    return {
      ok: false,
      name: frame.name,
      why: `a ${frame.name} is a picture and carries no authority, so it cannot be ${as}`,
    };
  return { ok: true, name: frame.name };
}

/**
 * WHAT GOES FIRST WHEN A QUEUE IS FULL.
 *
 * Section 7 of IMPLEMENTATION: "above a threshold drop GHOST frames first -
 * they are non-authoritative by definition - and never receipts."
 *
 * The order is not a tuning knob. Dropping an input costs the player their
 * run: §11 says "publishing is the client's duty, and unpublished inputs cost
 * the player the run", and a node that discarded a batch to make room for a
 * picture would be taking that run away over rendering. Dropping a receipt is
 * worse still - it is the evidence a mark was seen.
 *
 * So: pictures go, and nothing else does. There is no second tier, because
 * every other frame in `FRAMES` decides something.
 */
export const DROPPABLE = 'a picture, dropped before anything that decides something';

export function droppable(bytes) {
  const frame = frameOf(bytes);
  return frame !== undefined && frame.authority === false;
}

/**
 * A bounded inbound queue that sheds pictures rather than evidence.
 *
 * Returns `{ queue, dropped }`. `dropped` is what did not make it, in the
 * order it was shed, so a caller can print the decision rather than infer it.
 *
 * WHEN THERE IS NOTHING LEFT TO SHED, THE NEW FRAME IS REFUSED rather than an
 * older authority-bearing one being discarded. A queue that made room by
 * throwing away a batch it had already accepted would lose a run to relieve
 * pressure; refusing the newcomer at least leaves the sender able to publish it
 * again, which §11 makes their duty anyway.
 */
export function admit(queue, frame, limit) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('a bounded queue has a positive limit');

  const out = [...queue];
  const dropped = [];
  out.push(frame);

  while (out.length > limit) {
    const at = out.findIndex(droppable);
    if (at < 0) {
      // nothing in here is a picture: the newcomer does not displace evidence
      dropped.push(out.pop());
      break;
    }
    dropped.push(out.splice(at, 1)[0]);
  }

  return { queue: out, dropped };
}
