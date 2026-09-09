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

/** 9.4's two words for the qualifying tail, and they are states now. */
export const PAYOUT_QUEUED = 'PAYOUT_QUEUED';
export const PAID = 'PAID';
export const NOTHING_OWED = 'NOTHING_OWED';

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
  chainFetch(url) { return (this.fetcher || fetch)(url); }

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
   * SPEND THE POOL AGAINST THE TABLE THE COMMITTEE AGREED ON.
   *
   * The raw transaction is written down BEFORE it is broadcast, so a node that
   * died mid-send comes back with the exact bytes to ask the chain about
   * rather than a second transaction spending the same output elsewhere.
   */
  async pay({ roundId, rows, utxo, signers, dustSats = DUST_SATS }) {
    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'that round has no queued payout' };
    if (row.state === PAID) return { ok: true, state: PAID, txid: row.txid, already: true };
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
    if (!built.ok) return { ok: false, why: built.why };

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

    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAID, raw,
      txid: parseTransaction(raw).txid,
      why: `paid ${built.paidSats} sats to ${built.outputs.length} player(s)`,
    });
    return { ok: true, state: PAID, txid: sent.txid, paidSats: built.paidSats, feeSats: built.feeSats };
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
