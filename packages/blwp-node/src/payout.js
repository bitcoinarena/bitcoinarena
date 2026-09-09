// 9.4'S QUALIFYING TAIL: PAYOUT_QUEUED -> PAID.
//
// The losing branch has settled stakes into the pool since M3.1 and item 13
// gave the pool a taproot output five of seven can spend. What was missing is
// the half that decides WHAT to spend it on: measured before this file,
// `AWAITING_INVOICE`, `CANCEL_REQUESTED`, `PAYOUT_QUEUED` and `PAID` were in no
// source file, so a delivered player got their own stake back and was never
// paid a winning.
//
// TWO THRESHOLDS AND THEY ARE NOT THE SAME ONE.
//
//   the results are final    5-of-7 signed results, per run, already built
//   the TABLE is final       5-of-7 signed table ids (§20), which is this file
//   the spend is authorised  5-of-7 FROST shares over the sighash (item 10)
//
// A node can agree a player lost and still disagree about the arithmetic that
// pays the winner, and money leaves on the second.
//
// EVERY TRANSITION IS ON DISK BEFORE THE CALL. `PAYOUT_QUEUED` is written
// before a byte is broadcast, so a node that died between the two comes back
// knowing a transaction may be out there - and asks the chain, rather than
// building a second one that spends the same output to different people.
import { computePayoutTable } from '../../protocol/src/payout.js';
import { winnings, payoutOutputs, DUST_SATS } from '../../protocol/src/payout-spend.js';
import { tapSighash, serializeSpend } from '../../protocol/src/bond-spend.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { poolOutput, poolShare, poolSigningKey, poolWitness } from '../../protocol/src/pool.js';
import { signShare340, aggregate340, enoughToSign } from '../../protocol/src/frost-bip340.js';
import { nonceGenerate } from '../../protocol/src/frost.js';
import { SHARES_NEEDED } from '../../protocol/src/shares.js';
import { tableFor, signPayoutTable, verifiedTable, splitSignedTable } from './payout-table.js';
import { toHex } from '../../protocol/src/hash.js';
import { encodeUtxo, decodeCommitments, decodeShare, encodeShareRequest } from './pool-wire.js';

/** 9.4's two words for the qualifying tail, and they are states now. */
export const PAYOUT_QUEUED = 'PAYOUT_QUEUED';
export const PAID = 'PAID';
export const NOTHING_OWED = 'NOTHING_OWED';
/**
 * PAID WHAT COULD BE PAID, AND STILL SHORT.
 *
 * A round with a winner under the relay floor is not PAID: the outputs that
 * could be made were made and the rest is written down as owed. Calling it
 * PAID would be the operator deciding a debt does not exist because it is
 * small, which is the one thing 23.2 refuses to let inaction do.
 */
export const PAID_IN_PART = 'PAID_IN_PART';

/**
 * The round's own payout, from a FINAL result to sats on a chain.
 *
 * `pool` is the committee's key material and the output it holds; `chain`
 * broadcasts and looks. Both are injected for the same reason the Lightning
 * port and the curve are - what is decided here is which transaction is right,
 * not how to reach a node.
 */
export class Payouts {
  constructor(round, { curve, chain = null, pool = null, random, peers = [], fetcher = null } = {}) {
    this.round = round;
    this.fetcher = fetcher;
    this.curve = curve;
    this.chain = chain;
    this.pool = pool;
    this.random = random;
    this.peers = peers;
  }

  get canSpend() { return !!(this.chain && this.pool); }

  /**
   * WHAT THIS NODE SAYS THE ROUND OWES, AND ITS SIGNATURE OVER IT.
   *
   * Recomputed from this node's own inputs every time - never read back from
   * the row it wrote - because §20 makes a node that signs a table which is
   * not F(its inputs) slashable, and a cached table is a table nobody
   * recomputed.
   */
  sign({ roundId, entries, minScore }) {
    const built = tableFor({ roundId, entries, minScore });
    const record = signPayoutTable({
      tableId: built.tableId,
      secret: this.round.identity.secret,
      pubkey: this.round.pubkey,
    });
    this.round.putPayoutSignature(roundId, this.round.pubkey, record);
    return { ...built, record };
  }

  /** Ask the other seats what they signed, and keep only what verifies. */
  async gather({ roundId }) {
    let fetched = 0, kept = 0, refused = 0;
    for (const peer of this.peers) {
      let body;
      try {
        const got = await this.chainFetch(`${peer}/payout?round=${toHex(roundId)}`);
        if (!got.ok) { refused++; continue; }
        body = new Uint8Array(await got.arrayBuffer());
      } catch { refused++; continue; }
      for (let at = 0; at + 128 <= body.length; at += 128) {
        fetched++;
        const record = body.subarray(at, at + 128);
        let split;
        try { split = splitSignedTable(record); } catch { continue; }
        this.round.putPayoutSignature(roundId, split.nodePubkey, record);
        kept++;
      }
    }
    return { fetched, kept, refused };
  }

  /** Injected so a test can answer without a network. */
  chainFetch(url, options) { return (this.fetcher || fetch)(url, options); }

  /** Everything this node holds for a round, for the seat that asks. */
  records(roundIdBytes) { return this.round.payoutSignatures(roundIdBytes).map((r) => r.bytes); }

  /**
   * QUEUE THE PAYOUT IF THE COMMITTEE AGREES, and write that down first.
   *
   * A round that owes nobody anything is NOT queued and not an error: every
   * round where nobody delivered is one of those, and there is nothing to
   * spend.
   */
  queue({ roundId, entries, minScore, contract }) {
    const built = this.sign({ roundId, entries, minScore });
    const seen = verifiedTable(this.round.payoutSignatures(roundId), {
      contract, seats: this.round.seats(roundId), tableId: built.tableId,
    });
    if (!seen.ok) return { ok: false, why: seen.why };
    if (!seen.final)
      return { ok: false, agreed: seen.agreed, needed: seen.needed, why: seen.why };

    const owed = winnings({
      table: built.table,
      stakes: entries.map((e) => ({ pubkey: e.pubkey, stakeMsat: e.stakeMsat })),
    });
    if (!owed.ok) return { ok: false, why: owed.why };
    if (!owed.rows.length) {
      this.round.putPayout({
        roundId, tableId: built.tableId, state: NOTHING_OWED,
        why: 'the committee agreed this round owes nobody anything',
      });
      return { ok: true, state: NOTHING_OWED, agreed: seen.agreed, rows: 0 };
    }

    this.round.putPayout({
      roundId, tableId: built.tableId, state: PAYOUT_QUEUED,
      why: `${seen.agreed} of ${seen.needed} seats signed this table; ${owed.owedMsat} msat owed`,
    });
    return { ok: true, state: PAYOUT_QUEUED, tableId: built.tableId,
      table: built.table, rows: owed.rows, owedMsat: owed.owedMsat, agreed: seen.agreed };
  }

  /**
   * THE SAME SPEND, SIGNED BY A COMMITTEE INSTEAD OF BY A PROCESS.
   *
   * `pay` below takes `signers` - five SECRET scalars - and makes every nonce
   * and every share itself. That is the arithmetic of a threshold without the
   * threshold: whoever runs it can sign anything. This asks instead, and what
   * it asks for is the only two things a seat will put on a wire.
   *
   * IT IS AN ASKER, NOT AN AUTHORITY. Every seat rebuilds the transaction from
   * its own store before it commits to anything, so this node cannot talk the
   * committee into a spend of its own devising - the most it can do is name an
   * output and be told no. It does not even build the bytes it broadcasts from
   * its own opinion: `signing.spendFor` is this node's seat answering the same
   * question the others answered, and a node that disagreed with the committee
   * would produce a signature that does not verify rather than a transaction
   * nobody agreed to.
   *
   * `signing` is handed in rather than imported so this file keeps knowing
   * nothing about how a seat holds a share.
   */
  async payWithCommittee({ roundId, utxo, contract, signing, seats = [], needed = SHARES_NEEDED }) {
    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'that round has no queued payout' };
    if (row.state === PAID || row.state === PAID_IN_PART)
      return { ok: true, state: row.state, txid: row.txid, already: true };
    if (row.state !== PAYOUT_QUEUED)
      return { ok: false, why: `that payout is ${row.state}, so there is nothing to send` };
    if (!this.chain) return { ok: false, why: 'this node reaches no chain, so it spends nothing' };

    const mine = signing.spendFor({ roundId, utxo, contract });
    if (!mine.ok) return { ok: false, why: `this seat will not sign it either: ${mine.why}` };

    const body = encodeUtxo(utxo);
    const asked = [];
    const own = signing.commit({ roundId, utxo, contract, random: this.random });
    if (own.ok) asked.push({ where: 'this seat', commitment: own.commitment });
    const refused = [];
    for (const peer of seats) {
      if (asked.length >= needed) break;
      const got = await this.askSeat(`${peer}/pool/commit?round=${toHex(roundId)}`, body);
      if (!got.ok) { refused.push(`${peer}: ${got.why}`); continue; }
      let one;
      try { one = decodeCommitments(got.bytes); }
      catch (err) { refused.push(`${peer}: ${err.message}`); continue; }
      if (one.length !== 1) { refused.push(`${peer}: answered with ${one.length} commitments`); continue; }
      asked.push({ where: peer, commitment: one[0] });
    }
    if (asked.length < needed)
      return { ok: false, committed: asked.length, needed,
        why: `${asked.length} of ${needed} seats committed to this spend`, refused };

    const commitments = asked.map((a) => a.commitment);
    const shares = [];
    if (own.ok) {
      const got = signing.signatureShare({ roundId, utxo, contract, commitments });
      if (!got.ok) return { ok: false, why: `this seat withdrew: ${got.why}` };
      shares.push(got.share);
    }
    for (const a of asked) {
      if (a.where === 'this seat') continue;
      const got = await this.askSeat(`${a.where}/pool/share?round=${toHex(roundId)}`,
        encodeShareRequest(utxo, commitments));
      if (!got.ok)
        return { ok: false, why: `${a.where} committed and then would not sign: ${got.why}` };
      try { shares.push(decodeShare(got.bytes)); }
      catch (err) { return { ok: false, why: `${a.where}: ${err.message}` }; }
    }

    const sig = aggregate340({
      commitments, message: mine.sighash, groupPublicKey: mine.groupPublicKey, shares, curve: this.curve,
    });
    const raw = serializeSpend({
      inputs: mine.inputs, outputs: mine.outputs, witnesses: [poolWitness(sig.signature)],
    });

    // ON DISK BEFORE THE WIRE, the same rule `pay` keeps.
    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAYOUT_QUEUED, raw,
      why: `${shares.length} of ${needed} seats signed this spend; about to send`,
    });
    const sent = await this.chain.send(raw);
    if (!sent.ok) return { ok: false, why: sent.why, raw, signed: shares.length };

    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAID, txid: sent.txid, raw,
      why: `paid by ${shares.length} of ${needed} seats`,
    });
    return { ok: true, state: PAID, txid: sent.txid, raw, signed: shares.length,
      seats: asked.map((a) => a.where) };
  }

  /** One ask of one seat, and a refusal is an answer rather than a throw. */
  async askSeat(url, body) {
    let got;
    try { got = await this.chainFetch(url, { method: 'POST', body }); }
    catch (err) { return { ok: false, why: err.message }; }
    if (!got.ok) {
      let why = `HTTP ${got.status}`;
      try { why = (await got.text()).trim() || why; } catch { /* the status is the answer */ }
      return { ok: false, why };
    }
    return { ok: true, bytes: new Uint8Array(await got.arrayBuffer()) };
  }

  /**
   * SPEND THE POOL AGAINST THE TABLE THE COMMITTEE AGREED ON.
   *
   * The raw transaction is written down BEFORE it is broadcast, so a node that
   * died mid-send comes back with the exact bytes to ask the chain about
   * rather than a second transaction spending the same output elsewhere.
   */
  async pay({ roundId, rows, utxo, signers, dustSats = DUST_SATS }) {
    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'that round has no queued payout' };
    if (row.state === PAID || row.state === PAID_IN_PART)
      return { ok: true, state: row.state, txid: row.txid, already: true,
        owedSats: row.owedSats, owedCount: row.owedCount };
    if (row.state !== PAYOUT_QUEUED)
      return { ok: false, why: `that payout is ${row.state}, so there is nothing to send` };
    if (!this.canSpend) return { ok: false, why: 'this node reaches no chain, so it spends nothing' };

    const enough = enoughToSign({
      commitments: signers.map((s) => ({ id: s.id })), needed: SHARES_NEEDED,
    });
    if (!enough.ok) return { ok: false, why: enough.why };

    const out = poolOutput({ groupPublicKey: this.pool.groupPublicKey, curve: this.curve });
    if (!out.ok) return { ok: false, why: out.why };

    const built = payoutOutputs({ rows, poolSats: utxo.value, dustSats });
    if (!built.ok) {
      // NOBODY CLEARS THE FLOOR. There is no transaction to make, and the
      // debt is the whole of what happened - written down rather than lost.
      if (built.owed && built.owed.length)
        this.round.putPayout({
          roundId, tableId: row.tableId, state: PAYOUT_QUEUED,
          owedSats: built.owedSats, owedCount: built.owed.length, why: built.why,
        });
      return { ok: false, why: built.why, owed: built.owed, owedSats: built.owedSats };
    }

    const inputs = [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd }];
    const prevouts = [{ value: utxo.value, script: out.script }];
    const sighash = tapSighash({ inputs, prevouts, outputs: built.outputs, inputIndex: 0 });

    const groupPublicKey = poolSigningKey(out.outputKey);
    const round1 = signers.map((s) => {
      const share = poolShare({ share: s.share, tweak: out.tweak, negated: out.negated });
      const hiding = nonceGenerate(this.random(32), share);
      const binding = nonceGenerate(this.random(32), share);
      return { id: s.id, share, hiding, binding,
        commitment: { id: s.id,
          hiding: this.curve.pointFromScalar(hiding),
          binding: this.curve.pointFromScalar(binding) } };
    });
    const commitments = round1.map((s) => s.commitment);
    const shares = round1.map((s) => signShare340({
      id: s.id, share: s.share, groupPublicKey,
      nonces: { hiding: s.hiding, binding: s.binding },
      message: sighash, commitments, curve: this.curve,
    }));
    const sig = aggregate340({ commitments, message: sighash, groupPublicKey, shares, curve: this.curve });
    const raw = serializeSpend({
      inputs, outputs: built.outputs, witnesses: [poolWitness(sig.signature)],
    });

    // ON DISK BEFORE THE WIRE.
    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAYOUT_QUEUED, raw,
      why: `${built.paidSats} sats to ${built.outputs.length}, ${built.feeSats} left as fee; about to send`,
    });

    const sent = await this.chain.send(raw);
    if (!sent.ok) return { ok: false, why: sent.why, raw };

    // A ROUND THAT STILL OWES SOMEBODY IS NOT PAID. The sats stayed in the
    // pool because no node would relay an output that small; the debt is on
    // the row so nobody has to remember it.
    const short = built.owed.length > 0;
    this.round.putPayout({
      roundId, tableId: row.tableId, state: short ? PAID_IN_PART : PAID, raw,
      txid: parseTransaction(raw).txid,
      owedSats: built.owedSats, owedCount: built.owed.length,
      why: short
        ? `paid ${built.paidSats} sats to ${built.outputs.length} player(s); `
          + `${built.owed.length} still owed ${built.owedSats} sats, under the relay floor`
        : `paid ${built.paidSats} sats to ${built.outputs.length} player(s)`,
    });
    return {
      ok: true, state: short ? PAID_IN_PART : PAID, txid: sent.txid,
      paidSats: built.paidSats, feeSats: built.feeSats,
      owed: built.owed, owedSats: built.owedSats,
    };
  }

  /**
   * ASK THE CHAIN ABOUT ANYTHING THIS NODE DIED IN THE MIDDLE OF SENDING.
   *
   * The same shape as `Custody.reconcile`, and for the same reason: the only
   * party that knows whether a transaction went out is the network. A node
   * that assumed it did not would build a second spend of one output.
   */
  async reconcile() {
    if (!this.canSpend)
      return { ok: false, why: 'this node reaches no chain, so it asks it nothing' };
    const asked = [];
    for (const row of this.round.payoutsInState(PAYOUT_QUEUED)) {
      if (!row.raw) continue;
      const txid = parseTransaction(row.raw).txid;
      const seen = await this.chain.look(txid);
      if (seen && seen.known) {
        this.round.putPayout({
          roundId: row.roundId, tableId: row.tableId, state: PAID, txid, raw: row.raw,
          why: 'this node died mid-send; the chain already has that transaction',
        });
        asked.push({ roundId: row.roundId, state: PAID });
      } else {
        asked.push({ roundId: row.roundId, state: PAYOUT_QUEUED });
      }
    }
    return { ok: true, asked };
  }

  /** What this node believes about a round's payout, for an operator who asks. */
  stateOf(roundId) { return this.round.payout(roundId); }
}

export { computePayoutTable };
