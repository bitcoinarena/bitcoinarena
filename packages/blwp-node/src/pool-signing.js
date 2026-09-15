// A SIGNER NODE'S HALF OF A SIGNING ROUND, AND THE SHARE NEVER LEAVES IT.
//
// Item 13 gave the pool a taproot output whose key is the committee's, and
// item 10 gave the committee a FROST signature. What neither gave it was a
// COMMITTEE: `Payouts#pay` takes `signers` - an array of `{ id, share }` - and
// makes every nonce and every signature share in one `map`, so five of seven
// was arithmetic inside one process and the number of keys that had to agree
// before a settled satoshi moved was still one.
//
// This is the other side. A signer node holds ONE share, it is never an argument to
// anything that crosses a wire, and what the signer node puts on the wire is a nonce
// commitment and then a signature share - two round trips, RFC 9591's own two
// rounds.
//
// THE RULE THAT MAKES THE THRESHOLD REAL: a signer node signs only a spend IT built.
//
// The obvious door takes a sighash and returns a share, and it is worthless.
// Five signatures over an attacker's 32 bytes spend the pool exactly as well
// as five over a real payout, so a committee that signs what it is handed has
// a threshold on paper and one key in practice. So nothing here accepts a
// sighash, a transaction, or a table. The asker names the round and the OUTPUT
// it wants spent - both facts anybody can check - and the signer node rebuilds the
// rest out of its own store: its own results, its own entries, its own table,
// the signatures its peers gave it. If that does not come to the same
// transaction the asker wanted, the asker gets no share and no explanation
// beyond which of its own checks failed.
//
// THE NONCES LIVE IN MEMORY AND DIE WITH THE PROCESS, on purpose. Signing two
// different messages under one nonce pair publishes the share - it is two
// equations in two unknowns - so the one thing that must never happen is a
// nonce being used twice. A pair that is never written down cannot come back
// after a restart to be used again; a restart simply costs the asker a signer node,
// and it can ask another. What IS remembered, for as long as the process
// lives, is which message a pair was made for and whether it has been spent,
// because the same pair asked to sign a second message is the same failure by
// a slower route.
import { winnings, payoutOutputs, DUST_SATS } from '../../protocol/src/payout-spend.js';
import { tapSighash } from '../../protocol/src/bond-spend.js';
import { poolOutput, poolPublicShare, poolShare, poolSigningKey, poolOwns } from '../../protocol/src/pool.js';
import { signShare340 } from '../../protocol/src/frost-bip340.js';
import { encodeCommitmentList } from '../../protocol/src/frost.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { toHex } from '../../protocol/src/hash.js';
import { scalarFrom32, scalarTo32 } from '../../protocol/src/shares.js';
import { tableFor, verifiedTable } from './payout-table.js';
import { PAYOUT_QUEUED, PAID, PAID_IN_PART } from './payout.js';

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * ONE SIGNER NODE, ONE SHARE.
 *
 * `signer node` is `{ id, share }` and it is this node's own. It is dealt today - a
 * dealerless DKG is its own letter and this one does not pretend to be it -
 * but from here on the dealt value stays where it was dealt.
 */
export class PoolSigning {
  constructor(round, { curve, signerNode = null, pool = null, dustSats = DUST_SATS, publicShares = null } = {}) {
    this.round = round;
    this.curve = curve;
    this.signerNode = signerNode;
    this.pool = pool;
    this.dustSats = dustSats;
    // EVERY SIGNER NODE'S PUBLIC SHARE of the key (a Map: signer node id -> point), from the
    // DKG's commitments - what a signature share is checked against, so a bad
    // one can be NAMED. A dealt pool is handed them with its shares.
    this.publicShares = publicShares;
  }

  /** A signer node's public share moved onto the pool's output key, or null if this signer node holds none. */
  signingPublicShare(id) {
    const P = this.publicShares instanceof Map ? this.publicShares.get(String(id)) : null;
    if (!P || !this.pool || !this.curve) return null;
    const out = poolOutput({ groupPublicKey: this.pool.groupPublicKey, curve: this.curve });
    if (!out.ok) return null;
    return poolPublicShare({ publicShare: P, tweak: out.tweak, negated: out.negated, curve: this.curve });
  }

  /**
   * WHAT THIS SIGNER NODE IS COMMITTED TO FOR A ROUND, OFF DISK.
   *
   * This was a `Map` on the object and letter 19 measured what that cost: a
   * committee that restarted between two asks minted FRESH nonces for a spend
   * it had already signed - a second signature over the same input, a second
   * txid, a conflicting spend of the pool. Before the restart the same ask
   * returned the same commitments and rebuilt the IDENTICAL transaction, which
   * is harmless. The whole difference was the memory, so the memory is a row.
   *
   * A row written by a DIFFERENT signer node is refused rather than used: a store
   * that somehow met another share must not sign with a pair that is not its
   * own.
   */
  held(roundId) {
    const row = this.round.poolNonce(roundId);
    if (!row) return null;
    if (String(row.signerNodeId) !== String(this.signerNode.id))
      return { wrongSignerNode: row.signerNodeId };
    return {
      attempt: row.attempt || 0,
      sighash: row.sighash,
      hiding: row.hiding === null ? null : scalarFrom32(row.hiding),
      binding: row.binding === null ? null : scalarFrom32(row.binding),
      commitment: { id: this.signerNode.id, hiding: row.commitHiding, binding: row.commitBinding },
      spent: row.spentShare === null
        ? false
        : { list: row.spentList, share: scalarFrom32(row.spentShare) },
    };
  }

  /** The same row, written. `hiding`/`binding` null once the pair is used. */
  keep(roundId, { sighash, hiding, binding, commitment, spent, attempt = 0 }) {
    return this.round.putPoolNonce({
      roundId, signerNodeId: this.signerNode.id, sighash,
      hiding: hiding === null ? null : scalarTo32(hiding),
      binding: binding === null ? null : scalarTo32(binding),
      commitHiding: commitment.hiding, commitBinding: commitment.binding,
      spentList: spent ? spent.list : null,
      spentShare: spent ? scalarTo32(spent.share) : null,
      attempt,
    });
  }

  get holdsAShare() { return !!(this.signerNode && this.pool && this.curve); }

  /**
   * WHAT THE ROUND OWES AND TO WHOM, WITHOUT AN OUTPUT TO SPEND IT FROM.
   *
   * The first half of `spendFor`, split out because the ASKER needs it before
   * it has a utxo: item 18's whole gap was that a close queued a payout and
   * stopped, because nothing could work out which of the pool's outputs was
   * big enough to pay the round. Choosing one needs the figure; building the
   * transaction needs the output. So the figure comes first and one copy of
   * the rule serves both - `spendFor` calls this rather than repeating it.
   *
   * Rebuilt from this node's own store every time and never read back off the
   * row it wrote: §20 makes a node that signs a table which is not F(its
   * inputs) slashable, and a stored number is not an input.
   */
  owes({ roundId, contract }) {
    const entries = this.entriesFor(roundId);
    if (!entries.ok) return entries;
    const built = tableFor({ roundId, entries: entries.entries, minScore: contract.minScore });

    const seen = verifiedTable(this.round.payoutSignatures(roundId), {
      contract, signerNodes: this.round.signerNodes(roundId), tableId: built.tableId,
    });
    if (!seen.ok) return { ok: false, why: seen.why };
    if (!seen.final)
      return { ok: false, why: `${seen.agreed} of ${seen.needed} signer nodes signed this table` };

    const owed = winnings({ table: built.table, stakes: entries.entries });
    if (!owed.ok) return { ok: false, why: owed.why };
    if (!owed.rows.length) return { ok: false, why: 'that round owes nobody anything' };

    // WHAT AN OUTPUT MUST COVER, in satoshis and rounded UP.
    //
    // `payoutOutputs` floors each row to whole satoshis and drops any row
    // under the relay floor, so the transaction always pays at most this - it
    // is an upper bound rather than the exact figure, and it is chosen that
    // way on purpose. A bound that could be a satoshi short would pick an
    // output the committee then refuses to sign against, which costs a whole
    // signing round to discover.
    const wantsSats = (owed.owedMsat + 999n) / 1000n;
    return { ok: true, rows: owed.rows, owedMsat: owed.owedMsat, wantsSats, tableId: built.tableId };
  }

  /**
   * WHAT THIS SIGNER NODE SAYS THE ROUND OWES, rebuilt from its own store every time.
   *
   * Never read back from the transaction it wrote and never taken from the
   * asker. §20 makes a node that signs a table which is not F(its inputs)
   * slashable, and the same reasoning applies with more force to the spend:
   * the table only says who is owed, the spend is where the money goes.
   */
  spendFor({ roundId, utxo, contract, settled = false }) {
    if (!this.holdsAShare) return { ok: false, why: 'this node holds no share of the pool' };
    if (!utxo || !(utxo.txid instanceof Uint8Array) || utxo.txid.length !== 32)
      return { ok: false, why: 'that names no output to spend' };
    if (!Number.isInteger(utxo.vout) || utxo.vout < 0)
      return { ok: false, why: 'that names no output index to spend' };
    if (typeof utxo.value !== 'bigint' || utxo.value <= 0n)
      return { ok: false, why: 'an output with nothing in it pays nobody' };

    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'this node has queued no payout for that round' };
    // A SIGNER NODE THAT HAS ALREADY SIGNED THIS ROUND STILL ANSWERS ABOUT IT.
    //
    // `settled` is passed only by `commit` and `signatureShare`, and only when
    // this signer node is already holding a pair for the round - so it relaxes
    // nothing about starting a spend, and everything it lets through is
    // checked again against the sighash the pair was made for.
    //
    // Letter 19 measured why. The signer node that broadcasts marks its own row PAID,
    // and that row is bookkeeping about ITS broadcast: with the state check
    // absolute, that signer node then refused to commit at all, the takeover
    // assembled a different five, and every signer node that had already signed
    // refused the new list by name. A transaction can be dropped from a
    // mempool - a low fee, an eviction, a restart - and the round still has to
    // be payable when it is.
    const paid = row.state === PAID || row.state === PAID_IN_PART;
    if (row.state !== PAYOUT_QUEUED && !(settled && paid))
      return { ok: false, why: `this node's payout for that round is ${row.state}, not queued` };

    // THE TABLE, RECOMPUTED. Not the id off the row: a row is what this node
    // wrote down, and what it must sign against is what its own results say
    // now. The row is bookkeeping; the signatures below are the authority.
    //
    // RETRACTED, and the mutation is why: this also compared the recomputed id
    // with `row.tableId` and refused if they differed. No test could tell the
    // check on from the check off, and looking at why explains it - the
    // verification below asks the signer nodes about the RECOMPUTED id, so a node
    // whose results moved on its own already fails there with "0 of 5". The
    // only state the extra comparison caught was a committee that had all
    // moved to the same new table while this node's row still named the old
    // one, and refusing there would be refusing a spend the committee agrees
    // on because a bookkeeping row is stale. A check no test can distinguish
    // and no reachable state needs is not a rule; it is a comment that throws.
    const owed = this.owes({ roundId, contract });
    if (!owed.ok) return owed;
    const built = { tableId: owed.tableId };

    // AND IT IS THE POOL'S OWN OUTPUT. An asker who could name any output
    // could have the committee sign a spend of somebody else's coin - or of
    // an output the pool holds for a different round.
    const out = poolOutput({ groupPublicKey: this.pool.groupPublicKey, curve: this.curve });
    if (!out.ok) return { ok: false, why: out.why };
    // `poolOwns` answers with an OBJECT, and `if (!poolOwns(...))` is always
    // false - which is a check that never fires and a signer node that signs a spend
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
      // Who this spend still leaves owed (under the relay floor), so a signer node can
      // tell PAID from PAID_IN_PART when it finds the spend on the chain.
      owed: spend.owed || [], owedSats: spend.owedSats || 0n,
      groupPublicKey: poolSigningKey(out.outputKey),
      share: poolShare({ share: this.signerNode.share, tweak: out.tweak, negated: out.negated }),
    };
  }

  /**
   * ROUND ONE: this signer node's nonce commitment for that spend.
   *
   * Asking twice for the same spend gives the SAME commitment back rather than
   * a fresh pair, because a retry over a dropped connection is ordinary and a
   * second pair would leave the first one live with nothing to spend it on.
   * Asking for a DIFFERENT spend while a pair is live is refused: one signer node is
   * one signature, and a signer node holding two live pairs is a signer node an asker can
   * walk into signing twice.
   */
  commit({ roundId, utxo, contract, random, attempt = 0 }) {
    // THE STORED PAIR IS READ FIRST, because whether this signer node already holds
    // one decides whether it may answer about a round its own row calls PAID.
    const held = this.held(roundId);
    const spend = this.spendFor({
      roundId, utxo, contract, settled: !!(held && !held.wrongSignerNode),
    });
    if (!spend.ok) return spend;

    if (held && held.wrongSignerNode)
      return { ok: false, why: `that round's pair was made by signer node ${held.wrongSignerNode}, not this one` };
    // A LATER SIGNING ATTEMPT OF THE SAME SPEND gets a FRESH pair. The one kept
    // is never used again - spent, or discarded unused - so no nonce ever signs
    // under two lists; a second signature over the SAME sighash is the same
    // transaction and the same txid. An older attempt is refused: it is over.
    if (held && attempt < held.attempt)
      return { ok: false, why: `this signer node has moved on to signing attempt ${held.attempt} of this round` };
    const fresh = !!held && attempt > held.attempt;
    if (fresh && !same(held.sighash, spend.sighash))
      return { ok: false, why: 'this signer node is already committed to a different spend of this round' };
    if (!fresh && held && held.spent) {
      // A SPENT PAIR STILL ANSWERS, and that is the whole of the takeover.
      // A second asker - the round's own, later, or a signer node taking over after
      // the wait - gets the SAME commitment back and rebuilds the same
      // transaction, byte for byte. It is not a competing spend; it is the
      // one that already exists, sent again, which a chain treats as a no-op.
      if (!same(held.sighash, spend.sighash))
        return { ok: false, why: 'this signer node has signed a different spend of this round and keeps no second pair' };
      return { ok: true, commitment: held.commitment, id: this.signerNode.id, again: true };
    }
    if (!fresh && held) {
      if (!same(held.sighash, spend.sighash))
        return { ok: false, why: 'this signer node is already committed to a different spend of this round' };
      return { ok: true, commitment: held.commitment, id: this.signerNode.id, again: true };
    }

    const hiding = nonceGenerate340(random(32), spend.share);
    const binding = nonceGenerate340(random(32), spend.share);
    const commitment = {
      id: this.signerNode.id,
      hiding: this.curve.pointFromScalar(hiding),
      binding: this.curve.pointFromScalar(binding),
    };
    this.keep(roundId, { sighash: spend.sighash, hiding, binding, commitment, spent: false, attempt });
    return { ok: true, commitment, id: this.signerNode.id };
  }

  /**
   * ROUND TWO: this signer node's signature share, over the spend it built itself.
   *
   * The sighash is recomputed here rather than remembered, so a store that
   * changed under the signer node between the two rounds - a later result, a
   * different table - stops the signature instead of signing the older answer.
   *
   * THE COMMITMENT LIST IS PART OF WHAT IS SIGNED. It goes into the binding
   * factors and therefore into the challenge, so the same nonce pair over two
   * different lists is two signatures over two messages - the leak again,
   * wearing a different hat. A signer node that has signed keeps the share it made
   * and hands the same bytes back for the same list; anything else is refused.
   */
  signatureShare({ roundId, utxo, contract, commitments, attempt = 0 }) {
    const held = this.held(roundId);
    if (!held) return { ok: false, why: 'this signer node committed to nothing for that round' };
    if (held.wrongSignerNode)
      return { ok: false, why: `that round's pair was made by signer node ${held.wrongSignerNode}, not this one` };
    if (held.attempt !== attempt)
      return { ok: false, why: `this signer node committed to signing attempt ${held.attempt} of this round, not ${attempt}` };

    const spend = this.spendFor({ roundId, utxo, contract, settled: true });
    if (!spend.ok) return spend;
    if (!same(held.sighash, spend.sighash))
      return { ok: false, why: 'this signer node committed to a different spend of this round' };

    if (!Array.isArray(commitments) || !commitments.some((c) => String(c.id) === String(this.signerNode.id)))
      return { ok: false, why: 'this signer node is not in the commitment list it was asked to sign under' };
    const mine = commitments.find((c) => String(c.id) === String(this.signerNode.id));
    if (!same(mine.hiding, held.commitment.hiding) || !same(mine.binding, held.commitment.binding))
      return { ok: false, why: 'that list carries a commitment this signer node never made' };

    let list;
    try { list = encodeCommitmentList(commitments); }
    catch (err) { return { ok: false, why: err.message }; }

    if (held.spent) {
      if (!same(held.spent.list, list))
        return { ok: false, why: 'this signer node has signed under another commitment list and will not sign twice' };
      return { ok: true, share: held.spent.share, id: this.signerNode.id };
    }

    const share = signShare340({
      id: this.signerNode.id, share: spend.share, groupPublicKey: spend.groupPublicKey,
      nonces: { hiding: held.hiding, binding: held.binding },
      message: spend.sighash, commitments, curve: this.curve,
    });
    // THE PAIR IS GONE THE MOMENT IT IS USED. Kept only as "spent, under this
    // list, for this share" - enough to answer a retry, not enough to sign -
    // and kept ON DISK, so a restart cannot turn a retry into a second
    // signature over the same input.
    this.keep(roundId, {
      sighash: held.sighash, commitment: held.commitment,
      hiding: null, binding: null, spent: { list, share }, attempt: held.attempt,
    });
    return { ok: true, share, id: this.signerNode.id };
  }

  /**
   * The entries this node's own results describe, in the shape the table wants.
   *
   * A run this node never signed a result for is not in the table it computes,
   * which is the honest answer: a signer node that filled in somebody else's verdict
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
        feeMsat: entry.feeMsat, donationMsat: entry.donationMsat,
      });
    }
    if (!out.length)
      return { ok: false, why: 'this node signed no result for that round, so it computes no table' };
    return { ok: true, entries: out };
  }
}
