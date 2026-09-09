// A SEAT'S HALF OF A SIGNING ROUND, AND THE SHARE NEVER LEAVES IT.
//
// Item 13 gave the pool a taproot output whose key is the committee's, and
// item 10 gave the committee a FROST signature. What neither gave it was a
// COMMITTEE: `Payouts#pay` takes `signers` - an array of `{ id, share }` - and
// makes every nonce and every signature share in one `map`, so five of seven
// was arithmetic inside one process and the number of keys that had to agree
// before a settled satoshi moved was still one.
//
// This is the other side. A seat holds ONE share, it is never an argument to
// anything that crosses a wire, and what the seat puts on the wire is a nonce
// commitment and then a signature share - two round trips, RFC 9591's own two
// rounds.
//
// THE RULE THAT MAKES THE THRESHOLD REAL: a seat signs only a spend IT built.
//
// The obvious door takes a sighash and returns a share, and it is worthless.
// Five signatures over an attacker's 32 bytes spend the pool exactly as well
// as five over a real payout, so a committee that signs what it is handed has
// a threshold on paper and one key in practice. So nothing here accepts a
// sighash, a transaction, or a table. The asker names the round and the OUTPUT
// it wants spent - both facts anybody can check - and the seat rebuilds the
// rest out of its own store: its own results, its own entries, its own table,
// the signatures its peers gave it. If that does not come to the same
// transaction the asker wanted, the asker gets no share and no explanation
// beyond which of its own checks failed.
//
// THE NONCES LIVE IN MEMORY AND DIE WITH THE PROCESS, on purpose. Signing two
// different messages under one nonce pair publishes the share - it is two
// equations in two unknowns - so the one thing that must never happen is a
// nonce being used twice. A pair that is never written down cannot come back
// after a restart to be used again; a restart simply costs the asker a seat,
// and it can ask another. What IS remembered, for as long as the process
// lives, is which message a pair was made for and whether it has been spent,
// because the same pair asked to sign a second message is the same failure by
// a slower route.
import { winnings, payoutOutputs, DUST_SATS } from '../../protocol/src/payout-spend.js';
import { tapSighash } from '../../protocol/src/bond-spend.js';
import { poolOutput, poolShare, poolSigningKey, poolOwns } from '../../protocol/src/pool.js';
import { signShare340 } from '../../protocol/src/frost-bip340.js';
import { nonceGenerate, encodeCommitmentList } from '../../protocol/src/frost.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { toHex } from '../../protocol/src/hash.js';
import { tableFor, verifiedTable } from './payout-table.js';
import { PAYOUT_QUEUED } from './payout.js';

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * ONE SEAT, ONE SHARE.
 *
 * `seat` is `{ id, share }` and it is this node's own. It is dealt today - a
 * dealerless DKG is its own letter and this one does not pretend to be it -
 * but from here on the dealt value stays where it was dealt.
 */
export class PoolSigning {
  constructor(round, { curve, seat = null, pool = null, dustSats = DUST_SATS } = {}) {
    this.round = round;
    this.curve = curve;
    this.seat = seat;
    this.pool = pool;
    this.dustSats = dustSats;
    /** roundId hex -> { sighash, hiding, binding, commitment, spent } */
    this.live = new Map();
  }

  get holdsAShare() { return !!(this.seat && this.pool && this.curve); }

  /**
   * WHAT THIS SEAT SAYS THE ROUND OWES, rebuilt from its own store every time.
   *
   * Never read back from the transaction it wrote and never taken from the
   * asker. §20 makes a node that signs a table which is not F(its inputs)
   * slashable, and the same reasoning applies with more force to the spend:
   * the table only says who is owed, the spend is where the money goes.
   */
  spendFor({ roundId, utxo, contract }) {
    if (!this.holdsAShare) return { ok: false, why: 'this node holds no share of the pool' };
    if (!utxo || !(utxo.txid instanceof Uint8Array) || utxo.txid.length !== 32)
      return { ok: false, why: 'that names no output to spend' };
    if (!Number.isInteger(utxo.vout) || utxo.vout < 0)
      return { ok: false, why: 'that names no output index to spend' };
    if (typeof utxo.value !== 'bigint' || utxo.value <= 0n)
      return { ok: false, why: 'an output with nothing in it pays nobody' };

    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'this node has queued no payout for that round' };
    if (row.state !== PAYOUT_QUEUED)
      return { ok: false, why: `this node's payout for that round is ${row.state}, not queued` };

    // THE TABLE, RECOMPUTED. Not the id off the row: a row is what this node
    // wrote down, and what it must sign against is what its own results say
    // now. The row is bookkeeping; the signatures below are the authority.
    //
    // RETRACTED, and the mutation is why: this also compared the recomputed id
    // with `row.tableId` and refused if they differed. No test could tell the
    // check on from the check off, and looking at why explains it - the
    // verification below asks the seats about the RECOMPUTED id, so a node
    // whose results moved on its own already fails there with "0 of 5". The
    // only state the extra comparison caught was a committee that had all
    // moved to the same new table while this node's row still named the old
    // one, and refusing there would be refusing a spend the committee agrees
    // on because a bookkeeping row is stale. A check no test can distinguish
    // and no reachable state needs is not a rule; it is a comment that throws.
    const entries = this.entriesFor(roundId);
    if (!entries.ok) return entries;
    const built = tableFor({ roundId, entries: entries.entries, minScore: contract.minScore });

    const seen = verifiedTable(this.round.payoutSignatures(roundId), {
      contract, seats: this.round.seats(roundId), tableId: built.tableId,
    });
    if (!seen.ok) return { ok: false, why: seen.why };
    if (!seen.final)
      return { ok: false, why: `${seen.agreed} of ${seen.needed} seats signed this table` };

    const owed = winnings({
      table: built.table,
      stakes: entries.entries.map((e) => ({ pubkey: e.pubkey, stakeMsat: e.stakeMsat })),
    });
    if (!owed.ok) return { ok: false, why: owed.why };
    if (!owed.rows.length) return { ok: false, why: 'that round owes nobody anything' };

    // AND IT IS THE POOL'S OWN OUTPUT. An asker who could name any output
    // could have the committee sign a spend of somebody else's coin - or of
    // an output the pool holds for a different round.
    const out = poolOutput({ groupPublicKey: this.pool.groupPublicKey, curve: this.curve });
    if (!out.ok) return { ok: false, why: out.why };
    // `poolOwns` answers with an OBJECT, and `if (!poolOwns(...))` is always
    // false - which is a check that never fires and a seat that signs a spend
    // of anybody's coin. Its own test caught it; the answer is read now.
    const owns = poolOwns(utxo.script, out.outputKey);
    if (!owns.ok)
      return { ok: false, why: `that output is not the pool this committee holds: ${owns.why}` };

    const spend = payoutOutputs({ rows: owed.rows, poolSats: utxo.value, dustSats: this.dustSats });
    if (!spend.ok) return { ok: false, why: spend.why };

    const inputs = [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd }];
    const prevouts = [{ value: utxo.value, script: out.script }];
    const sighash = tapSighash({ inputs, prevouts, outputs: spend.outputs, inputIndex: 0 });
    return {
      ok: true, sighash, inputs, outputs: spend.outputs, tableId: built.tableId,
      groupPublicKey: poolSigningKey(out.outputKey),
      share: poolShare({ share: this.seat.share, tweak: out.tweak, negated: out.negated }),
    };
  }

  /**
   * ROUND ONE: this seat's nonce commitment for that spend.
   *
   * Asking twice for the same spend gives the SAME commitment back rather than
   * a fresh pair, because a retry over a dropped connection is ordinary and a
   * second pair would leave the first one live with nothing to spend it on.
   * Asking for a DIFFERENT spend while a pair is live is refused: one seat is
   * one signature, and a seat holding two live pairs is a seat an asker can
   * walk into signing twice.
   */
  commit({ roundId, utxo, contract, random }) {
    const spend = this.spendFor({ roundId, utxo, contract });
    if (!spend.ok) return spend;

    const key = toHex(roundId);
    const held = this.live.get(key);
    if (held && held.spent)
      return { ok: false, why: 'this seat has already signed this round and keeps no second pair' };
    if (held) {
      if (!same(held.sighash, spend.sighash))
        return { ok: false, why: 'this seat is already committed to a different spend of this round' };
      return { ok: true, commitment: held.commitment, id: this.seat.id };
    }

    const hiding = nonceGenerate(random(32), spend.share);
    const binding = nonceGenerate(random(32), spend.share);
    const commitment = {
      id: this.seat.id,
      hiding: this.curve.pointFromScalar(hiding),
      binding: this.curve.pointFromScalar(binding),
    };
    this.live.set(key, { sighash: spend.sighash, hiding, binding, commitment, spent: false });
    return { ok: true, commitment, id: this.seat.id };
  }

  /**
   * ROUND TWO: this seat's signature share, over the spend it built itself.
   *
   * The sighash is recomputed here rather than remembered, so a store that
   * changed under the seat between the two rounds - a later result, a
   * different table - stops the signature instead of signing the older answer.
   *
   * THE COMMITMENT LIST IS PART OF WHAT IS SIGNED. It goes into the binding
   * factors and therefore into the challenge, so the same nonce pair over two
   * different lists is two signatures over two messages - the leak again,
   * wearing a different hat. A seat that has signed keeps the share it made
   * and hands the same bytes back for the same list; anything else is refused.
   */
  signatureShare({ roundId, utxo, contract, commitments }) {
    const key = toHex(roundId);
    const held = this.live.get(key);
    if (!held) return { ok: false, why: 'this seat committed to nothing for that round' };

    const spend = this.spendFor({ roundId, utxo, contract });
    if (!spend.ok) return spend;
    if (!same(held.sighash, spend.sighash))
      return { ok: false, why: 'this seat committed to a different spend of this round' };

    if (!Array.isArray(commitments) || !commitments.some((c) => String(c.id) === String(this.seat.id)))
      return { ok: false, why: 'this seat is not in the commitment list it was asked to sign under' };
    const mine = commitments.find((c) => String(c.id) === String(this.seat.id));
    if (!same(mine.hiding, held.commitment.hiding) || !same(mine.binding, held.commitment.binding))
      return { ok: false, why: 'that list carries a commitment this seat never made' };

    let list;
    try { list = encodeCommitmentList(commitments); }
    catch (err) { return { ok: false, why: err.message }; }

    if (held.spent) {
      if (!same(held.spent.list, list))
        return { ok: false, why: 'this seat has signed under another commitment list and will not sign twice' };
      return { ok: true, share: held.spent.share, id: this.seat.id };
    }

    const share = signShare340({
      id: this.seat.id, share: spend.share, groupPublicKey: spend.groupPublicKey,
      nonces: { hiding: held.hiding, binding: held.binding },
      message: spend.sighash, commitments, curve: this.curve,
    });
    // THE PAIR IS GONE THE MOMENT IT IS USED. Kept only as "spent, under this
    // list, for this share" - enough to answer a retry, not enough to sign.
    this.live.set(key, {
      sighash: held.sighash, commitment: held.commitment,
      hiding: null, binding: null, spent: { list, share },
    });
    return { ok: true, share, id: this.seat.id };
  }

  /**
   * The entries this node's own results describe, in the shape the table wants.
   *
   * A run this node never signed a result for is not in the table it computes,
   * which is the honest answer: a seat that filled in somebody else's verdict
   * would be signing a table it did not verify.
   */
  entriesFor(roundId) {
    const out = [];
    for (const { entryId, entry } of this.round.entriesOf(roundId)) {
      const mine = this.round.results(roundId, entryId)
        .find((r) => same(r.nodePubkey, this.round.pubkey));
      if (!mine) continue;
      let result;
      try { result = decodePlayerResult(splitSignedResult(mine.bytes).body); }
      catch { continue; }
      out.push({
        entryId, pubkey: result.playerPubkey, outcome: result.outcome,
        score: result.score, stakeMsat: entry.stakeMsat,
      });
    }
    if (!out.length)
      return { ok: false, why: 'this node signed no result for that round, so it computes no table' };
    return { ok: true, entries: out };
  }
}
