// FIVE SEATS, AND ONLY FIVE SEATS, CAN OPEN A STAKE.
//
// 23.4: "Settling a loser's HTLC requires reconstructing the preimage from at
// least 5 preimage shares." Everything that sentence needs existed before this
// file and none of it ran: `reconstruct` and `openStake` had zero callers, and
// the one thing that ever produced 32 bytes for a settle handed them over
// directly. This is what asks.
//
// WHY IT IS A DOOR AND NOT A TABLE LOOKUP. Each seat holds ONE share, sealed
// to its own key, and never writes the opened value down. So reconstruction is
// a conversation: a seat opens its own, asks the others, and stops the moment
// it has five. A node that could do it alone would be the custody this letter
// exists to end.
//
// TWO CONDITIONS ON ANSWERING, AND THEY ARE THE WHOLE SAFETY OF IT:
//
//   the asker is a seat   `round.seats` is the census's list, not the
//                         contract's, so a stranger cannot make itself one by
//                         asking
//   the run settles       FINAL, and an outcome 23.2 settles. A DELIVERED run
//                         is CANCELLED - its preimage must never be released,
//                         because releasing it lets anyone settle the invoice
//                         and take the player's stake
//
// AND THE ANSWER IS SEALED TO THE ASKER, with a fresh one-time key, exactly as
// the handout was. The two checks together are what makes this sound without a
// signature: claiming another seat's key gets you an envelope only that seat
// can open, and not claiming one gets you refused.
import { reconstruct, SHARES_NEEDED } from '../../protocol/src/shares.js';
import { openMyShare, decodeHandout } from '../../protocol/src/handout.js';
import { sealShare, openShare } from '../../protocol/src/seal.js';

import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { settlementAction, SETTLE, isQualifier } from '../../protocol/src/payout.js';
import { resultFinality } from './finality.js';
import { FINAL } from '../../protocol/src/objection.js';
import { decodeRoundContract, decodeEntryContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

/** seat u16, the answering node's one-time key, and the share sealed to the asker. */
export const SEALED_ANSWER_BYTES = 2 + 32 + 48;

export const encodeShareAnswer = ({ seat, ephemeralPubkey, sealed }) => {
  const out = new Uint8Array(SEALED_ANSWER_BYTES);
  out[0] = (seat >> 8) & 0xff;
  out[1] = seat & 0xff;
  out.set(ephemeralPubkey, 2);
  out.set(sealed, 34);
  return out;
};

export function decodeShareAnswer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SEALED_ANSWER_BYTES)
    throw new Error(`a sealed share answer is ${SEALED_ANSWER_BYTES} bytes`);
  return {
    seat: (bytes[0] << 8) | bytes[1],
    ephemeralPubkey: bytes.subarray(2, 34),
    sealed: bytes.subarray(34),
  };
}

export class Preimages {
  constructor(round, { curve, peers = [], fetcher = fetch, random, peersFor = null } = {}) {
    this.round = round;
    this.curve = curve;
    this.peers = peers;
    // THE ROUND'S OWN SETTLEMENT SEATS, when the operator named none - the
    // census's addresses, as the receipt pull reads them. Measured before: the
    // loser's settle said "1 of 5 shares" with no peer in the reason, because
    // the real launchers pass no `peers` and this asked nobody.
    this.peersFor = peersFor;
    this.fetch = fetcher;
    this.random = random;
  }

  /** Who to ask for a share of one round's stake: a given list, else the census's. */
  peersOf(roundIdBytes) {
    if (this.peers && this.peers.length) return this.peers;
    if (typeof this.peersFor !== 'function') return [];
    try { return this.peersFor(roundIdBytes) || []; } catch { return []; }
  }

  /** The handout an entry names, decoded, or a refusal that says which is missing. */
  handoutOf(entryIdBytes) {
    const stored = this.round.entry(entryIdBytes);
    if (!stored) return { ok: false, why: 'this node seated no such entry' };
    const entry = decodeEntryContract(stored);
    if (!entry.vssSharesRef || entry.vssSharesRef.every((b) => b === 0))
      return { ok: false, why: 'that entry published no shares, so there is nothing to reconstruct' };
    const held = this.round.handout(entry.vssSharesRef);
    if (!held) return { ok: false, why: 'this node accepted no handout for that entry' };
    return { ok: true, entry, handout: decodeHandout(held.bytes) };
  }

  /**
   * THIS NODE'S OWN SHARE, re-opened from the sealed handout every time.
   *
   * It is never stored opened, so a stolen database is a pile of envelopes -
   * and there is no cache to go stale, because the envelope is the truth.
   */
  async mine(entryIdBytes) {
    const found = this.handoutOf(entryIdBytes);
    if (!found.ok) return found;
    return openMyShare(found.handout, {
      pubkey: this.round.pubkey, secret: this.round.identity.secret, curve: this.curve,
    });
  }

  /**
   * MAY THIS NODE HAND ITS SHARE TO A SEAT? 23.4's conditions, and no others.
   *
   * The outcome is the CORE'S, read off the result this node signed, and what
   * it means is `payout.js`'s table rather than a comparison written here.
   */
  mayRelease(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const held = this.round.results(roundIdBytes, entryIdBytes);
    // A NO-QUORUM FORFEIT (§13C; M3.3-34, ruled 2026-09-13, path 3): no run was
    // carried, so there is no result to read - this seat's own no-quorum record,
    // written only after the result window with the player's equivocation
    // proven, says FORFEIT, and a FORFEIT settles its hold into the pool (23.2).
    // Measured before: "this node has replayed nothing for that run" at both
    // seats, so the hold could never settle and expired to the player.
    const nq = !held.length && typeof this.round.noQuorum === 'function' ? this.round.noQuorum(entryIdBytes) : null;
    if (nq && nq.outcome === 'FORFEIT') return { ok: true, outcome: 'FORFEIT', noQuorum: true };
    // AND ON A PROOF THIS SEAT HOLDS ITSELF (M3.3-34, a seat that stays down):
    // two different first marks signed by the entry's own session key - §13B's
    // portable proof, which forfeits with no quorum, no replay and no window.
    // Released while the seats are up, so a seat that goes down later cannot
    // hand the stake back by staying down. Measured before: A held the proof,
    // B went down, "1 of 2 shares" - the hold stayed in flight to expire back.
    if (!held.length && typeof this.round.provenTwoFirstMarks === 'function'
      && this.round.provenTwoFirstMarks(roundIdBytes, entryIdBytes)) return { ok: true, outcome: 'FORFEIT', proven: true };
    if (!held.length) return { ok: false, why: 'this node has replayed nothing for that run' };

    // FINAL, NOT MERELY AGREED (M3.3-32): the threshold makes a run
    // PROVISIONALLY_FINAL, and a share handed out inside the objection window
    // settles a stake an objection could still have kept - measured, a seven
    // seat run gave its share up before its window closed.
    const standing = resultFinality(this.round, roundIdBytes, entryIdBytes);
    if (standing.state !== FINAL)
      return { ok: false, state: standing.state,
        why: `no share is handed out before the result is final: ${standing.why}`
          + `${standing.objection ? `; the objection filed against it: ${standing.objection}` : ''}` };

    // THIS NODE'S OWN RESULT, not whichever arrived first. A peer's record is
    // a peer's claim; what this node is willing to act on is what it replayed.
    const mine = held.find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
    if (!mine) return { ok: false, why: 'this node signed no result for that run, so it releases nothing' };
    const result = decodePlayerResult(splitSignedResult(mine.bytes).body);
    // A QUALIFIER IS DELIVERED AND AT THE SCORE (§18), the payout table's own
    // rule - not the word Delivered alone. A Delivered run below it still
    // cancels its hold (`settlementAction`): its stake was never at risk.
    const said = settlementAction({
      outcome: result.outcome, qualifies: isQualifier(result, decodeRoundContract(new Uint8Array(row.contract)).minScore),
      state: 'FINAL', shares: SHARES_NEEDED, signatures: SHARES_NEEDED,
    });
    if (said.action !== SETTLE)
      return {
        ok: false,
        why: `that run is ${result.outcome}, which ${said.action}s the hold: releasing its preimage `
          + 'would let anyone settle an invoice that has to go back to its player',
      };
    return { ok: true, outcome: result.outcome };
  }

  /**
   * ANSWER ONE SEAT, sealed to that seat.
   *
   * A fresh one-time key per answer, so two askers never share a secret and
   * the same share handed to two seats is two different envelopes.
   */
  async answer({ roundId, entryId, asker }) {
    if (!(asker instanceof Uint8Array) || asker.length !== 32)
      return { ok: false, why: 'a share is asked for by a seat, and that is not a key' };
    const seats = this.round.seats(roundId).map(toHex);
    if (!seats.includes(toHex(asker)))
      return { ok: false, why: 'that key is not a seat of this round, and a share is not a public thing' };

    const may = this.mayRelease(roundId, entryId);
    if (!may.ok) return may;

    const mine = await this.mine(entryId);
    if (!mine.ok) return mine;

    const ephemeralSecret = this.random(32);
    const sealed = await sealShare({
      value: mine.share.value, seat: mine.share.seat, seatPubkey: asker,
      ephemeralSecret, curve: this.curve,
    });
    return {
      ok: true,
      answer: { seat: mine.share.seat, ephemeralPubkey: this.curve.pointX(ephemeralSecret), sealed },
    };
  }

  /**
   * THE 32 BYTES, OR A REFUSAL THAT SAYS HOW MANY SHORT IT WAS.
   *
   * Own share first, then the peers, and it STOPS at the threshold: asking a
   * sixth seat for a secret five already reconstructed is spreading it for
   * nothing.
   */
  async open({ roundId, entryId, needed = SHARES_NEEDED }) {
    const found = this.handoutOf(entryId);
    if (!found.ok) return found;

    const bySeat = new Map();
    const mine = await this.mine(entryId);
    if (mine.ok) bySeat.set(mine.share.seat, mine.share);

    // THE ENVELOPES OTHER SEATS SEALED TO THIS ONE, KEPT (M3.3-34): opened here
    // as they are opened from a peer, so a seat that released its share and then
    // went down cannot hand the stake back by staying down.
    const kept = typeof this.round.heldShares === 'function' ? this.round.heldShares(entryId) : [];
    for (const raw of kept) {
      if (bySeat.size >= needed) break;
      try {
        const back = decodeShareAnswer(raw);
        if (bySeat.has(back.seat)) continue;
        const opened = await openShare({
          sealed: back.sealed, seat: back.seat, secret: this.round.identity.secret,
          ephemeralPubkey: back.ephemeralPubkey, curve: this.curve,
        });
        if (opened.ok) bySeat.set(back.seat, { seat: back.seat, value: opened.share.value });
      } catch { /* not an envelope this seat can open */ }
    }

    let refused = 0;
    const why = [];
    for (const peer of this.peersOf(roundId)) {
      if (bySeat.size >= needed) break;
      try {
        const url = `${peer}/share?round=${toHex(roundId)}&entry=${toHex(entryId)}`
          + `&seat=${toHex(this.round.pubkey)}`;
        const got = await this.fetch(url);
        if (!got.ok) { refused++; why.push(`${peer}: ${await got.text()}`); continue; }
        const raw = new Uint8Array(await got.arrayBuffer());
        const back = decodeShareAnswer(raw);
        const opened = await openShare({
          sealed: back.sealed, seat: back.seat, secret: this.round.identity.secret,
          ephemeralPubkey: back.ephemeralPubkey, curve: this.curve,
        });
        if (!opened.ok) { refused++; why.push(`${peer}: ${opened.why}`); continue; }
        bySeat.set(back.seat, { seat: back.seat, value: opened.share.value });
        if (typeof this.round.putHeldShare === 'function') this.round.putHeldShare({ entryId, seat: back.seat, bytes: raw });
      } catch (e) { refused++; why.push(`${peer}: ${e.message}`); }
    }

    if (bySeat.size < needed)
      return {
        ok: false, held: bySeat.size, refused,
        why: `${bySeat.size} of ${needed} shares: a stake nobody can open stays in flight`
          + (why.length ? ` (${why.join('; ')})` : ''),
      };

    // AND IT HAS TO BE THE PREIMAGE THE ENTRY NAMES. A dealer who committed to
    // one secret and hashed another is caught HERE - five seats open it, the
    // hash does not match, and nothing settles. The hold expires and the
    // player is refunded, so the cheat gains nothing and needs no proof system.
    let preimage;
    try {
      preimage = reconstruct([...bySeat.values()].slice(0, needed),
        { needed, stakeCommitment: found.entry.stakeCommitment });
    } catch (e) {
      return { ok: false, held: bySeat.size, why: `those shares do not open that stake: ${e.message}` };
    }
    return { ok: true, preimage, held: bySeat.size, seats: [...bySeat.keys()] };
  }
}
