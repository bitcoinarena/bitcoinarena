// THE SEATS' FORFEIT OF A QUALIFIER'S STAKE LOCK (v4.6.2 §23.2 row 1, W5b).
//
// "DELIVERED (qualifying): forfeit the stake lock -> it returns to the
// player's key. Requires: threshold settlement signature over the lock,
// published; the player's own client redeems it, and only the player can."
// A forfeit is a BIP-340 signature by the round's claim_pk over the lock's
// contract id (fedimint lnv2: `forfeit_message` is the id); the guardians then
// let the lock be spent with `Cancel(sig)`, and the transaction must be signed
// by the lock's refund_pk - the player. So a forfeit can only return money to
// its owner; what it must never be is a signature a loser can use.
//
// POOLSIGNING'S RULE, FOR A DIFFERENT MESSAGE: a seat signs only a forfeit it
// rebuilt itself. Nobody hands it a contract id. The asker names the round and
// the entry; the seat rebuilds the contract from the lock IT verified, and
// signs only if ITS OWN finality says the run is FINAL - window closed - and
// ITS OWN result says the run qualifies (§18: DELIVERED and score >=
// min_score). A loser's, a run inside its window, a Delivered run below the
// score: refused, by name.
//
// THE NONCES LIVE IN MEMORY, ONE PAIR PER MESSAGE, and a pair signs ONE
// commitment list: the same nonce over two lists is two signatures over two
// messages, which publishes the share. A second asker with the same list gets
// the same share back; with another list, nothing.
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { isQualifier } from '../../protocol/src/payout.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../protocol/src/stake-lock.js';
import { FINAL } from '../../protocol/src/objection.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { resultFinality } from './finality.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare } from './pool-wire.js';

const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
const refuse = (why, status = 409) => ({ ok: false, status, why });

export class Forfeit {
  /**
   * `dkg` holds this seat's share of the round's claim key; `port` is the
   * federation (it hashes a contract the way the guardians do); `peersFor(rid)`
   * names the other settlement seats' bases.
   */
  constructor(round, { dkg, port, curve, random, peersFor = () => [], fetcher = (u, o) => fetch(u, o), onVoid = null } = {}) {
    this.round = round;
    this.dkg = dkg;
    this.port = port;
    this.curve = curve;
    this.random = random;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    // ENTRY_VOID's evidence, handed to the other seats before a Void lock is
    // forfeited: a seat that was down records the Void only when shown it.
    this.onVoid = onVoid;
    this.pairs = new Map();          // contract id hex -> { hiding, binding, commitment, list, share }
  }

  /** WHAT THIS SEAT WILL SIGN, rebuilt from its own store - or the refusal. */
  async message(roundIdBytes, entryIdBytes) {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const lock = this.round.stakeLock(entryIdBytes);
    if (!lock) return refuse('this seat verified no stake lock for that entry, so it forfeits nothing');
    // ENTRY_VOID (§16, §23.2 "forfeit at once; if nobody acts, the lock expires"):
    // an outage refund, on THIS seat's own record of it - never on an asker's
    // word, and never for a late start (that is FORFEIT, first-mark.js) or a
    // run with no first mark. The lock goes back to the player's refund key
    // now, instead of at expiry. Everything else below still holds: the lock
    // this seat verified, the round's claim key, the contract rebuilt here.
    const voided = this.round.entryVoid ? this.round.entryVoid(entryIdBytes) : null;
    if (!voided) {
      const standing = resultFinality(this.round, roundIdBytes, entryIdBytes);
      if (standing.state !== FINAL)
        return refuse(`no forfeit before the result is final with its objection window closed: ${standing.why || standing.state}`);
      const mine = this.round.results(roundIdBytes, entryIdBytes).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      if (!mine) return refuse('this seat signed no result for that run, so it forfeits nothing');
      const result = decodePlayerResult(splitSignedResult(mine.bytes).body);
      if (!isQualifier(result, contract.minScore))
        return refuse(`that run is ${result.outcome} with score ${result.score} and this round's minimum is `
          + `${contract.minScore}: not a qualifier, so its stake lock is not forfeited`);
    }
    const held = this.dkg.seatFor(contract.nodes);
    if (!held.ok) return refuse(`this seat holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;
    const fields = lockFieldsFromJson(lock.fields);
    if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('that lock names another claim key than this round\'s');
    if (!this.port) return refuse('this seat reaches no federation, so it cannot rebuild the lock');
    const id = String(await this.port.contractId(fields));
    if (id !== String(lock.contractId)) return refuse('the contract rebuilt from this seat\'s record is not the one it verified');
    return { ok: true, message: fromHex(id), claimPk, seat: held.seat, needed: receiptsNeeded(contract.nodes.length) };
  }

  /** ROUND ONE: this seat's nonce commitment for the forfeit it would sign. */
  async commit(roundIdBytes, entryIdBytes) {
    const m = await this.message(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    const key = toHex(m.message);
    let pair = this.pairs.get(key);
    if (!pair) {
      const hiding = nonceGenerate340(this.random(32), m.seat.share);
      const binding = nonceGenerate340(this.random(32), m.seat.share);
      pair = { hiding, binding, list: null, share: null,
        commitment: { id: m.seat.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this seat's signature share, over the forfeit it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, entryIdBytes, commitments) {
    const m = await this.message(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    const pair = this.pairs.get(toHex(m.message));
    if (!pair) return refuse('this seat committed to no forfeit of that lock');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this seat\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this seat signed that forfeit over another list, and keeps no second pair');
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: m.seat.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined forfeit handed over by a peer: kept only if it verifies over what THIS seat rebuilt. */
  async take(roundIdBytes, entryIdBytes, signature) {
    const m = await this.message(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that forfeit does not verify under the round\'s claim key');
    this.round.putForfeit({ entryId: entryIdBytes, roundId: roundIdBytes, message: m.message, signature, claimPk: m.claimPk });
    return { ok: true };
  }

  /**
   * THE FORFEIT, asked by anyone: the one this seat keeps, or - if it is due -
   * made now with its peers, checked under the claim key, kept, and handed to
   * them.
   */
  async forfeit(roundIdBytes, entryIdBytes) {
    const kept = this.round.forfeit(entryIdBytes);
    if (kept) return { ok: true, ...kept, kept: true };
    const m = await this.message(roundIdBytes, entryIdBytes);
    if (!m.ok) return m;
    // AN ENTRY_VOID LOCK: the evidence goes to the other seats before they are
    // asked to sign, so a seat that was down records the same Void on its own.
    if (this.onVoid && this.round.entryVoid && this.round.entryVoid(entryIdBytes)) {
      try { await this.onVoid(roundIdBytes, entryIdBytes); } catch { /* each seat still signs only on its own record */ }
    }
    const q = `round=${toHex(roundIdBytes)}&entry=${toHex(entryIdBytes)}`;
    const own = await this.commit(roundIdBytes, entryIdBytes);
    if (!own.ok) return own;
    const signers = [{ base: null, commitment: own.commitment }];
    const refused = [];
    for (const base of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${base}/forfeit-commit?${q}`, { method: 'POST' });
        if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
        signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
      } catch (e) { refused.push(`${base}: ${e.message}`); }
    }
    if (signers.length < m.needed)
      return refuse(`${signers.length} of the ${m.needed} seats the forfeit needs committed to it: ${refused.join('; ')}`);
    const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
    const shares = [];
    for (const s of signers) {
      if (s.base === null) {
        const mine = await this.share(roundIdBytes, entryIdBytes, commitments);
        if (!mine.ok) return mine;
        shares.push(mine.share);
        continue;
      }
      const r = await this.fetcher(`${s.base}/forfeit-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
      if (!r.ok) return refuse(`${s.base} gave no share: ${(await r.text()).trim()}`);
      shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
    }
    const { signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve });
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1)))
      return refuse('the combined forfeit does not verify under the round\'s claim key', 500);
    this.round.putForfeit({ entryId: entryIdBytes, roundId: roundIdBytes, message: m.message, signature, claimPk: m.claimPk });
    for (const s of signers) {
      if (s.base === null) continue;
      try { await this.fetcher(`${s.base}/forfeit-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ }
    }
    return { ok: true, message: m.message, signature, claimPk: m.claimPk };
  }
}

export { encodeCommitments, encodeShare };
