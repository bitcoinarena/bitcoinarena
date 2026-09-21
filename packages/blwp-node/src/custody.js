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
  holdSettlement, holdAfter, invoiceMatchesEntry, netStakeMsat,
  SETTLE, CANCEL, NOTHING, HELD, SETTLED, CANCELLED, EXPIRED,
} from '../../protocol/src/payout.js';
import { decodeEntryContract, entryId as entryIdOf, decodeRoundContract, publicationRelaysAreValid } from '../../protocol/src/contracts.js';
import { cltvBlocksFor } from '../../protocol/src/hold-window.js';
import { winnings as winningsOf } from '../../protocol/src/payout-spend.js';
import { lightningAddressEndpoint, payRequestStands, callbackFor, invoiceAnswersPayRequest }
  from '../../protocol/src/lnurl-pay.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

export { HELD, SETTLED, CANCELLED, EXPIRED, SETTLE, CANCEL, NOTHING };

/** An entry in a round that asks no stake: there is no hold, by design. */
export const FREE = 'FREE';

/**
 * 9.4'S NAMES FOR THE MOMENTS BEFORE A CALL, written BEFORE the call.
 *
 *   AWAITING_INVOICE -> HELD -> (result FINAL)
 *     qualifying: CANCEL_REQUESTED -> CANCELLED -> PAYOUT_QUEUED -> PAID
 *     losing:     ... -> SETTLE_REQUESTED -> SETTLED
 *
 * Between telling Lightning to act and writing down that it was told there is
 * a window one SIGKILL wide, and a crash inside it was measured: the log said
 * the preimage was released and this node's store still said HELD, so the node
 * that came back settled the same stake a second time. A REQUESTED row is what
 * a restarted node finds instead - not "nothing happened" but "this was asked
 * for, and only Lightning knows whether it landed" - so it asks.
 *
 * AWAITING_INVOICE is the same idea one step earlier: the stake's hash and
 * amount are on disk before the endpoint is asked for an invoice, and a row in
 * it carries no invoice, so it is asked for again rather than called held.
 */
export const AWAITING_INVOICE = 'AWAITING_INVOICE';
export const CANCEL_REQUESTED = 'CANCEL_REQUESTED';
export const SETTLE_REQUESTED = 'SETTLE_REQUESTED';
/** §24A.2's tail for a qualifier's winnings: what the table says, then the payment, then Lightning's word. */
export const OWED = 'OWED';
export const PAYING = 'PAYING';
export const PAID = 'PAID';

/**
 * THE LABEL BOTH ACTS WERE WRITTEN UNDER BEFORE 9.4'S NAMES, and nothing writes
 * it now. It is still READ: a store written before the rename may hold a row in
 * it, and that row means exactly what a REQUESTED one means.
 */
export const ACTING = 'ACTING';

/** Every label meaning "an act was asked for and its answer never came back". */
export const MID_ACT = [CANCEL_REQUESTED, SETTLE_REQUESTED, ACTING];

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
  constructor(round, { port = NO_LIGHTNING, preimageFor = null, secondsPerBlock = null, peersPaid = null,
    fetch: get = null } = {}) {
    this.round = round;
    this.port = port;
    // HOW THIS NODE ASKS A LIGHTNING ADDRESS FOR AN INVOICE. The global one on a daemon; a test hands
    // its own, because reaching a real host is not what a settle is being measured for.
    this.fetch = get || ((...a) => fetch(...a));
    // HOW FAST BLOCKS ARE COMING ON THE CHAIN THIS NODE WATCHES (RULED 2026-09-21). An HTLC dies at a
    // HEIGHT and a round becomes final after a TIME, and only the chain's pace joins the two. Measured by
    // the launcher from its own bitcoind and handed in; unknown, the hold keeps the contract's own
    // `stakeExpiryBlocks`, which is what every hold had before this.
    this.secondsPerBlock = secondsPerBlock;
    // WHETHER ANOTHER SEAT HAS ALREADY PAID A WINNING. Every seat of the committee writes the same
    // `winnings` row, and they share one Lightning node, so a player who asked the second seat with a
    // DIFFERENT invoice would be paid the pool twice out of the operator's own channel. Measured on the
    // Daily's first paid winning: seat a PAID/98000, seat b still OWED/98000. The seats are asked before
    // the money leaves; a seat that cannot reach its peers pays nothing, because not knowing is not a no.
    this.peersPaid = peersPaid;
    // WHERE THE PREIMAGE COMES FROM IS NOT THIS FILE'S BUSINESS. 23.4 needs
    // five of seven preimage shares before a stake can be settled, and letter
    // 29's Feldman handouts are what those shares are; reconstructing them is
    // its own letter. What settling needs is the 32 bytes, and a node that
    // cannot produce them cannot settle - which is the safe direction anyway.
    this.preimageFor = preimageFor;
    // THE WINNINGS THIS NODE HAS A PAYMENT IN FLIGHT FOR, by entry id. See `payWinnings`.
    this.paying = new Set();
  }

  /**
   * THE CHAIN'S PACE AT THE MOMENT THE HOLD IS MADE, not the one the launcher saw at start.
   *
   * Measured on the Daily, round 6deead16: the launcher timed 200 blocks at start and got 5.660 s a
   * block; by the time the round was played the same chain was doing 0.770 s a block - 100 blocks in
   * 77 s. The HTLC was bought for about a thousand seconds of wall clock and lasted about a hundred and
   * forty, so both stakes EXPIRED back to the player at +626 s after the close while the objection
   * window still had time to run, and a truck that DELIVERED was never paid. A pace sampled once is a
   * guess about the future; this asks for it each time a hold is sized.
   *
   * A number is still accepted and still means what it meant, so a caller with a fixed chain - and every
   * test - passes one. A function may be async, and one that throws or answers nothing leaves the hold on
   * the contract's own `stakeExpiryBlocks`, which is what every hold had before any of this.
   */
  async pace() {
    if (typeof this.secondsPerBlock !== 'function') return this.secondsPerBlock;
    let said;
    try { said = await this.secondsPerBlock(); } catch { return null; }
    return Number.isFinite(said) && said > 0 ? said : null;
  }

  get reaches() { return this.port !== null && this.port !== undefined; }

  /**
   * HAS THIS NODE SEEN THE STAKE HELD? 23.1 step 5: "STAKE_COMMITTED is
   * recorded once >=5 settlement nodes have seen the held HTLC. Play begins
   * only after this." This is one node's half of that: a node that has not
   * seen it signs nothing for the entry's play, so the >=5 is the receipt
   * threshold the client already needs.
   *
   * Measured before: nothing asked. An unpaid OPEN invoice reads HELD - money
   * nobody sent is not money in flight - and `paidMsat` had no caller, so a
   * joined entry played on a stake that never arrived.
   *
   * Seen once, remembered: the answer is written the first time Lightning shows
   * the full amount held, and later play is answered from the row.
   */
  async seenPaid(entryId) {
    const stored = this.round.entry(entryId);
    if (!stored) return { ok: false, why: 'this node holds no such entry' };
    const entry = decodeEntryContract(stored);
    if (entry.stakeMsat === 0n) return { ok: true, state: FREE };
    const seen = this.round.stakeSeen(entryId);
    if (seen) return { ok: true, state: HELD, paidMsat: seen.paidMsat, already: true };
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it cannot see this stake held, and play waits for that (23.1)' };
    const row = this.round.hold(entryId);
    if (!row) return { ok: false, why: 'this node issued no hold for that entry, so there is nothing to see paid' };
    const got = await this.port.look({ paymentHash: row.paymentHash, entryId });
    const paid = got && typeof got.paidMsat === 'bigint' ? got.paidMsat : 0n;
    if (!got || got.state !== HELD || paid === 0n || paid < row.amountMsat)
      return { ok: false, why: `the stake is not paid and held: ${paid} of ${row.amountMsat} msat, Lightning says ${got && got.state}` };
    this.round.putStakeSeen({ entryId, paidMsat: paid });
    // THE ONE FACT LIGHTNING SUPPLIES NOW (M3.3-30): when the HTLC expires. Past
    // that height on this node's own chain the hold is gone back to its player.
    if (Number.isInteger(got.expiryHeight)) this.round.putHoldExpiry({ entryId, expiryHeight: got.expiryHeight });
    return { ok: true, state: HELD, paidMsat: paid };
  }

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
    // A ROUND THAT ASKS NO STAKE HOLDS NOTHING, AND NEEDS NO LIGHTNING TO SAY
    // SO. Satoshis are optional (the owner 2026-09-10 11:15): a free round is how
    // ghosts are tested with no wallet, and its entry must not depend on a node
    // this operator may never run. Asked BEFORE the Lightning question, so a
    // free round on a node with none reads as free rather than as a fault. It
    // keys on the round asking nothing - not on a net of zero, which a paid
    // entry whose donation took the rest would also reach.
    if (entry && entry.stakeMsat === 0n)
      return { ok: true, state: FREE, why: 'this round asks no stake: nothing is held and no Lightning is needed' };

    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it holds no stakes' };

    // NO HOLD IN A PAYING ROUND THAT NAMES NO PUBLICATION RELAY (§13A, P2):
    // none of its results can become final, so no stake in it could settle.
    // Here, the one funnel to createHeld, so /entry, /invoice and any later
    // caller all meet it - and before an existing hold is looked up, so an
    // invoice kept from before the rule is not quoted again either.
    const into = this.round.get(entry.roundId);
    let cltvExpiryBlocks = null;
    if (into) {
      const c = decodeRoundContract(new Uint8Array(into.contract));
      const relays = publicationRelaysAreValid(c);
      if (!relays.ok) return { ok: false, why: `no hold is issued in that round: ${relays.why}` };
      // AND THE HTLC IS SIZED FOR THIS ROUND ON THIS CHAIN. `stakeExpiryBlocks` is a floor, not an answer:
      // 144 blocks is a day where blocks take ten minutes and twelve minutes where they take five seconds.
      // Measured on the Daily: a hold of 144 lasted 730 s against a round that was not final for 830.
      const pace = await this.pace();
      if (pace) {
        cltvExpiryBlocks = cltvBlocksFor({ secondsPerBlock: pace, blockTicks: c.blockTicks,
          objectionWindowMs: c.objectionWindowMs, floorBlocks: c.stakeExpiryBlocks });
      }
    }

    const entryId = entryIdOf(entry);
    const held = this.round.hold(entryId);
    // A ROW STILL AWAITING ITS INVOICE IS NOT A HOLD: this node died between
    // asking and hearing back, so it asks again - the endpoint takes up an
    // invoice it already made (lnd-port.js) - rather than answer with none.
    if (held && held.state !== AWAITING_INVOICE)
      return { ok: true, state: held.state, paymentHash: held.paymentHash,
        invoice: held.request, why: 'this entry already has a hold', already: true };

    // THE HOLD IS FOR THE NET STAKE. The fee and the donation come out of the
    // commitment (22A) and are paid from their own entry-time commitment, not
    // the pool (23.5) - and a DELIVERED hold is cancelled back whole, so a hold
    // for the commitment would return every winner their own fee.
    //
    // ON DISK BEFORE THE ENDPOINT IS ASKED (9.4's AWAITING_INVOICE): the hash
    // and the amount are the entry's own, so they are known before the call.
    this.round.putHold({
      entryId, roundId: entry.roundId,
      paymentHash: entry.stakeCommitment, amountMsat: netStakeMsat(entry),
      state: AWAITING_INVOICE,
      why: 'asking the endpoint for this stake\'s hold invoice; if this node dies here, ask again',
    });
    const invoice = await this.port.createHeld({
      paymentHash: entry.stakeCommitment,
      amountMsat: netStakeMsat(entry),
      entryId,
      ...(cltvExpiryBlocks ? { cltvExpiryBlocks } : {}),
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
    if (!matches.ok) {
      // A REFUSED ANSWER IS A KNOWN ONE, unlike a call that never came back:
      // nothing was held, so the AWAITING_INVOICE row goes and nothing stays.
      this.round.dropHold(entryId);
      return { ok: false, why: `the invoice does not match the entry: ${matches.why}` };
    }

    this.round.putHold({
      entryId, roundId: entry.roundId,
      paymentHash: invoice.paymentHash, amountMsat: invoice.amountMsat,
      state: HELD, request: invoice.request,
      why: 'in flight, in nobody\'s balance, until a final result says otherwise',
    });
    // WHEN IT RUNS OUT IF NOBODY PAYS (M3.3-30): now plus the expiry this node
    // asked for. A second daemon taking up the endpoint's invoice counts from
    // its own issue, which is later - a row that stays HELD a little long, never
    // one that says EXPIRED while the invoice can still be paid.
    if (Number.isInteger(invoice.expirySeconds) && invoice.expirySeconds > 0)
      this.round.putInvoiceExpiry({ entryId, expiresMs: this.round.now() + invoice.expirySeconds * 1000 });
    return { ok: true, state: HELD, paymentHash: invoice.paymentHash, invoice: invoice.request };
  }

  /**
   * WHAT 23.2 SAYS TO DO WITH EVERY STAKE OF A ROUND THAT HAS CLOSED - and
   * whether this node may do it yet.
   *
   * NOT `settleRound`. `Verifier.settleRound` is section 13's replay-and-gather
   * and moves no money at all; a close that called one while reading like the
   * other is a mistake nobody would see in a diff. This one says invoices.
   *
   * `entries` carry the core's own outcome word and score. `holdSettlement` is
   * 23.2's table and decides the action; `holdAfter` says what state the hold
   * ends in. NOTHING IS SETTLED WITHOUT A FINAL RESULT: `finalFor` answers
   * whether the committee has agreed on that run, and an entry it cannot
   * answer for is left HELD - which expires, which refunds the player. Not
   * acting is always safe; acting early is not.
   */
  async settleHeldInvoices({ roundId, entries, minScore = 0, finalFor = () => false }) {
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it settles nothing' };

    // A ROUND NOBODY FINISHED HAS A POOL AND NOBODY TO HAND IT TO, and
    // `payout.js` REFUSES rather than deciding that in the operator's favour.
    // Measured through the daemon: every round a wrecked transcript can
    // produce is one of these, so this is not a corner - it is the common
    // case until somebody delivers.
    //
    // The refusal is not an error to log and step past. It means no stake may
    // move, so none does: every hold stays HELD and expires back to its own
    // player, which is 23.2's default and the only answer that keeps nothing
    // for this node.
    // THE FEES GO FIRST, AND THEY DO NOT DEPEND ON THE POOL (§5A.12, §23.5).
    //
    // A fee is for SERVING the round, not for winning it, so it is settled before the table is even
    // computed - measured on the Daily, the common case is a round nobody finished, where `holdSettlement`
    // refuses and this function returns without moving a stake. The committee still served that round.
    // Its own object, so a dispute over it never touches another player's stake.
    //
    // AND NOT BEFORE THE OBJECTION WINDOW HAS CLOSED (§13A). Measured on the Daily, round ec9bd34e: the
    // window was 600000 ms and the fees settled 12 s after the close, on a round still
    // PROVISIONALLY_FINAL. FINAL is the window's word, and a fee taken before it is a fee taken for a
    // result that could still be objected to.
    const finalRound = entries.length > 0 && entries.every((e) => !!finalFor(e.entryId, e));
    // EACH FEE ON ITS OWN ENTRY'S FINALITY, not on the round's. §23.5 gave the fee its own lock so that
    // "a fee dispute never touches another player's stake", and a round-wide gate would undo exactly
    // that: one player inside their objection window would hold up every other player's fee on a round
    // this committee had served in full, and a fee held long enough expires back.
    const byId = new Map(entries.map((e) => [toHex(e.entryId), e]));
    const fees = await this.settleFees({ roundId,
      final: (entryId) => { const e = byId.get(toHex(entryId)); return !!e && !!finalFor(entryId, e); } });

    let decided;
    try { decided = holdSettlement({ roundId, entries, minScore }); }
    catch (err) {
      return { ok: false, actions: [], moved: 0,
        feesMsat: fees.ok ? fees.msat : 0n, feesMoved: fees.ok ? fees.moved.length : 0,
        why: `no stake moves: ${err.message}. every hold stays in flight and expires to its player` };
    }
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
      if (MID_ACT.includes(row.state)) {
        done.push({ entryId, action, state: row.state, why: 'this node died in the middle of that act; reconcile it against Lightning first' });
        continue;
      }
      if (row.state === AWAITING_INVOICE) {
        done.push({ entryId, action, state: AWAITING_INVOICE, why: 'no invoice was ever confirmed for that stake, so there is nothing to act on' });
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
        preimage = this.preimageFor ? await this.preimageFor(entryId, entry, roundId) : null;
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
          amountMsat: row.amountMsat,
          state: ends.state === SETTLED ? SETTLE_REQUESTED : CANCEL_REQUESTED,
          why: `about to ${ends.state === SETTLED ? 'settle' : 'cancel'}; if this node dies here, ask Lightning`,
        });
        // A REFUSED ACT IS AN ANSWER, AND IT IS WRITTEN DOWN LIKE ONE.
        //
        // Measured on the Daily: a loser's stake was due to settle into the pool, the objection window
        // closed, and `lncli settleinvoice` came back "invoice already canceled" because lnd had given up
        // on the HTLC seventeen blocks before its stated expiry. The throw left the row at
        // SETTLE_REQUESTED on both seats, and `settleHeldInvoices` refuses to touch a mid-act row
        // ("reconcile it against Lightning first"), while `reconcile` itself runs only on start. So the
        // entry was unsettleable for as long as the node stayed up - and, worse, the throw left the rest
        // of that round's entries unacted on, because it aborted the loop.
        //
        // Nothing is decided here. The one party that knows what happened is asked the same question
        // `reconcile` asks, and its answer is the row's new state. A port that cannot be asked, or that
        // answers something no hold can be in, leaves the row as it is: not knowing is not a verdict.
        try {
          if (ends.state === SETTLED) await this.port.settle({ paymentHash: row.paymentHash, preimage, entryId });
          else await this.port.cancel({ paymentHash: row.paymentHash, entryId });
        } catch (err) {
          const act = ends.state === SETTLED ? 'settle' : 'cancel';
          let seen = null;
          if (typeof this.port.look === 'function') {
            try { seen = await this.port.look({ paymentHash: row.paymentHash, entryId }); } catch { seen = null; }
          }
          const said = seen && seen.state;
          const known = [HELD, SETTLED, CANCELLED, EXPIRED].includes(said);
          this.round.putHold({
            entryId, roundId: row.roundId, paymentHash: row.paymentHash, amountMsat: row.amountMsat,
            state: known ? said : (ends.state === SETTLED ? SETTLE_REQUESTED : CANCEL_REQUESTED),
            why: known
              ? `Lightning refused the ${act} (${err.message}) and says the stake is ${said}`
              : `Lightning refused the ${act} (${err.message}) and could not say what the stake is`,
          });
          done.push({ entryId, action, state: known ? said : row.state, final: isFinal, refused: true,
            why: `Lightning refused the ${act}: ${err.message}` });
          continue;
        }
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

    // AND THE POOL 23.2's TABLE DECIDED (M3.2 6e): `holdSettlement`'s own sum of
    // the net stakes it settles - handed up so the signer node can say it, not worked
    // out a second time by anybody who wants to show it.
    // AND WHAT THE POOL OWES ITS QUALIFIERS IS WRITTEN DOWN IN THE SAME BREATH. Measured before this: the
    // losers' stakes settled, the winner's was cancelled back, and the winnings existed nowhere at all.
    // `holdSettlement` hands back `computePayoutTable`'s whole answer, and the rows are its `table`.
    // AND THE POOL IS NOT OWED TO ANYBODY BEFORE THE STAKES THAT MAKE IT HAVE ARRIVED.
    //
    // Measured on the Daily, round ec9bd34e: the winner was written down as owed 98000 msat, and paid it,
    // TWELVE SECONDS after the close - on a round whose objection window had 588 s left to run and whose
    // two stakes were both still HELD, in flight and in nobody's balance. The 98 sat came out of the
    // committee's own channel against money that had not arrived, for a result that could still be
    // overturned. §13A: FINAL is the window's word; §23.5: the money leaves by the same transaction.
    //
    // So the pool is owed only once this node's own acts on this round are done: every stake that had an
    // act to receive has had it. A stake that EXPIRED back to its player is not one of those, and a round
    // holding one owes nobody the pool - there is no pool, and the operator does not make up the
    // difference out of its own channel.
    const acted = done.every((d) => d.action === NOTHING || d.state === SETTLED || d.state === CANCELLED);
    const owes = finalRound && acted
      ? this.oweWinnings({ roundId, table: (decided.table && decided.table.table) || decided.table, entries })
      : { ok: false, owed: [], owedMsat: 0n,
        why: finalRound ? 'a stake of this round has not reached the pool, so there is nothing to owe out of it'
          : 'this round is not final yet: its objection window is open' };
    // AND A WINNING WHOSE PLAYER ALREADY SAID WHERE IT GOES LEAVES HERE, WITH NO PAGE OPEN.
    //
    // the owner 2026-09-21 13:54: "winnings are always sent; there is no Collect and no pasted invoice after
    // the round". A Lightning address named during the round is a standing instruction on disk, so the
    // send is this node's own act at settle rather than something a tab must be alive to ask for.
    // Measured before this on the Daily: round ec9bd34e, both stakes paid from a wallet with no NWC
    // string, one truck DELIVERED, the address named in the page - and the page's Chrome closed at the
    // end of the run, so FINAL came with 98000 msat owed and nobody there to collect it.
    //
    // A send that fails leaves the row OWED and is tried again on the next pass: the close runs until the
    // round is done with, and `payWinnings` asks the peers and writes its intent before it pays, so a
    // retry cannot pay twice.
    const sentTo = [];
    for (const row of owes.ok ? owes.owed : []) {
      const named = this.round.payoutAddress(row.entryId);
      if (!named) continue;
      const paid = await this.payWinningsTo({ entryId: row.entryId, address: named.address });
      sentTo.push({ entryId: row.entryId, address: named.address, ok: !!paid.ok,
        already: !!paid.already, msat: paid.msat ?? 0n, why: paid.why });
    }
    return { ok: true, actions: done, table: decided.table, poolMsat: decided.poolMsat,
      owedTo: owes.ok ? owes.owed : [], owedMsat: owes.ok ? owes.owedMsat : 0n, sentTo,
      feesMsat: fees.ok ? fees.msat : 0n, feesMoved: fees.ok ? fees.moved.length : 0 };
  }

  /**
   * THE NODE FEE'S OWN HOLD, ASKED FOR AT ENTRY (§23.5, RULED 2026-09-21).
   *
   * "The node fee travels in its own lock and leaves by the same transaction, so a fee dispute never
   * touches another player's stake." On this custody the lock is a hold invoice, keyed on the entry's own
   * `feePreimage` - the same secret the federation's fee lock is claimed by - so the committee can settle
   * it without any threshold: the fee is not the pool and nobody's stake pays it.
   *
   * WHY NOT ONE INVOICE FOR THE COMMITMENT. §22A's "inclusive in the wallet commitment" means both amounts
   * leave the wallet up front, not that they share one HTLC: §23.2 cancels a DELIVERED player's hold WHOLE,
   * so a single gross hold would hand every winner their own fee back. Measured on the Daily before this:
   * 41 paid entries, 4100000 msat committed, 4016000 asked for, and 82000 msat of fee never invoiced.
   *
   * The two seats share one Lightning endpoint, and this asks it the same way the stake does - the second
   * daemon takes up the invoice the first made, so one entry has one fee invoice (measured: 41 entries at
   * two seats, 41 invoices, no duplicate hashes).
   */
  async holdFee(entry) {
    if (!entry || entry.feeMsat === undefined) return { ok: false, why: 'that is not an entry contract' };
    if (entry.feeMsat === 0n) return { ok: true, state: FREE, why: 'that entry owes no fee, so none is held' };
    if (!this.reaches) return { ok: false, why: 'this node reaches no Lightning, so it holds no fees' };
    const entryId = entryIdOf(entry);
    const had = this.round.feeHold(entryId);
    if (had && had.state !== AWAITING_INVOICE)
      // THE AMOUNT COMES BACK TOO. Measured live: it did not, so every repeat quote - which is every quote
      // after the first, because a page asks again on each paint - carried a fee of 0, the client refused
      // it against the entry's own `feeMsat`, and `payStake` refused the WHOLE payment. The player paid
      // nothing at all.
      return { ok: true, state: had.state, paymentHash: had.paymentHash, invoice: had.request,
        amountMsat: had.amountMsat, why: 'this entry already has a fee hold', already: true };
    // THE HASH IS THE ENTRY'S OWN. `feePreimage` is inside the entry contract, so every seat computes the
    // same hash from the same bytes and a second seat asking for it takes up the first's invoice.
    const paymentHash = sha256(entry.feePreimage);
    this.round.putFeeHold({ entryId, roundId: entry.roundId, paymentHash, amountMsat: entry.feeMsat,
      state: AWAITING_INVOICE, why: 'asking the endpoint for this fee\'s hold invoice' });
    let invoice;
    const feePace = await this.pace();
    try {
      invoice = await this.port.createHeld({ paymentHash, amountMsat: entry.feeMsat, entryId,
        ...(feePace && this.round.get(entry.roundId) ? (() => {
          const c = decodeRoundContract(new Uint8Array(this.round.get(entry.roundId).contract));
          return { cltvExpiryBlocks: cltvBlocksFor({ secondsPerBlock: feePace, blockTicks: c.blockTicks,
            objectionWindowMs: c.objectionWindowMs, floorBlocks: c.stakeExpiryBlocks }) };
        })() : {}) });
    } catch (e) {
      this.round.putFeeHold({ entryId, roundId: entry.roundId, paymentHash, amountMsat: entry.feeMsat,
        state: AWAITING_INVOICE, why: `the endpoint refused this fee's invoice: ${e.message}` });
      return { ok: false, why: `no fee invoice: ${e.message}` };
    }
    if (toHex(invoice.paymentHash) !== toHex(paymentHash) || BigInt(invoice.amountMsat) !== entry.feeMsat)
      return { ok: false, why: 'the endpoint answered with an invoice for another hash or another amount' };
    this.round.putFeeHold({ entryId, roundId: entry.roundId, paymentHash, amountMsat: entry.feeMsat,
      state: HELD, why: 'the fee is in flight until this round is served', request: invoice.request });
    return { ok: true, state: HELD, paymentHash, invoice: invoice.request, amountMsat: entry.feeMsat };
  }

  /**
   * AND SETTLING IT TO THE COMMITTEE THAT SERVED THE ROUND, whatever the run came to (§5A.12: "the 2% node
   * fee goes only to the committee that actually serves the round"). A fee is for serving, not for winning:
   * DELIVERED, FAILED, FORFEIT and VOID all pay it. The preimage is the entry's own, so no threshold and no
   * share ceremony stands between the committee and a fee it has earned.
   */
  /**
   * `final` is asked PER ENTRY, and an entry it says no to keeps its fee.
   *
   * §23.5: "the node fee travels in its own lock and leaves by the same transaction, so a fee dispute
   * never touches another player's stake." That is what the separate lock is FOR, and a gate on the whole
   * round undoes it: one player still inside their objection window, or suspended by an objection, would
   * hold up every other player's fee on a round the committee had served in full - and a fee held long
   * enough expires back. Left out, every fee of the round is settled, which is what the caller wants when
   * it has already decided the round is done with.
   */
  async settleFees({ roundId, final = null }) {
    if (!this.reaches) return { ok: false, why: 'this node reaches no Lightning, so it settles no fees', moved: [] };
    const moved = [];
    const waited = [];
    for (const row of this.round.feeHoldsOf(roundId)) {
      if (row.state !== HELD) continue;
      if (final && !final(row.entryId)) { waited.push(row.entryId); continue; }
      const stored = this.round.entry(row.entryId);
      if (!stored) continue;
      let entry;
      try { entry = decodeEntryContract(stored); } catch { continue; }
      if (toHex(sha256(entry.feePreimage)) !== toHex(row.paymentHash)) {
        this.round.putFeeHold({ ...row, state: row.state,
          why: 'this fee hold was made for another preimage than the entry carries, so it is not settled' });
        continue;
      }
      this.round.putFeeHold({ entryId: row.entryId, roundId, paymentHash: row.paymentHash,
        amountMsat: row.amountMsat, state: SETTLE_REQUESTED, why: 'about to settle this fee; if this node dies here, ask Lightning' });
      try {
        await this.port.settle({ paymentHash: row.paymentHash, preimage: entry.feePreimage, entryId: row.entryId });
        this.round.putFeeHold({ entryId: row.entryId, roundId, paymentHash: row.paymentHash,
          amountMsat: row.amountMsat, state: SETTLED, why: 'paid to the committee that served this round' });
        moved.push({ entryId: row.entryId, msat: row.amountMsat });
      } catch (e) {
        // A REFUSED FEE IS AN ANSWER, read the same way a refused stake is.
        let seen = null;
        if (typeof this.port.look === 'function') {
          try { seen = await this.port.look({ paymentHash: row.paymentHash, entryId: row.entryId }); } catch { seen = null; }
        }
        const said = seen && seen.state;
        const known = [HELD, SETTLED, CANCELLED, EXPIRED].includes(said);
        this.round.putFeeHold({ entryId: row.entryId, roundId, paymentHash: row.paymentHash,
          amountMsat: row.amountMsat, state: known ? said : SETTLE_REQUESTED,
          why: known ? `Lightning refused the settle (${e.message}) and says the fee is ${said}`
            : `Lightning refused the settle (${e.message}) and could not say what the fee is` });
      }
    }
    return { ok: true, moved, waited, msat: moved.reduce((a, m) => a + m.msat, 0n) };
  }

  /**
   * WHAT THE POOL OWES EACH QUALIFIER, WRITTEN DOWN (§24A.2).
   *
   * The settle moves the losers' stakes in and cancels a delivered player's own stake back, and that was
   * where the money stopped: measured on the Daily's first settled round, the rule computed 98000 msat owed
   * to the winner, the 98 sat sat in the committee's own channel, and nothing recorded that anyone was
   * owed it. `winnings` takes each qualifier's own net stake off their table row, so what is left is the
   * pool's share and nothing else. Nothing is paid here - a payment needs somewhere to send it, and that is
   * the player's to give.
   */
  oweWinnings({ roundId, table, entries }) {
    const said = winningsOf({ table, stakes: entries });
    if (!said.ok) return { ok: false, why: said.why, owed: [] };
    const byKey = new Map(entries.map((e) => [toHex(e.pubkey), e]));
    const owed = [];
    for (const row of said.rows) {
      const e = byKey.get(toHex(row.pubkey));
      if (!e) continue;
      const had = this.round.winnings(e.entryId);
      // A ROW ALREADY PAID IS NOT RE-OWED. The close runs again and again; the money moves once.
      if (had && had.state === PAID) continue;
      this.round.putWinnings({ entryId: e.entryId, roundId, owedMsat: row.msat, state: OWED,
        why: 'the table owes this qualifier the pool\'s share; it is paid to an invoice they present' });
      owed.push({ entryId: e.entryId, msat: row.msat });
    }
    return { ok: true, owed, owedMsat: said.owedMsat };
  }

  /**
   * AND PAYING IT, ONCE, TO AN INVOICE THE PLAYER PRESENTED.
   *
   * §24A.2: "a payout contract to the player's key; the client withdraws it over Lightning through any
   * listed gateway". The amount is not taken from the invoice: it is what this node already wrote down as
   * owed, and an invoice for anything else is refused rather than paid. The intent is on disk before the
   * call, like every other act on this path, so a node that dies mid-payment comes back knowing one may be
   * in flight rather than paying twice.
   */
  /**
   * AND THE SAME WINNING SENT TO A LIGHTNING ADDRESS, for a player with no NWC wallet to mint with
   * (the owner 2026-09-21 13:54: "winnings must leave without NWC").
   *
   * LUD-16 then LUD-06: the address names an endpoint, the endpoint's pay request is checked against what
   * is owed, its callback is asked for an invoice of exactly that, and the invoice is checked against the
   * request before a satoshi moves - `payRequestStands` and `invoiceAnswersPayRequest` are the protocol's
   * rules, not this file's. What comes out is an ordinary bolt11, so it goes through `payWinnings` and
   * gets the same pay-once treatment: the peers are asked, the intent is on disk, the amount is this
   * node's own figure.
   */
  async payWinningsTo({ entryId, address, fetch: given = null }) {
    const get = given || this.fetch;
    const owed = this.round.winnings(entryId);
    if (!owed) return { ok: false, why: 'this node owes that entry nothing out of the pool' };
    if (owed.state === PAID) return { ok: true, already: true, state: PAID, why: 'that winning is already paid' };
    const where = lightningAddressEndpoint(address);
    if (!where.ok) return { ok: false, why: where.why };
    let said;
    try {
      const r = await get(where.url);
      if (!r.ok) return { ok: false, why: `${where.host} answered ${r.status} for that address` };
      said = await r.json();
    } catch (e) { return { ok: false, why: `that address could not be asked: ${e.message}` }; }
    const stands = payRequestStands(said, owed.owedMsat);
    if (!stands.ok) return { ok: false, why: stands.why };
    let invoice;
    try {
      // `callbackFor` hands back the URL itself, not a verdict: the verdict was `payRequestStands`.
      const cb = callbackFor({ callback: stands.callback, amountMsat: owed.owedMsat, commentAllowed: stands.commentAllowed });
      const r = await get(cb);
      if (!r.ok) return { ok: false, why: `that address's callback answered ${r.status}` };
      const gave = await r.json();
      invoice = gave && (gave.pr || gave.invoice);
      if (!invoice) return { ok: false, why: 'that address returned no invoice to pay' };
    } catch (e) { return { ok: false, why: `that address's callback could not be asked: ${e.message}` }; }
    const answers = invoiceAnswersPayRequest({ invoice, amountMsat: owed.owedMsat, metadata: stands.metadata });
    if (!answers.ok) return { ok: false, why: answers.why };
    return this.payWinnings({ entryId, request: invoice });
  }

  async payWinnings({ entryId, request }) {
    if (!this.reaches) return { ok: false, why: 'this node reaches no Lightning, so it pays nobody' };
    // TWO PATHS INTO THIS FUNCTION, AND ONLY ONE OF THEM MAY BE INSIDE IT.
    //
    // A player with a wallet AND an address has both: the door, when the page posts a minted invoice, and
    // the settle, when this node sends to the address it was given. The row is what makes a winning
    // pay-once, and PAYING is written below - but there is an `await` on the peers between reading the row
    // and writing it, and an await is where the other path gets its turn. Both would read OWED, both would
    // be told no seat has paid, and both would pay. The seats cover each other; nothing covered a node
    // against itself. This is that cover: one flight per entry in this process, released whatever happens.
    const key = toHex(entryId);
    if (this.paying.has(key))
      return { ok: false, state: PAYING, why: 'a payment for that winning is already in flight on this node' };
    this.paying.add(key);
    try { return await this.#payWinnings({ entryId, request }); } finally { this.paying.delete(key); }
  }

  async #payWinnings({ entryId, request }) {
    const owed = this.round.winnings(entryId);
    if (!owed) return { ok: false, why: 'this node owes that entry nothing out of the pool' };
    if (owed.state === PAID) return { ok: true, already: true, state: PAID, why: 'that winning is already paid' };
    if (owed.state === PAYING)
      return { ok: false, state: PAYING, why: 'a payment for that winning is already in flight; ask Lightning before making another' };
    if (owed.owedMsat <= 0n) return { ok: false, why: 'that entry is owed nothing' };
    if (this.peersPaid) {
      let said;
      try { said = await this.peersPaid(entryId, owed.roundId); }
      catch (e) { said = { ok: false, why: e.message }; }
      if (!said.ok)
        return { ok: false, why: `this node could not ask the other seats whether that winning is already `
          + `paid, and a pool is not paid twice on a guess: ${said.why}` };
      if (said.paid) {
        this.round.putWinnings({ entryId, roundId: owed.roundId, owedMsat: owed.owedMsat, state: PAID,
          why: 'another seat of this committee already paid this winning', paidMs: this.round.now() });
        return { ok: true, already: true, state: PAID, why: 'another seat already paid this winning' };
      }
    }
    if (typeof this.port.decode !== 'function' || typeof this.port.pay !== 'function')
      return { ok: false, why: 'this node\'s Lightning cannot pay an invoice, so it cannot pay a winning' };
    let said;
    try { said = await this.port.decode({ request }); } catch (e) { return { ok: false, why: `that invoice could not be read: ${e.message}` }; }
    const asks = BigInt((said && said.amountMsat) || 0n);
    if (asks !== owed.owedMsat)
      return { ok: false, why: `that invoice asks ${asks} msat and this entry is owed ${owed.owedMsat}: `
        + 'a winning is paid for what the table says, not for what an invoice says' };
    this.round.putWinnings({ entryId, roundId: owed.roundId, owedMsat: owed.owedMsat, state: PAYING,
      request, why: 'about to pay this winning; if this node dies here, ask Lightning' });
    try {
      const paid = await this.port.pay({ request });
      this.round.putWinnings({ entryId, roundId: owed.roundId, owedMsat: owed.owedMsat, state: PAID,
        request, why: `paid over Lightning${paid && paid.feeMsat ? `, ${paid.feeMsat} msat of routing fee` : ''}`,
        paidMs: this.round.now() });
      return { ok: true, state: PAID, msat: owed.owedMsat, preimage: paid && paid.preimage };
    } catch (e) {
      this.round.putWinnings({ entryId, roundId: owed.roundId, owedMsat: owed.owedMsat, state: OWED,
        request, why: `Lightning refused that payment: ${e.message}` });
      return { ok: false, state: OWED, why: `Lightning refused that payment: ${e.message}` };
    }
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
  async reconcile({ roundId = null } = {}) {
    if (!this.reaches)
      return { ok: false, why: 'this node reaches no Lightning, so it cannot ask what happened' };
    if (typeof this.port.look !== 'function')
      return { ok: false, why: 'this port cannot be asked what it did, so an interrupted act cannot be resolved' };

    // NO ROUND NAMED MEANS EVERY ROUND. A node that has just started does not
    // know which round it died in the middle of, which is the whole reason the
    // question is asked on start.
    // EVERY LABEL THAT MEANS "ASKED, NEVER ANSWERED": 9.4's two, and the old
    // one a store written before them may still hold.
    const rows = roundId ? this.round.holdsOf(roundId)
      : MID_ACT.flatMap((s) => this.round.holdsInState(s));
    const asked = [];
    for (const row of rows) {
      if (!MID_ACT.includes(row.state)) continue;
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

  /**
   * A HOLD WHOSE HTLC HAS EXPIRED IS NOT HELD (M3.3-30).
   *
   * Measured on the regtest rehearsal: a VOID stake timed out in lnd -
   * CANCELED, back with the player - and both daemons still listed it HELD, 35
   * of 35 runs; nothing moved a row to EXPIRED. The row now follows the chain:
   * a HELD row whose recorded expiry height this node's own chain is PAST is
   * EXPIRED. At the height itself the HTLC can still be claimed, so it is not.
   * Lightning is not asked here - its later label is not the node's truth - and
   * a row with no recorded height is left alone rather than guessed at.
   */
  expire({ tipHeight }) {
    if (!Number.isInteger(tipHeight))
      return { ok: false, why: 'no chain height to measure an expiry against', expired: [] };
    const expired = [];
    for (const row of this.round.holdsInState(HELD)) {
      const at = this.round.holdExpiry(row.entryId);
      if (at === null || !(tipHeight > at)) continue;
      this.round.putHold({
        entryId: row.entryId, roundId: row.roundId, paymentHash: row.paymentHash,
        amountMsat: row.amountMsat, state: EXPIRED,
        why: `its HTLC expired at height ${at} and this node's chain is at ${tipHeight}: the hold went back to its player`,
      });
      expired.push(row.entryId);
    }
    return { ok: true, expired };
  }

  /**
   * AN INVOICE NOBODY PAID IS NOT HELD (M3.3-30).
   *
   * HELD means money in flight in nobody's balance, and for an invoice never
   * paid that is false. A HELD row this node never saw paid, past the expiry it
   * recorded when it issued the invoice, is EXPIRED - its own clock on its own
   * number. But "never seen paid" is not "never paid": a player can pay and be
   * seen by nobody, and that HTLC is held in lnd past any invoice expiry. So the
   * one seen-time question is asked first, whether it is paid; a paid hold is
   * then seen, its HTLC expiry recorded, and it follows the chain-height rule
   * (`expire`). Only "not paid" expires a row; an answer this node cannot get
   * leaves it alone.
   */
  async expireUnpaid({ nowMs = this.round.now() } = {}) {
    const expired = [];
    for (const row of this.round.holdsInState(HELD)) {
      const until = this.round.invoiceExpiry(row.entryId);
      if (until === null || !(nowMs > until)) continue;
      if (this.round.stakeSeen(row.entryId)) continue;   // paid: the chain decides
      let seen;
      try { seen = await this.seenPaid(row.entryId); } catch { continue; }
      if (!seen || seen.ok || !/^the stake is not paid and held/.test(seen.why || '')) continue;
      this.round.putHold({
        entryId: row.entryId, roundId: row.roundId, paymentHash: row.paymentHash,
        amountMsat: row.amountMsat, state: EXPIRED,
        why: `its invoice ran out unpaid at ${new Date(until).toISOString()}: nothing was ever sent`,
      });
      expired.push(row.entryId);
    }
    return { ok: true, expired };
  }

  /** What this node believes about one stake, for an operator who asks. */
  stateOf(entryId) {
    const row = this.round.hold(entryId);
    return row ? { ...row, id: toHex(entryId) } : null;
  }
}

/** The entry a stored contract carries, decoded once for a caller. */
export const entryOf = (bytes) => decodeEntryContract(bytes);
