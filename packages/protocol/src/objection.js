// AN OBJECTION, AND WHEN A RESULT IS ACTUALLY FINAL. Section 13A.
//
// "After a result is PROVISIONALLY_FINAL, the window W (reference: 10 minutes,
// contract-defined) runs... It becomes FINAL when the window closes without a
// valid objection."
//
// WHO MAY OBJECT IS ANYONE. The spec is explicit and it is the whole point:
// "the affected player, another player in the round, a non-selected node, a
// spectator, a watchtower". Restricting objectors to the committee would
// silence exactly the parties the veto exists for - 13A's collusion bar is
// that five colluding operators must also ensure no honest node, no
// third-party mirror and no watchtower holds the receipted transcript. The set
// comparison lives one level in: the RECEIPTS inside the objection must be
// "CheckpointReceipts from committee nodes".
//
// WHAT A VALID OBJECTION NEEDS, and one part of it is not here: "every
// checkpoint carries genuine receipts, the chain is consistent, and
// deterministic replay under the round's sim_wasm_hash produces
// claimed_result != signed_result". The first two are set and hash work and
// are done here. The third is a REPLAY, this package steps no simulation and
// neither does the daemon, so the verdict is injected - the same shape as
// `verify` for a curve and `equivocationProven` for a fork proof. A caller
// that passes `true` without replaying has overturned a result on its own
// say-so.
//
// AND A VALID OBJECTION DOES NOT VOID ANYTHING. "A valid objection suspends
// finality. The full committee re-runs the canonical transcript; the replay
// outcome is authoritative... If the committee cannot reach 5-of-7 on the
// re-run, 13C applies." So the answer is SUSPENDED, and 13C's FORFEIT-or-VOID
// is what happens only if that re-run fails.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, TYPE_OBJECTION, TAG } from './constants.js';
import { OUTCOMES, outcomeByte, provisionallyFinal } from './result.js';

/** The three answers a result can be sitting in. */
export const PROVISIONALLY_FINAL = 'PROVISIONALLY_FINAL';
export const FINAL = 'FINAL';
export const SUSPENDED = 'SUSPENDED';

export function encodeObjection(o) {
  const w = new Writer();
  w.u8(TYPE_OBJECTION);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(o.roundId);
  w.bytes32(o.playerPubkey);
  w.bytes32(o.transcriptHash);        // what the objector says was played
  w.bytes32(o.signedResultId);        // the result being objected to
  w.u8(outcomeByte(o.claimedOutcome));
  w.u32(o.claimedScore);
  w.bytes32(o.objectorPubkey);        // anyone at all: it names, it does not gate
  w.u64(o.atMs);
  return w.finish();
}

export function decodeObjection(bytes) {
  const rd = new Reader(bytes);
  const type = rd.u8();
  if (type !== TYPE_OBJECTION) throw new Error('not an objection: type ' + type);
  const version = rd.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('unknown protocol version');
  const o = {
    roundId: rd.bytes32(),
    playerPubkey: rd.bytes32(),
    transcriptHash: rd.bytes32(),
    signedResultId: rd.bytes32(),
    claimedOutcome: OUTCOMES[rd.u8()],
    claimedScore: rd.u32(),
    objectorPubkey: rd.bytes32(),
    atMs: rd.u64(),
  };
  if (rd.at !== bytes.length) throw new Error('trailing bytes after the objection');
  if (o.claimedOutcome === undefined) throw new Error('that is not one of the four outcomes');
  return o;
}

export const objectionId = (o) => taggedHash(TAG.objection, encodeObjection(o));

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Is this objection one anybody should act on?
 *
 * `receipts` are the CheckpointReceipts it carries, already decoded and
 * already signature-checked by whoever holds a curve; what is checked here is
 * that they belong to THIS round's committee, which is a set and needs none.
 *
 * `replayDiffers` is the injected verdict of 13A's replay. Absent, the answer
 * is no: an objection nobody has replayed is a claim, and overturning a result
 * on a claim is what the window exists to prevent.
 */
export function objectionHolds({
  objection, receipts, committee, transcriptHash, replayDiffers,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { holds: false, why: 'no committee to check the receipts against' };
  if (!Array.isArray(receipts) || !receipts.length)
    return { holds: false, why: 'an objection carries the receipts that back it, and this carries none' };

  const seats = new Set(committee.map(hex));
  const stranger = receipts.find((r) => !seats.has(hex(r.nodePubkey)));
  if (stranger)
    return {
      holds: false,
      why: `the receipt from ${hex(stranger.nodePubkey)} is not from this round's committee`,
    };

  // The transcript the objection names has to be the one whose receipts these
  // are, or the objection is about some other run of some other round.
  if (transcriptHash !== undefined && hex(transcriptHash) !== hex(objection.transcriptHash))
    return { holds: false, why: 'the receipts are for a different transcript than the objection names' };

  if (replayDiffers !== true)
    return { holds: false, why: 'no replay has contradicted the signed result' };

  return { holds: true, why: 'the receipts are the committee\'s and a replay contradicts the signed result' };
}

/**
 * Where a result stands, now.
 *
 * PROVISIONALLY_FINAL while the window runs, FINAL when it closes with no
 * valid objection, SUSPENDED the moment one holds. The window comes off the
 * ROUND CONTRACT - `objectionWindowMs` - and not from an argument, because a
 * window the caller chooses is a window the operator chooses.
 */
export function finality({
  signedBy, committee, contract, provisionalAtMs, now, objections = [],
}) {
  const agreed = provisionallyFinal(signedBy, { committee });
  if (!agreed.final) return { state: null, why: agreed.why, ...agreed };

  const window = contract && contract.objectionWindowMs;
  if (typeof window !== 'bigint')
    return { state: null, why: 'the round contract does not say how long the objection window is' };

  const held = objections.find((o) => o.holds);
  if (held) {
    return {
      state: SUSPENDED,
      why: 'a valid objection suspends finality: the committee re-runs the canonical '
        + 'transcript, and 13C applies only if that re-run cannot reach five of seven',
      signers: agreed.signers,
    };
  }

  const closesAtMs = BigInt(provisionalAtMs) + window;
  if (BigInt(now) < closesAtMs) {
    return {
      state: PROVISIONALLY_FINAL,
      why: `the objection window closes at ${closesAtMs} and it is ${now}`,
      closesAtMs,
      signers: agreed.signers,
    };
  }

  return {
    state: FINAL,
    why: `the window closed at ${closesAtMs} with no valid objection`,
    closesAtMs,
    signers: agreed.signers,
  };
}
