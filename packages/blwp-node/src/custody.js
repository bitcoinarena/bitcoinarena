// THE STAKE, WHILE THE ROUND IS RUNNING, AND WHERE IT ENDS UP.
//
// 23.1: the player's wallet pays a HOLD invoice for the payment hash their own
// Entry Contract carries, and from that moment the money is "accepted but not
// settled - in nobody's balance". 23.2 says what each outcome does to it, and
// `payout.js` already writes both of those down. What was missing is anything
// that runs them: measured before this file existed, `holdSettlement`,
// `holdAfter` and `invoiceMatchesEntry` had ZERO callers outside their own
// tests, and a grep for an invoice across every source and tool found only
// comments.
//
// THE OUTCOME IS THE CORE'S. A run ends DELIVERED, WRECKED or MISSED inside
// `rules/gate.js` and a node reads that word off a replay - it is not a thing
// this file decides, and it is certainly not a thing a browser reports. What
// is decided here is only which Lightning act 23.2 names for that word, and
// whether this node is allowed to make it yet.
//
// AND THE DEFAULT IS ALWAYS THE REFUND. A VOID is not a cancel: `payout.js`
// says "a cancel is an ACT, and it needs five of seven; a refund that needed
// an act is one an operator could withhold". So a void round issues NOTHING,
// the HTLC expires, and the player's wallet takes its money back without this
// node lifting a finger. A node that crashes mid-round produces the same
// answer, which is the whole reason the default is written that way.
//
// SINGLE-NODE CUSTODY, NOT §23.5. This machine has one Lightning node and the
// 2-of-2 has two daemons, so one of them is the custodian and the other is
// not. 23.5 wants every operation on the pool to need a 5-of-7 threshold
// signature; that is FROST's letter, not this one. Nothing here should be read
// as a threshold.
import {
  holdSettlement, holdAfter, invoiceMatchesEntry,
  SETTLE, CANCEL, NOTHING, HELD, SETTLED, CANCELLED, EXPIRED,
} from '../../protocol/src/payout.js';
import { decodeEntryContract, entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

export { HELD, SETTLED, CANCELLED, EXPIRED, SETTLE, CANCEL, NOTHING };

/**
 * THE ONLY STATE IN THIS FILE THAT IS NOT 23.2'S.
 *
 * Between telling Lightning to settle and writing down that it was told, there
 * is a window one SIGKILL wide, and a crash inside it was measured: the log
 * said the preimage was released and this node's store still said HELD, so the
 * node that came back settled the same stake a second time. `ACTING` is
 * written BEFORE the call, so what a restarted node finds is not "nothing
 * happened" but "something may have". It is a node's own bookkeeping, not a
 * state a stake can be in as far as the spec is concerned - a stake in it is
 * either still held or already moved, and only Lightning knows which.
 */
export const ACTING = 'ACTING';

/** A port that reaches no Lightning at all, which is the shipping default. */
export const NO_LIGHTNING = null;

/**
 * The stake side of one daemon.
 *
 * `port` is injected for the same reason `sign`, the curve and the chain view
 * are: this package decides what should happen to a stake, and reaching a
 * Lightning node is transport. A daemon given none holds no stakes and says so
 * - it does not pretend to.
 */
export class Custody {
  constructor(round, { port = NO_LIGHTNING, preimageFor = null } = {}) {
    this.round = round;
    this.port = port;
    // WHERE THE PREIMAGE COMES FROM IS NOT THIS FILE'S BUSINESS. 23.4 needs
    // five of seven preimage shares before a stake can be settled, and letter
    // 29's Feldman handouts are what those shares are; reconstructing them is
    // its own letter. What settling needs is the 32 bytes, and a node that
    // cannot produce them cannot settle - which is the safe direction anyway.
    this.preimageFor = preimageFor;
  }

  get reaches() { return this.port !== null && this.port !== undefined; }

  /**
   * ISSUE THE HOLD FOR AN ENTRY, against the entry's own signed numbers.
   *
   * The payment hash and the amount are NOT arguments: 23.1 puts both on the
   * Entry Contract, and `invoiceMatchesEntry` is the rule a player checks the
   * invoice with. Taking them from anywhere else would let a node hold a
   * different amount than the one the player signed, and the player's own
   * check would then refuse to pay - so they are read off the entry here too,
   * and the same rule is run on the answer before a row is written.
   */
  async hold(entry) {
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it holds no stakes' };

    const entryId = entryIdOf(entry);
    const held = this.round.hold(entryId);
    if (held) return { ok: true, state: held.state, why: 'this entry already has a hold', already: true };

    const invoice = await this.port.createHeld({
      paymentHash: entry.stakeCommitment,
      amountMsat: entry.stakeMsat,
      entryId,
    });

    // THE INVOICE IS CHECKED AGAINST THE ENTRY, even though this node asked
    // for it. A port that answered with a different hash or a different amount
    // is a port that has committed the player's money to a preimage the
    // committee cannot reconstruct, and nobody could ever settle or prove it.
    const matches = invoiceMatchesEntry({
      paymentHash: invoice && invoice.paymentHash,
      amountMsat: invoice && invoice.amountMsat,
      entry,
    });
    if (!matches.ok) return { ok: false, why: `the invoice does not match the entry: ${matches.why}` };

    this.round.putHold({
      entryId, roundId: entry.roundId,
      paymentHash: invoice.paymentHash, amountMsat: invoice.amountMsat,
      state: HELD,
      why: 'in flight, in nobody\'s balance, until a final result says otherwise',
    });
    return { ok: true, state: HELD, paymentHash: invoice.paymentHash, invoice: invoice.request };
  }

  /**
   * WHAT 23.2 SAYS TO DO WITH EVERY STAKE OF A ROUND THAT HAS CLOSED - and
   * whether this node may do it yet.
   *
   * `entries` carry the core's own outcome word and score. `holdSettlement` is
   * 23.2's table and decides the action; `holdAfter` says what state the hold
   * ends in. NOTHING IS SETTLED WITHOUT A FINAL RESULT: `finalFor` answers
   * whether the committee has agreed on that run, and an entry it cannot
   * answer for is left HELD - which expires, which refunds the player. Not
   * acting is always safe; acting early is not.
   */
  async settleRound({ roundId, entries, minScore = 0, finalFor = () => false }) {
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it settles nothing' };

    const decided = holdSettlement({ roundId, entries, minScore });
    const done = [];

    for (const { entry, action, why } of decided.actions) {
      // THE ID COMES OFF THE ENTRY THE NODE ALREADY STORED, not from hashing
      // this object: 23.2's table is fed a per-entry summary - the outcome, the
      // score, the stake - and hashing that summary would produce an id no
      // Entry Contract has. The caller passes the id it holds.
      const entryId = entry.entryId;
      if (!(entryId instanceof Uint8Array))
        return { ok: false, why: 'every entry handed to a settlement carries the id this node stored it under' };
      const row = this.round.hold(entryId);
      if (!row) { done.push({ entryId, action, state: null, why: 'this node holds no stake for that entry' }); continue; }
      if (row.state === ACTING) {
        done.push({ entryId, action, state: ACTING, why: 'this node died in the middle of that act; reconcile it against Lightning first' });
        continue;
      }
      if (row.state !== HELD) { done.push({ entryId, action, state: row.state, why: 'that hold has already moved' }); continue; }

      // A CANCEL AND A SETTLE ARE BOTH ACTS, and an act needs the committee to
      // have finished. 23.4: settling requires a FINAL result; and a cancel
      // that this node could make on its own would be a refund an operator
      // chooses, which is the same power wearing the other hat.
      const isFinal = action === NOTHING ? false : !!finalFor(entryId, entry);
      // `nobodyActs` is NOT passed. It is `holdAfter`'s name for a node that
      // did not act at all, and a node that did not act does not reach this
      // line - it is not running. Passing `action === NOTHING` for it would be
      // the same condition twice, and a mutation that dropped one of the two
      // survived every test because the other still held.
      const ends = holdAfter({ action, authorised: isFinal });

      // THE INTENT IS ON DISK BEFORE THE CALL IS MADE. Not after: a crash
      // between the two would leave Lightning holding a preimage this node has
      // no record of asking it to release, and the node that came back would
      // ask again. Measured, before this line existed, in `custody-crash.mjs`.
      // A SETTLE NEEDS THE PREIMAGE, and a node without it does not settle.
      // Discovered against the real binary: `lncli settleinvoice` takes the
      // preimage, not the hash, because releasing it IS the settlement. A
      // stake this node cannot settle stays HELD and expires back to its
      // player, which is 23.2's default and not a loss.
      let preimage = null;
      if (ends.state === SETTLED) {
        preimage = this.preimageFor ? await this.preimageFor(entryId, entry) : null;
        const fits = preimage instanceof Uint8Array && preimage.length === 32
          && toHex(sha256(preimage)) === toHex(row.paymentHash);
        if (!fits) {
          done.push({ entryId, action, state: HELD, final: isFinal,
            why: preimage
              ? 'that preimage is not the one this hold was made for, so releasing it would settle nothing'
              : 'this node has no preimage for that stake, so it cannot settle it; the hold expires to its player' });
          continue;
        }
      }

      if (ends.state === SETTLED || ends.state === CANCELLED) {
        this.round.putHold({
          entryId, roundId: row.roundId, paymentHash: row.paymentHash,
          amountMsat: row.amountMsat, state: ACTING,
          why: `about to ${ends.state === SETTLED ? 'settle' : 'cancel'}; if this node dies here, ask Lightning`,
        });
        if (ends.state === SETTLED) await this.port.settle({ paymentHash: row.paymentHash, preimage, entryId });
        else await this.port.cancel({ paymentHash: row.paymentHash, entryId });
      }
      // EXPIRED and HELD are not acts. Nothing is sent, and that is the point.

      this.round.putHold({
        entryId, roundId: row.roundId, paymentHash: row.paymentHash,
        amountMsat: row.amountMsat, state: ends.state,
        why: `${why}; ${ends.why}`,
      });
      const state = ends.state;
      done.push({ entryId, action, state, why: ends.why, final: isFinal });
    }

    return { ok: true, actions: done, table: decided.table };
  }

  /**
   * ASK LIGHTNING WHAT ACTUALLY HAPPENED to every stake this node was in the
   * middle of acting on when it stopped.
   *
   * This is what the port's fourth operation is for. An `ACTING` row means the
   * call was made and the answer never came back, and the only party that
   * knows whether the preimage went out is the node that holds it - so it is
   * asked, and its answer is written down. An invoice still held means the act
   * never landed and the next close will make it again; one already settled or
   * cancelled means it did, and it will not be made twice.
   */
  async reconcile({ roundId }) {
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it cannot ask what happened' };
    if (typeof this.port.look !== 'function')
      return { ok: false, why: 'this port cannot be asked what it did, so an interrupted act cannot be resolved' };

    const asked = [];
    for (const row of this.round.holdsOf(roundId)) {
      if (row.state !== ACTING) continue;
      const seen = await this.port.look({ paymentHash: row.paymentHash, entryId: row.entryId });
      const state = seen && seen.state;
      if (![HELD, SETTLED, CANCELLED, EXPIRED].includes(state))
        return { ok: false, why: `Lightning answered ${state} for a stake this node was acting on, which is not a state a hold can be in` };
      this.round.putHold({
        entryId: row.entryId, roundId: row.roundId, paymentHash: row.paymentHash,
        amountMsat: row.amountMsat, state,
        why: state === HELD
          ? 'this node died before the act reached Lightning, which still holds it'
          : `this node died mid-act; Lightning says it is ${state}`,
      });
      asked.push({ entryId: row.entryId, state });
    }
    return { ok: true, asked };
  }

  /** What this node believes about one stake, for an operator who asks. */
  stateOf(entryId) {
    const row = this.round.hold(entryId);
    return row ? { ...row, id: toHex(entryId) } : null;
  }
}

/** The entry a stored contract carries, decoded once for a caller. */
export const entryOf = (bytes) => decodeEntryContract(bytes);
