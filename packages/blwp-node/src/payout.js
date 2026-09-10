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
 * WHICH SEAT ASKS FOR A ROUND'S PAYOUT, AND IT IS EXACTLY ONE.
 *
 * `payWithCommittee` is an asker: it names an output, collects five nonce
 * commitments and five shares, aggregates them and broadcasts. Every seat on
 * the committee closes the round, so if every seat asked, five of them would
 * run five signing rounds over ONE output. FROST aggregates over the nonces
 * that were committed, so those five are five DIFFERENT transactions spending
 * the same input: one confirms and four are double-spends the chain refuses -
 * and every seat can only hold one live nonce pair per round, so in practice
 * the five askers deadlock each other instead.
 *
 * So the asker is chosen from the round itself, the way everything else here
 * is: the seats in the order the store keeps them - by pubkey, which no seat
 * chooses - indexed by the round id. No message, no election, no clock, and
 * every seat computes the same answer from facts it already holds.
 *
 * WHAT THIS DOES NOT DO is hand the round to somebody else when the asker is
 * down. That needs a clock and a rule for how long to wait, and inventing one
 * here would be inventing the protocol. The round stays PAYOUT_QUEUED, which
 * is a state an operator can see, and it is its own line on the list.
 */
export function askerFor(roundId, seats) {
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32)
    return { ok: false, why: 'that is not a round id' };
  if (!Array.isArray(seats) || !seats.length)
    return { ok: false, why: 'that round seated nobody, so nobody asks for it' };
  // Four bytes of the round id, big-endian and unsigned. `>>> 0` because a
  // top bit set would otherwise make this negative and the modulo with it.
  const n = ((roundId[0] << 24 | roundId[1] << 16 | roundId[2] << 8 | roundId[3]) >>> 0) % seats.length;
  return { ok: true, asker: seats[n], at: n, of: seats.length };
}

/**
 * HOW LONG A SEAT GETS BEFORE THE NEXT ONE MAY TRY, IN BITCOIN BLOCKS.
 *
 * Small on purpose. A spend broadcast at the front of its window is normally
 * in the next block, and the seat behind re-reads the output through
 * `gettxout` - which sees a mempool - before it asks at all, so the wait is
 * not there to let a transaction confirm. It is there so two seats do not
 * start the same signing round in the same instant on the ordinary path.
 *
 * Blocks and not milliseconds: every seat reads one chain and agrees without
 * talking, where two wall clocks a minute apart both take over.
 */
export const TAKEOVER_BLOCKS = 2;

/**
 * THE ORDER SEATS TAKE OVER IN, AND NO SEAT CHOOSES ITS OWN PLACE.
 *
 * `askerFor` names the first. The rest follow it around the ring, so the order
 * is a rotation of the seats the store already keeps sorted BY PUBKEY - which
 * no seat picks - starting at an index taken from the round id, which is a
 * hash of a contract signed before the round ran. There is nothing here a node
 * can grind: to move up the order it would have to change the round id, and
 * that is a different round.
 */
export function askerOrder(roundId, seats) {
  const first = askerFor(roundId, seats);
  if (!first.ok) return first;
  const order = seats.map((_, i) => seats[(first.at + i) % seats.length]);
  return { ok: true, order, at: first.at, of: seats.length };
}

/**
 * WHICH SEATS MAY ASK AT THIS BLOCK HEIGHT, AND WHEN THE NEXT ONE MAY.
 *
 * ITEM 19. The asker is picked from the round id, so a seat that is offline
 * when its round closes leaves the payout at PAYOUT_QUEUED with the other six
 * correctly waiting - and a seat that never comes back strands the round for
 * ever. Somebody has to be allowed to take over, and the question that decides
 * the shape is what they take over WITH.
 *
 * THE CLOCK IS THE ROUND'S OWN BEACON HEIGHT, which is not a new time source:
 * a round that has no randomness beacon cannot be seeded and cannot be played,
 * so every seat already holds this number and holds the same one. Wall clocks
 * are per-node - two seats a minute apart would both take over - and the
 * pool output's own confirmations are the wrong anchor, because a pool funded
 * long before the round closes is already deep and every seat would be
 * eligible at once.
 *
 * Seat k in the order above may ask once the chain has advanced
 * `k * TAKEOVER_BLOCKS` past the beacon. The round's own asker is k = 0 and is
 * therefore uniquely eligible the moment the round closes.
 *
 * SEVERAL SEATS ELIGIBLE AT ONCE IS NORMAL AND HARMLESS, and it is worth
 * saying because it looks like the fault. After a long outage the chain is far
 * past the beacon and most of the ring may ask. They do not compete: every
 * seat's nonce pair is on disk, so a second asker collects the SAME
 * commitments and rebuilds the transaction byte for byte. Measured - before
 * the pair was durable, a restarted committee signed the same spend with
 * different signature bytes; now it is identical.
 */
export function eligibleAsker({ roundId, seats, beaconHeight, tipHeight,
  takeoverBlocks = TAKEOVER_BLOCKS }) {
  const ring = askerOrder(roundId, seats);
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
    // The height at which the next seat in the ring joins in, so a refusal can
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
    randomnessFor = null } = {}) {
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
      why: `${seen.agreed} of ${seen.needed} seats signed this table; ${owed.owedMsat} msat owed`,
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
   * THE FIGURE IS THE SEAT'S OWN. `signing.owes` rebuilds it from this node's
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
      return { ok: false, why: 'this node holds no seat, so it asks for nothing' };

    // WHOSE TURN IT IS, AT THIS BLOCK HEIGHT.
    //
    // The round's own asker is first and alone; every other seat waits
    // `TAKEOVER_BLOCKS` more blocks past the round's beacon than the one in
    // front of it. That is letter 19: without it a seat that never comes back
    // strands the payout at PAYOUT_QUEUED for ever.
    const seats = this.round.seats(roundId);
    const me = this.round.pubkey;
    const beaconHeight = await this.beaconHeightFor(roundId, contract);
    if (!beaconHeight.ok) return beaconHeight;
    const tip = await watch.tip();
    if (!tip.ok) return tip;

    const turn = eligibleAsker({
      roundId, seats, beaconHeight: beaconHeight.height, tipHeight: tip.height, takeoverBlocks,
    });
    if (!turn.ok) return turn;
    const place = turn.placeOf(me);
    if (place < 0)
      return { ok: false, why: 'this node is not seated on that round, so it does not ask for it' };
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
    // UTXO SET and does not see a mempool - so a seat taking over would not
    // notice the spend the seat in front of it broadcast a minute ago, and
    // would start a second signing round over an output that is already going.
    // `outpoint` asks `gettxout`, which does see one. A takeover that finds
    // the output gone stops rather than asking.
    const still = await watch.outpoint({ txid: found.utxo.txid, vout: found.utxo.vout });
    if (!still.ok)
      return { ok: false, spending: true, why: `that output is already going: ${still.why}` };

    return this.payWithCommittee({
      roundId, utxo: found.utxo, contract, signing, seats: this.peers,
    });
  }

  /**
   * THE ROUND'S OWN BEACON HEIGHT, and it is asked for rather than invented.
   *
   * `randomnessFor` is the same door the roster seats a committee through and
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
    // EVERY SEAT IS ASKED, AND THE FIVE ARE CHOSEN BY SEAT ID.
    //
    // This used to stop at the first `needed` that answered, so the five in
    // the list were whichever five were quickest - and letter 19 measured what
    // that costs. THE COMMITMENT LIST IS PART OF WHAT IS SIGNED: it goes into
    // the binding factors and therefore into the challenge, so a seat that has
    // signed under one list refuses to sign under another, by name. Two
    // askers - the round's own and a seat taking over after it went down -
    // assembled different lists and the takeover was refused by every seat
    // that had already signed.
    //
    // Sorted by id, the healthy committee's five are the same five whoever
    // asks, the list is identical, and the spent shares are handed straight
    // back: the takeover rebuilds the transaction byte for byte instead of
    // competing with it. It costs two more requests than stopping early.
    for (const peer of seats) {
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

    asked.sort((a, b) => (String(a.commitment.id) < String(b.commitment.id) ? -1
      : String(a.commitment.id) > String(b.commitment.id) ? 1 : 0));
    asked.length = needed;
    const commitments = asked.map((a) => a.commitment);
    const shares = [];
    // THE SHARES COME FROM THE SEATS IN THE LIST, and this seat is asked only
    // if it is one of them. It used to be asked unconditionally, which was
    // harmless while the five were the first five to answer and wrong the
    // moment they became the five lowest ids: an asker whose own id is the
    // sixth is not in the list it built, and asking it for a share got "this
    // seat is not in the commitment list" reported as a withdrawal.
    for (const a of asked) {
      if (a.where === 'this seat') {
        const got = signing.signatureShare({ roundId, utxo, contract, commitments });
        if (!got.ok) return { ok: false, why: `this seat withdrew: ${got.why}` };
        shares.push(got.share);
        continue;
      }
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
        continue;
      }
      // THIS SEAT'S OWN FULLY SIGNED SPEND, WHICH THE CHAIN HAS NOT HEARD OF: the
      // raw is written only once five of seven have signed it, so these are
      // the exact bytes it was about to send - sent now, and nothing is built
      // or signed again. If the chain will not take them, the row stays
      // queued with the chain's own reason.
      let sent;
      try { sent = await this.chain.send(row.raw); }
      catch (err) { sent = { ok: false, why: err.message }; }
      if (sent && sent.ok) {
        this.round.putPayout({
          roundId: row.roundId, tableId: row.tableId, state: PAID, txid, raw: row.raw,
          why: 'this node died before sending; the bytes it had written were sent on restart',
        });
        asked.push({ roundId: row.roundId, state: PAID, sent: true });
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
