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
import { signShare340, aggregate340, enoughToSign, verifyShare340 } from '../../protocol/src/frost-bip340.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { tableFor, signPayoutTable, verifiedTable, splitSignedTable } from './payout-table.js';
import { toHex } from '../../protocol/src/hash.js';
import { timed } from './slow.js';
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
 * WHICH SIGNER NODE ASKS FOR A ROUND'S PAYOUT, AND IT IS EXACTLY ONE.
 *
 * `payWithCommittee` is an asker: it names an output, collects five nonce
 * commitments and five shares, aggregates them and broadcasts. Every signer node on
 * the committee closes the round, so if every signer node asked, five of them would
 * run five signing rounds over ONE output. FROST aggregates over the nonces
 * that were committed, so those five are five DIFFERENT transactions spending
 * the same input: one confirms and four are double-spends the chain refuses -
 * and every signer node can only hold one live nonce pair per round, so in practice
 * the five askers deadlock each other instead.
 *
 * So the asker is chosen from the round itself, the way everything else here
 * is: the signer nodes in the order the store keeps them - by pubkey, which no signer node
 * chooses - indexed by the round id. No message, no election, no clock, and
 * every signer node computes the same answer from facts it already holds.
 *
 * WHAT THIS DOES NOT DO is hand the round to somebody else when the asker is
 * down. That needs a clock and a rule for how long to wait, and inventing one
 * here would be inventing the protocol. The round stays PAYOUT_QUEUED, which
 * is a state an operator can see, and it is its own line on the list.
 */
export function askerFor(roundId, signerNodes) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32)
    return { ok: false, why: 'that is not a round id' };
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    return { ok: false, why: 'that round joined nobody, so nobody asks for it' };
  // Four bytes of the round id, big-endian and unsigned. `>>> 0` because a
  // top bit set would otherwise make this negative and the modulo with it.
  const n = ((roundId[0] << 24 | roundId[1] << 16 | roundId[2] << 8 | roundId[3]) >>> 0) % signerNodes.length;
  return { ok: true, asker: signerNodes[n], at: n, of: signerNodes.length };
}

/**
 * HOW LONG A SIGNER NODE GETS BEFORE THE NEXT ONE MAY TRY, IN BITCOIN BLOCKS.
 *
 * Small on purpose. A spend broadcast at the front of its window is normally
 * in the next block, and the signer node behind re-reads the output through
 * `gettxout` - which sees a mempool - before it asks at all, so the wait is
 * not there to let a transaction confirm. It is there so two signer nodes do not
 * start the same signing round in the same instant on the ordinary path.
 *
 * Blocks and not milliseconds: every signer node reads one chain and agrees without
 * talking, where two wall clocks a minute apart both take over.
 */
export const TAKEOVER_BLOCKS = 2;

/**
 * THE ORDER SIGNER NODES TAKE OVER IN, AND NO SIGNER NODE CHOOSES ITS OWN PLACE.
 *
 * `askerFor` names the first. The rest follow it around the ring, so the order
 * is a rotation of the signer nodes the store already keeps sorted BY PUBKEY - which
 * no signer node picks - starting at an index taken from the round id, which is a
 * hash of a contract signed before the round ran. There is nothing here a node
 * can grind: to move up the order it would have to change the round id, and
 * that is a different round.
 */
export function askerOrder(roundId, signerNodes) {
  const first = askerFor(roundId, signerNodes);
  if (!first.ok) return first;
  const order = signerNodes.map((_, i) => signerNodes[(first.at + i) % signerNodes.length]);
  return { ok: true, order, at: first.at, of: signerNodes.length };
}

/**
 * WHICH SIGNER NODES MAY ASK AT THIS BLOCK HEIGHT, AND WHEN THE NEXT ONE MAY.
 *
 * ITEM 19. The asker is picked from the round id, so a signer node that is offline
 * when its round closes leaves the payout at PAYOUT_QUEUED with the other six
 * correctly waiting - and a signer node that never comes back strands the round for
 * ever. Somebody has to be allowed to take over, and the question that decides
 * the shape is what they take over WITH.
 *
 * THE CLOCK IS THE ROUND'S OWN BEACON HEIGHT, which is not a new time source:
 * a round that has no randomness beacon cannot be seeded and cannot be played,
 * so every signer node already holds this number and holds the same one. Wall clocks
 * are per-node - two signer nodes a minute apart would both take over - and the
 * pool output's own confirmations are the wrong anchor, because a pool funded
 * long before the round closes is already deep and every signer node would be
 * eligible at once.
 *
 * Signer node k in the order above may ask once the chain has advanced
 * `k * TAKEOVER_BLOCKS` past the beacon. The round's own asker is k = 0 and is
 * therefore uniquely eligible the moment the round closes.
 *
 * SEVERAL SIGNER NODES ELIGIBLE AT ONCE IS NORMAL AND HARMLESS, and it is worth
 * saying because it looks like the fault. After a long outage the chain is far
 * past the beacon and most of the ring may ask. They do not compete: every
 * signer node's nonce pair is on disk, so a second asker collects the SAME
 * commitments and rebuilds the transaction byte for byte. Measured - before
 * the pair was durable, a restarted committee signed the same spend with
 * different signature bytes; now it is identical.
 */
export function eligibleAsker({ roundId, signerNodes, beaconHeight, tipHeight,
  takeoverBlocks = TAKEOVER_BLOCKS }) {
  const ring = askerOrder(roundId, signerNodes);
  if (!ring.ok) return ring;
  if (!Number.isInteger(beaconHeight) || beaconHeight < 0)
    return { ok: false, why: 'that round names no beacon height to wait from' };
  if (!Number.isInteger(tipHeight) || tipHeight < 0)
    return { ok: false, why: 'this node has no chain tip to measure the wait against' };
  if (!Number.isInteger(takeoverBlocks) || takeoverBlocks <= 0)
    return { ok: false, why: 'a takeover wait is a positive number of blocks' };

  const advanced = tipHeight - beaconHeight;
  const openFor = (k) => advanced >= Math.imul(k, takeoverBlocks);
  const allowed = ring.order.filter((_, k) => openFor(k));
  const next = ring.order.length > allowed.length ? allowed.length : null;
  return {
    ok: true,
    order: ring.order,
    allowed,
    advanced,
    // The height at which the next signer node in the ring joins in, so a refusal can
    // say when rather than only no.
    nextAt: next === null ? null : beaconHeight + Math.imul(next, takeoverBlocks),
    placeOf: (key) => ring.order.findIndex((k) => toHex(k) === toHex(key)),
  };
}

/**
 * The round's own payout, from a FINAL result to sats on a chain.
 *
 * `pool` is the committee's key material and the output it holds; `chain`
 * broadcasts and looks. Both are injected for the same reason the Lightning
 * port and the curve are - what is decided here is which transaction is right,
 * not how to reach a node.
 */
export class Payouts {
  constructor(round, { curve, chain = null, pool = null, random, peers = [], fetcher = null,
    randomnessFor = null, peersFor = null } = {}) {
    this.round = round;
    // THE ROUND'S CHAIN CLOCK, injected the way the roster's and the
    // verifier's are. Item 19 waits on it; a node given none never takes over.
    this.randomnessFor = randomnessFor;
    this.fetcher = fetcher;
    this.curve = curve;
    this.chain = chain;
    this.pool = pool;
    this.random = random;
    this.peers = peers;
    // THE ROUND'S OWN SETTLEMENT SIGNER NODES at a live close, when no list was given:
    // measured before, "1 of 2 signer nodes signed this table" on both daemons.
    this.peersFor = peersFor;
  }

  /** Who to ask for a round's table signatures: a given list, else the census's. */
  peersOf(roundIdBytes) {
    if (this.peers && this.peers.length) return this.peers;
    if (typeof this.peersFor !== 'function') return [];
    try { return this.peersFor(roundIdBytes) || []; } catch { return []; }
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

  /** Ask the other signer nodes what they signed, and keep only what verifies. */
  async gather({ roundId }) {
    let fetched = 0, kept = 0, refused = 0;
    const peers = timed('payout peersOf', () => this.peersOf(roundId), { over: 20 });
    for (const peer of peers) {
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

  /** Everything this node holds for a round, for the signer node that asks. */
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
      contract, signerNodes: this.round.signerNodes(roundId), tableId: built.tableId,
    });
    if (!seen.ok) return { ok: false, why: seen.why };
    if (!seen.final)
      return { ok: false, agreed: seen.agreed, needed: seen.needed, why: seen.why };

    // A ROW THAT HAS MOVED ON STAYS WHERE IT IS. A round's close logic runs
    // again when a run turns final after the first close (M3.3-25), and this
    // wrote its row with INSERT OR REPLACE - measured: a PAID round put back to
    // PAYOUT_QUEUED. What was queued, paid or found owing nothing is answered
    // as it stands.
    const had = this.round.payout(roundId);
    if (had && [PAYOUT_QUEUED, PAID, PAID_IN_PART, NOTHING_OWED].includes(had.state))
      return { ok: true, state: had.state, already: true, tableId: had.tableId,
        agreed: seen.agreed, needed: seen.needed };

    const owed = winnings({ table: built.table, stakes: entries });
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
      why: `${seen.agreed} of ${seen.needed} signer nodes signed this table; ${owed.owedMsat} msat owed`,
    });
    return { ok: true, state: PAYOUT_QUEUED, tableId: built.tableId,
      table: built.table, rows: owed.rows, owedMsat: owed.owedMsat, agreed: seen.agreed };
  }

  /**
   * A QUEUED PAYOUT, THROUGH TO THE CHAIN, WITH NO OPERATOR IN THE MIDDLE.
   *
   * ITEM 18, AND THE MEASUREMENT IT WAS OPENED ON: `payWithCommittee` had zero
   * callers in `src/`. A close signed the table, agreed what was owed, wrote
   * PAYOUT_QUEUED and stopped, because nothing in the daemon could say WHICH
   * of the pool's outputs to spend - the winner was paid by a test handing the
   * daemon an outpoint. `pool-watch.js` closed the first half of that (the
   * daemon can ask the chain); this is the caller.
   *
   * Three things have to be true and each refuses by name rather than by
   * silence: this node reaches a chain, this node is the round's asker, and
   * the pool holds exactly one confirmed output that covers what is owed.
   *
   * THE FIGURE IS THE SIGNER NODE'S OWN. `signing.owes` rebuilds it from this node's
   * results and the committee's signatures - not from the row, which is
   * bookkeeping - so the output this asks for is sized by the same rule that
   * decides the outputs it will later sign.
   */
  async settleQueued({ roundId, contract, signing, watch, minConfirmations = 1,
    takeoverBlocks = TAKEOVER_BLOCKS }) {
    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'that round has no queued payout' };
    if (row.state === PAID || row.state === PAID_IN_PART)
      return { ok: true, state: row.state, txid: row.txid, already: true };
    if (row.state !== PAYOUT_QUEUED)
      return { ok: false, why: `that payout is ${row.state}, so there is nothing to send` };
    if (!this.chain) return { ok: false, why: 'this node reaches no chain, so it spends nothing' };
    if (!watch || !watch.reaches)
      return { ok: false, why: 'this node watches no pool, so it can name no output to spend' };
    if (!signing || typeof signing.owes !== 'function')
      return { ok: false, why: 'this node holds no signer node, so it asks for nothing' };

    // WHOSE TURN IT IS, AT THIS BLOCK HEIGHT.
    //
    // The round's own asker is first and alone; every other signer node waits
    // `TAKEOVER_BLOCKS` more blocks past the round's beacon than the one in
    // front of it. That is letter 19: without it a signer node that never comes back
    // strands the payout at PAYOUT_QUEUED for ever.
    const signerNodes = this.round.signerNodes(roundId);
    const me = this.round.pubkey;
    const beaconHeight = await this.beaconHeightFor(roundId, contract);
    if (!beaconHeight.ok) return beaconHeight;
    const tip = await watch.tip();
    if (!tip.ok) return tip;

    // THE POOL MAY ALREADY BE PAID, and that is asked BEFORE whose turn it is:
    // a signer node that is not the asker never sends the payment, so its row stayed
    // PAYOUT_QUEUED while the chain carried it - measured: 6 of 6 other signer nodes
    // at every kill point, the returning asker included. If a transaction since
    // the round's beacon spent this pool and pays EXACTLY the outputs this
    // signer node's own table computes for that input, it is recorded. A spend paying
    // anything else is refused by name and changes nothing.
    const onChain = await this.paidOnChain({ roundId, contract, signing, watch, fromHeight: beaconHeight.height });
    if (onChain) return onChain;

    const turn = eligibleAsker({
      roundId, signerNodes, beaconHeight: beaconHeight.height, tipHeight: tip.height, takeoverBlocks,
    });
    if (!turn.ok) return turn;
    const place = turn.placeOf(me);
    if (place < 0)
      return { ok: false, why: 'this node is not assigned to that round, so it does not ask for it' };
    if (place >= turn.allowed.length)
      return {
        ok: false, waiting: true, place, advanced: turn.advanced, nextAt: turn.nextAt,
        why: place === 0
          ? 'this node is the round\'s asker and the chain has not reached the beacon yet'
          : `this node is ${place} of ${turn.order.length} in the takeover order and may ask at `
            + `height ${beaconHeight.height + Math.imul(place, takeoverBlocks)}; the chain is at `
            + `${tip.height}, ${turn.advanced} block(s) past the beacon`,
      };

    const owed = signing.owes({ roundId, contract });
    if (!owed.ok) return owed;

    const found = await watch.forRound({ owedSats: owed.wantsSats, minConfirmations });
    if (!found.ok) return found;

    // AND IS IT STILL THERE. `forRound` reads `scantxoutset`, which scans the
    // UTXO SET and does not see a mempool - so a signer node taking over would not
    // notice the spend the signer node in front of it broadcast a minute ago, and
    // would start a second signing round over an output that is already going.
    // `outpoint` asks `gettxout`, which does see one. A takeover that finds
    // the output gone stops rather than asking.
    const still = await watch.outpoint({ txid: found.utxo.txid, vout: found.utxo.vout });
    if (!still.ok)
      return { ok: false, spending: true, why: `that output is already going: ${still.why}` };

    // THE ROUND'S OWN SIGNER NODES SIGN IT: a given list, else the census's - the same
    // `peersOf` the table's gather asks. It was `this.peers`, the operator's
    // list only, so a daemon given none (the rehearsal's, the Daily's,
    // `main.js` at a live close) stopped at "1 of 2 signer nodes committed".
    return this.payWithCommittee({
      roundId, utxo: found.utxo, contract, signing, signerNodes: this.peersOf(roundId),
    });
  }

  /**
   * THE ROUND'S OWN BEACON HEIGHT, and it is asked for rather than invented.
   *
   * `randomnessFor` is the same door the roster signer nodes a committee through and
   * the verifier closes a round through - one source, so a node cannot wait on
   * one beacon and seed on another. A node given none does not take over: it
   * says so, which leaves the payout queued rather than letting a node with no
   * chain view decide it is somebody's turn.
   */
  async beaconHeightFor(roundId, contract) {
    if (typeof this.randomnessFor !== 'function')
      return { ok: false, why: 'this node reads no randomness beacon, so it cannot say whose turn it is' };
    let given;
    try { given = await this.randomnessFor({ contract, roundIdBytes: roundId }); }
    catch (err) { return { ok: false, why: `the beacon would not answer: ${err.message}` }; }
    if (!given || !Number.isInteger(given.height))
      return { ok: false, why: 'that round names no beacon height to wait from' };
    return { ok: true, height: given.height };
  }

  /**
   * THE PAYMENT, IF THE CHAIN ALREADY CARRIES IT - checked against this signer node's
   * own table, never taken on the payer's word. Answers null when there is
   * nothing to say (no spend found, or a watch that cannot scan), so the sweep
   * carries on exactly as it did.
   */
  async paidOnChain({ roundId, contract, signing, watch, fromHeight }) {
    if (!watch || typeof watch.spentBy !== 'function') return null;
    const seen = await watch.spentBy({ fromHeight });
    if (!seen || !seen.ok || !seen.spends.length) return null;
    const row = this.round.payout(roundId);
    for (const s of seen.spends) {
      const mine = signing.spendFor({ roundId, utxo: s.spent, contract });
      const txid = toHex(Uint8Array.from(s.txid).reverse());
      if (!mine.ok)
        return { ok: false, why: `the pool was spent by ${txid} and this signer node cannot check it: ${mine.why}` };
      const same = mine.outputs.length === s.outputs.length && mine.outputs.every((o, i) =>
        o.value === s.outputs[i].value && toHex(o.script) === toHex(s.outputs[i].script));
      if (!same)
        return { ok: false, spentElsewhere: true,
          why: `the pool was spent by ${txid} and it does not pay what this signer node's table pays` };
      const state = mine.owed && mine.owed.length ? PAID_IN_PART : PAID;
      this.round.putPayout({
        roundId, tableId: row.tableId, state, txid: s.txid, raw: s.raw,
        ...(state === PAID_IN_PART ? { owedSats: mine.owedSats, owedCount: mine.owed.length } : {}),
        why: `the chain carries this round's payment in block ${s.height}, and it pays this signer node's table`,
      });
      return { ok: true, state, txid: s.txid, already: true, onChain: true };
    }
    return null;
  }

  /**
   * EVERY ROUND THIS NODE STILL OWES A SPEND ON, asked about on start.
   *
   * `reconcile` above answers a different question - did a transaction this
   * node had already built go out - and leaves a round that never got as far
   * as building one exactly where it was. A node that was down when its round
   * closed, or whose pool had no confirmed output yet, would sit at
   * PAYOUT_QUEUED for ever with nobody to notice.
   */
  async settleAllQueued({ contractFor, signing, watch, minConfirmations = 1,
    takeoverBlocks = TAKEOVER_BLOCKS }) {
    if (!this.canSpend || !watch || !watch.reaches)
      return { ok: false, why: 'this node reaches no chain, so it asks it nothing', settled: [] };
    const settled = [];
    for (const row of this.round.payoutsInState(PAYOUT_QUEUED)) {
      const contract = contractFor(row.roundId);
      if (!contract) { settled.push({ roundId: row.roundId, why: 'this node holds no contract for that round' }); continue; }
      let got;
      try { got = await this.settleQueued({ roundId: row.roundId, contract, signing, watch, minConfirmations, takeoverBlocks }); }
      catch (err) { got = { ok: false, why: err.message }; }
      settled.push({ roundId: row.roundId, ...got });
    }
    return { ok: true, settled };
  }

  /**
   * THE SAME SPEND, SIGNED BY A COMMITTEE INSTEAD OF BY A PROCESS.
   *
   * `pay` below takes `signers` - five SECRET scalars - and makes every nonce
   * and every share itself. That is the arithmetic of a threshold without the
   * threshold: whoever runs it can sign anything. This asks instead, and what
   * it asks for is the only two things a signer node will put on a wire.
   *
   * IT IS AN ASKER, NOT AN AUTHORITY. Every signer node rebuilds the transaction from
   * its own store before it commits to anything, so this node cannot talk the
   * committee into a spend of its own devising - the most it can do is name an
   * output and be told no. It does not even build the bytes it broadcasts from
   * its own opinion: `signing.spendFor` is this node's signer node answering the same
   * question the others answered, and a node that disagreed with the committee
   * would produce a signature that does not verify rather than a transaction
   * nobody agreed to.
   *
   * `signing` is handed in rather than imported so this file keeps knowing
   * nothing about how a signer node holds a share.
   */
  async payWithCommittee({ roundId, utxo, contract, signing, signerNodes = [] }) {
    // THE COMMITTEE'S OWN THRESHOLD (M3.3-28), off the round's contract - not a
    // flat 5, which asked a two-signer node committee for five signers.
    let needed;
    try { needed = receiptsNeeded(contract.settlementSlots); }
    catch (e) { return { ok: false, why: e.message }; }
    const row = this.round.payout(roundId);
    if (!row) return { ok: false, why: 'that round has no queued payout' };
    if (row.state === PAID || row.state === PAID_IN_PART)
      return { ok: true, state: row.state, txid: row.txid, already: true };
    if (row.state !== PAYOUT_QUEUED)
      return { ok: false, why: `that payout is ${row.state}, so there is nothing to send` };
    if (!this.chain) return { ok: false, why: 'this node reaches no chain, so it spends nothing' };

    const mine = signing.spendFor({ roundId, utxo, contract });
    if (!mine.ok) return { ok: false, why: `this signer node will not sign it either: ${mine.why}` };

    const body = encodeUtxo(utxo);
    const rid = toHex(roundId);
    const refused = [];
    // WHO GAVE A SHARE THAT DOES NOT CHECK, by signer node id - named, and left out of
    // the next attempt. Measured without this (pool-bad-share.test.js): one
    // garbage share made an invalid spend that was written as queued and sent,
    // nobody was named, and the payout was locked for good.
    const culprits = new Map();
    const named = () => [...culprits.entries()].map(([id, where]) => ({ id, where }));
    const blame = () => (culprits.size
      ? `; a bad signature share came from ${[...culprits.entries()].map(([id, where]) => `signer node ${id} (${where})`).join(', ')}`
      : '');
    let asked = [];
    let shares = [];
    let sig = null;
    // A CALL AFTER AN EARLIER ONE GOES ON FROM THE ATTEMPT THIS SIGNER NODE'S OWN ROW
    // STANDS AT: the same list there gives back the same shares and the same
    // bytes (a restart, a takeover); a signer node that signed under another list
    // refuses, and that attempt is over.
    const kept = signing.held ? signing.held(roundId) : null;
    let attempt = kept && !kept.wrongSignerNode ? kept.attempt : 0;
    const OVER = /signed under another commitment list/;
    for (let tries = 0; tries <= signerNodes.length + 2 && !sig; tries++, attempt++) {
      // EVERY SIGNER NODE IS ASKED, AND THE FIVE ARE CHOSEN BY SIGNER NODE ID - so the healthy
      // committee's five are the same five whoever asks, the commitment list is
      // identical, and a takeover rebuilds the same transaction byte for byte
      // (letter 19). A signer node named for a bad share is not chosen again, and each
      // attempt is numbered so every signer node signs it with a FRESH nonce pair.
      const chosen = [];
      let ahead = -1;
      const own = signing.commit({ roundId, utxo, contract, random: this.random, attempt });
      if (own.ok && !culprits.has(String(own.commitment.id))) chosen.push({ where: 'this signer node', commitment: own.commitment });
      for (const peer of signerNodes) {
        const got = await this.askSignerNode(`${peer}/pool/commit?round=${rid}&attempt=${attempt}`, body);
        if (!got.ok) {
          refused.push(`${peer}: ${got.why}`);
          const moved = /moved on to signing attempt (\d+)/.exec(got.why || '');
          if (moved) ahead = Math.max(ahead, Number(moved[1]));
          continue;
        }
        let one;
        try { one = decodeCommitments(got.bytes); }
        catch (err) { refused.push(`${peer}: ${err.message}`); continue; }
        if (one.length !== 1) { refused.push(`${peer}: answered with ${one.length} commitments`); continue; }
        if (culprits.has(String(one[0].id))) continue;
        chosen.push({ where: peer, commitment: one[0] });
      }
      // SIGNER NODES ALREADY ON A LATER ATTEMPT (another asker got there first): join them.
      if (chosen.length < needed && ahead > attempt) { attempt = ahead - 1; continue; }
      if (chosen.length < needed)
        return { ok: false, committed: chosen.length, needed,
          why: `${chosen.length} of ${needed} signer nodes committed to this spend`
            + (culprits.size ? ' once the signer nodes that gave a bad share were left out' : '') + blame(),
          refused, culprits: named() };

      chosen.sort((a, b) => (String(a.commitment.id) < String(b.commitment.id) ? -1
        : String(a.commitment.id) > String(b.commitment.id) ? 1 : 0));
      chosen.length = needed;
      const commitments = chosen.map((a) => a.commitment);
      // THE SHARES COME FROM THE SIGNER NODES IN THE LIST, and this signer node only if it is one.
      const got = [];
      let over = false;
      for (const a of chosen) {
        if (a.where === 'this signer node') {
          const ownShare = signing.signatureShare({ roundId, utxo, contract, commitments, attempt });
          if (!ownShare.ok && OVER.test(ownShare.why)) { over = true; break; }
          if (!ownShare.ok) return { ok: false, why: `this signer node withdrew: ${ownShare.why}${blame()}`, culprits: named() };
          got.push(ownShare.share);
          continue;
        }
        const one = await this.askSignerNode(`${a.where}/pool/share?round=${rid}&attempt=${attempt}`,
          encodeShareRequest(utxo, commitments));
        if (!one.ok && OVER.test(one.why || '')) { refused.push(`${a.where}: ${one.why}`); over = true; break; }
        if (!one.ok)
          return { ok: false, why: `${a.where} committed and then would not sign: ${one.why}${blame()}`, culprits: named() };
        try { got.push(decodeShare(one.bytes)); }
        catch (err) { return { ok: false, why: `${a.where}: ${err.message}${blame()}`, culprits: named() }; }
      }

      // A SIGNER NODE ALREADY SPENT THIS ATTEMPT'S PAIR UNDER ANOTHER LIST: every signer node
      // takes a fresh pair for the next one.
      if (over) continue;
      const tried = aggregate340({
        commitments, message: mine.sighash, groupPublicKey: mine.groupPublicKey, shares: got, curve: this.curve,
      });
      // THE AGGREGATE IS CHECKED BEFORE ANYTHING IS WRITTEN OR SENT: an invalid
      // spend is never queued and never reaches a chain.
      if (schnorr.verify(tried.signature, mine.sighash, mine.groupPublicKey.subarray(1))) {
        sig = tried; asked = chosen; shares = got;
        break;
      }
      // AND WHOSE SHARE BROKE IT: each checked against that signer node's public share.
      let unknown = 0;
      const bad = [];
      chosen.forEach((a, i) => {
        const Y = signing.signingPublicShare ? signing.signingPublicShare(a.commitment.id) : null;
        if (!Y) { unknown++; return; }
        if (!verifyShare340({ id: a.commitment.id, share: got[i], publicShare: Y, groupPublicKey: mine.groupPublicKey,
          message: mine.sighash, commitments, curve: this.curve })) bad.push(a);
      });
      if (!bad.length)
        return { ok: false, culprits: named(),
          why: 'the committee\'s signature does not verify and no share could be shown to be the bad one'
            + (unknown ? ` (${unknown} signer node(s) have no public share here to check against)` : '')
            + ' - nothing was written or sent' + blame() };
      for (const b of bad) culprits.set(String(b.commitment.id), b.where);
    }
    if (!sig)
      return { ok: false, why: 'no signing attempt produced a signature that verifies - nothing was written or sent' + blame(), culprits: named() };
    const raw = serializeSpend({
      inputs: mine.inputs, outputs: mine.outputs, witnesses: [poolWitness(sig.signature)],
    });

    // ON DISK BEFORE THE WIRE, the same rule `pay` keeps.
    // THE DEBT GOES DOWN WITH THE BYTES, so a restart that finds these bytes -
    // on the chain, or still unsent - records the same state this call would
    // have: PAID_IN_PART when the table leaves rows owed under the relay
    // floor. It used to write PAID here whatever the table left owed, while a
    // signer node finding the same spend on the chain wrote PAID_IN_PART.
    const owedCount = (mine.owed || []).length;
    const state = owedCount ? PAID_IN_PART : PAID;
    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAYOUT_QUEUED, raw,
      owedSats: mine.owedSats || 0n, owedCount,
      why: `${shares.length} of ${needed} signer nodes signed this spend; about to send`,
    });
    const sent = await this.chain.send(raw);
    if (!sent.ok) return { ok: false, why: sent.why, raw, signed: shares.length };

    this.round.putPayout({
      roundId, tableId: row.tableId, state, txid: sent.txid, raw,
      why: owedCount
        ? `paid by ${shares.length} of ${needed} signer nodes; ${owedCount} still owed ${mine.owedSats} sats, under the relay floor`
        : `paid by ${shares.length} of ${needed} signer nodes`,
    });
    return { ok: true, state, txid: sent.txid, raw, signed: shares.length,
      owed: mine.owed || [], owedSats: mine.owedSats || 0n,
      signerNodes: asked.map((a) => a.where), culprits: named() };
  }

  /** One ask of one signer node, and a refusal is an answer rather than a throw. */
  async askSignerNode(url, body) {
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

    // THE PAID ROUND'S OWN THRESHOLD (M3.3-28), read off its contract: two
    // signers of a two-signer node committee were "2 of 5 signers" under a flat 5.
    const heldRound = this.round.get(roundId);
    if (!heldRound)
      return { ok: false, why: 'this node holds no such round, so it cannot say how many signers it needs' };
    let needed;
    try { needed = receiptsNeeded(decodeRoundContract(new Uint8Array(heldRound.contract)).settlementSlots); }
    catch (e) { return { ok: false, why: e.message }; }
    const enough = enoughToSign({
      commitments: signers.map((s) => ({ id: s.id })), needed,
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
      const hiding = nonceGenerate340(this.random(32), share);
      const binding = nonceGenerate340(this.random(32), share);
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
    // CHECKED BEFORE ANYTHING IS WRITTEN OR SENT, as the committee's path is.
    if (!schnorr.verify(sig.signature, sighash, groupPublicKey.subarray(1)))
      return { ok: false, why: 'the signature these shares make does not verify - nothing was written or sent' };
    const raw = serializeSpend({
      inputs, outputs: built.outputs, witnesses: [poolWitness(sig.signature)],
    });

    // ON DISK BEFORE THE WIRE.
    this.round.putPayout({
      roundId, tableId: row.tableId, state: PAYOUT_QUEUED, raw,
      owedSats: built.owedSats || 0n, owedCount: built.owed.length,
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
      // PAID only for a table paid in full: the debt written beside the bytes
      // says whether this spend left anybody owed.
      const done = row.owedCount > 0 ? PAID_IN_PART : PAID;
      const seen = await this.chain.look(txid);
      if (seen && seen.known) {
        this.round.putPayout({
          roundId: row.roundId, tableId: row.tableId, state: done, txid, raw: row.raw,
          why: 'this node died mid-send; the chain already has that transaction',
        });
        asked.push({ roundId: row.roundId, state: done });
        continue;
      }
      // THIS SIGNER NODE'S OWN FULLY SIGNED SPEND, WHICH THE CHAIN HAS NOT HEARD OF: the
      // raw is written only once five of seven have signed it, so these are
      // the exact bytes it was about to send - sent now, and nothing is built
      // or signed again. If the chain will not take them, the row stays
      // queued with the chain's own reason.
      let sent;
      try { sent = await this.chain.send(row.raw); }
      catch (err) { sent = { ok: false, why: err.message }; }
      if (sent && sent.ok) {
        this.round.putPayout({
          roundId: row.roundId, tableId: row.tableId, state: done, txid, raw: row.raw,
          why: 'this node died before sending; the bytes it had written were sent on restart',
        });
        asked.push({ roundId: row.roundId, state: done, sent: true });
      } else {
        asked.push({ roundId: row.roundId, state: PAYOUT_QUEUED, why: sent && sent.why });
      }
    }
    return { ok: true, asked };
  }

  /** What this node believes about a round's payout, for an operator who asks. */
  stateOf(roundId) { return this.round.payout(roundId); }
}

export { computePayoutTable };
