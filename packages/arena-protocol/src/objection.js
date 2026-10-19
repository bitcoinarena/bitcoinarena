// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { PROTOCOL_VERSION, speaksVersion, TYPE_OBJECTION, TAG, OBJECTION_WINDOW_MS } from './constants.js';
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
  if (!speaksVersion(version)) throw new Error('unknown protocol version');
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

/**
 * THE OBJECTION AS IT TRAVELS (§13ARULED 2026-10-04): "a portable artifact consisting of round_id,
 * player_pubkey, transcript (inputs + checkpoints), receipts[], claimed_result, objector_signature". Until this, the
 * door took no body: an objection was only "one arrived", and it held only where the seat's own replay already
 * disagreed, so a player holding a receipted transcript could not overturn seats that agreed on a lie.
 *
 * The bundle is four parts (a fifth, the run's inputs, when the transcript carries none - see decodeObjectionBundle), each length-prefixed: the Objection above; the objector's signature over its id (64 bytes,
 * BIP-340 under `objectorPubkey`); the transcript bytes as a node hands the canonical one out (GET /canonical:
 * `encodeTranscript`, the batches AND the signed marks - the object a result's transcript_hash names); and the signed
 * receipts back to back, as GET /receipts hands them out. The curve is not this package's: the bundle is cut here and
 * checked by a caller that has one (arena-node objection-check.js).
 */
export const OBJECTION_SIGNATURE_BYTES = 64;

export function encodeObjectionBundle({ objection, signature, transcript, receipts, inputs = null }) {
  const o = objection instanceof Uint8Array ? objection : encodeObjection(objection);
  if (!(signature instanceof Uint8Array) || signature.length !== OBJECTION_SIGNATURE_BYTES)
    throw new Error(`an objection's signature is ${OBJECTION_SIGNATURE_BYTES} bytes`);
  if (!(transcript instanceof Uint8Array) || !(receipts instanceof Uint8Array))
    throw new Error('an objection carries its transcript and its receipts as bytes');
  if (inputs !== null && !(inputs instanceof Uint8Array)) throw new Error('an objection\'s inputs travel as bytes');
  const w = new Writer();
  for (const part of [o, signature, transcript, receipts, ...(inputs ? [inputs] : [])]) { w.u32(part.length); w.bytes(part, part.length); }
  return w.finish();
}

export function decodeObjectionBundle(bytes) {
  const rd = new Reader(bytes);
  const part = () => rd.bytes(rd.u32());
  const objectionBytes = part();
  const signature = part();
  const transcript = part();
  const receipts = part();
  // THE RUN'S INPUTS, a fifth part when the transcript carries none (measured live 2026-10-04: the live
  // client sends its ticks as play frames, so a live run's canonical transcript is its receipted marks over no batches,
  // and its inputs are what GET /replay/transcript hands out - JSON, absolute ticks). Checked against the marks' state
  // hashes by the replay; never trusted on their own.
  const inputs = rd.at < bytes.length ? part() : null;
  if (rd.at !== bytes.length) throw new Error('trailing bytes after the objection bundle');
  if (signature.length !== OBJECTION_SIGNATURE_BYTES)
    throw new Error(`an objection's signature is ${OBJECTION_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  return { objection: decodeObjection(objectionBytes), objectionBytes, signature, transcript, receipts, inputs };
}

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
  roundId, signedResultId,
}) {
  if (!Array.isArray(committee) || !committee.length)
    return { holds: false, why: 'no committee to check the receipts against' };

  // AN OBJECTION IS ABOUT ONE RESULT OF ONE ROUND, and until this was checked
  // it was about none: an objection naming another round entirely held, and
  // suspended this one. Measured. The receipts were the committee's and the
  // replay differed, so every check that existed passed - they were simply
  // checks about a different round.
  //
  // Required, not optional: a caller that does not say which result is being
  // objected to cannot be told whether this objection is about it.
  if (!(roundId instanceof Uint8Array) || !(signedResultId instanceof Uint8Array))
    return { holds: false, why: 'no round and result to check this objection against' };
  if (hex(objection.roundId) !== hex(roundId))
    return { holds: false, why: `that objection is about round ${hex(objection.roundId)}, not this one` };
  if (hex(objection.signedResultId) !== hex(signedResultId))
    return {
      holds: false,
      why: `that objection is about result ${hex(objection.signedResultId)}, `
        + 'and this is a different one',
    };
  if (!Array.isArray(receipts) || !receipts.length)
    return { holds: false, why: 'an objection carries the receipts that back it, and this carries none' };

  const signerNodes = new Set(committee.map(hex));
  const stranger = receipts.find((r) => !signerNodes.has(hex(r.nodePubkey)));
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

  return {
    holds: true,
    atMs: objection.atMs,
    why: 'the receipts are the committee\'s and a replay contradicts the signed result',
  };
}

/**
 * Where a result stands, now.
 *
 * PROVISIONALLY_FINAL while the window runs, FINAL when it closes with no
 * valid objection, SUSPENDED the moment one holds. The window comes off the
 * ROUND CONTRACT - `objectionWindowMs` - and not from an argument, because a
 * window the caller chooses is a window the operator chooses.
 *
 * `needed` is the committee's threshold and is passed on to
 * `provisionallyFinal` as it is: a two-signer node round is agreed at 2 of 2, not at
 * the default five (M3.3-26's rule, `receiptsNeeded`).
 */
export function finality({
  signedBy, committee, contract, provisionalAtMs, publishedAtMs, now, objections = [], needed,
}) {
  const agreed = provisionallyFinal(signedBy, needed === undefined ? { committee } : { committee, needed });
  if (!agreed.final) return { state: null, why: agreed.why, ...agreed };

  const window = contract && contract.objectionWindowMs;
  if (typeof window !== 'bigint')
    return { state: null, why: 'the round contract does not say how long the objection window is' };
  // EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED 2026-10-01): any other number is an invalid contract.
  if (window !== OBJECTION_WINDOW_MS)
    return { state: null, why: `the round contract's objection window is ${window} ms, not ${OBJECTION_WINDOW_MS}: an invalid contract` };

  // THE WINDOW IS WORKED OUT FIRST, and that ordering is the rule rather than
  // tidiness. This used to look for a holding objection before it looked at
  // the clock, so an objection dated long after the close suspended a result
  // that was already FINAL - measured at 999999 ms past it. Section 13A opens
  // the window AFTER PROVISIONALLY_FINAL, and section 14 is blunt about the
  // other end: "once a player's result is FINAL, later infrastructure failure
  // does not erase it". Anyone able to produce one valid objection could
  // otherwise un-finalise a settled round at any time.
  // PUBLICATION IS A CONDITION OF FINALITY (v4.6.2, P2): the window W counts
  // from the moment the round's threshold of settlement signer nodes had posted the
  // transcript, not from the fifth signature, and a result nobody has posted is
  // never FINAL. `null` says "not posted"; a caller that tracks no posting at
  // all leaves it out, and the window runs from the threshold as it did.
  if (publishedAtMs === null)
    return {
      state: PROVISIONALLY_FINAL, published: false, signers: agreed.signers,
      why: 'the transcript has not been posted to the round\'s publication relays by its '
        + 'threshold of settlement signer nodes, so the objection window has not opened',
    };
  const opensAtMs = publishedAtMs === undefined || BigInt(publishedAtMs) < BigInt(provisionalAtMs)
    ? BigInt(provisionalAtMs) : BigInt(publishedAtMs);
  const closesAtMs = opensAtMs + window;
  const open = BigInt(now) < closesAtMs;

  // AND AN OBJECTION COUNTS ONLY IF IT AROSE WHILE THE WINDOW WAS OPEN. Its
  // own timestamp, not the moment somebody chose to present it.
  const inTime = objections.filter((o) => o.holds
    && o.atMs !== undefined
    && BigInt(o.atMs) >= BigInt(provisionalAtMs)
    && BigInt(o.atMs) < closesAtMs);
  const late = objections.filter((o) => o.holds && !inTime.includes(o));

  if (inTime.length) {
    return {
      state: SUSPENDED,
      why: 'a valid objection suspends finality: the committee re-runs the canonical '
        + 'transcript, and 13C applies only if that re-run cannot reach five of seven',
      closesAtMs,
      signers: agreed.signers,
    };
  }

  if (open) {
    return {
      state: PROVISIONALLY_FINAL,
      why: `the objection window closes at ${closesAtMs} and it is ${now}`,
      closesAtMs,
      signers: agreed.signers,
    };
  }

  return {
    state: FINAL,
    why: late.length
      ? `the window closed at ${closesAtMs}; ${late.length} objection(s) came too late to reopen it`
      : `the window closed at ${closesAtMs} with no valid objection`,
    closesAtMs,
    late: late.length,
    signers: agreed.signers,
  };
}
