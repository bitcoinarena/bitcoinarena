// THIS NODE'S HALF OF MAKING THE COMMITTEE'S KEY, AND IT KEEPS ONE SHARE.
//
// M3.3 item 14. Measured before any of it (`dkg-dealer.test.js`): the dealing
// process held 7 of 7 shares, five of them interpolate to the group secret,
// and `trustedDealerSplit` had zero callers under any `src/` - so the dealer
// was whatever process started the seven daemons, and "no one of them can
// steal" held among the signers and not against that process.
//
// `protocol/src/dkg.js` is the round: what a contribution is, what an epoch
// is, and the arithmetic of combining. THIS is the seat - what it deals, what
// it accepts, what it writes down, and what it refuses. The split is the one
// `pool-signing.js` and `frost-bip340.js` already keep: the maths has no
// business knowing a database and the seat has no business knowing a field.
//
// EVERY SECRET DIES WHERE IT IS MADE. The contribution's own secret is chosen,
// split, sealed and forgotten inside one function - it is never stored and
// never sent. What survives is one share per seat, and this node keeps exactly
// the one addressed to it.
import {
  epochId, dealContribution, acceptContribution, openMyContribution,
  groupKeyOf, combineShares, encodeContribution, decodeContribution,
  contributionSetOf, encodeAgreement, agreementId, splitSignedAgreement, agreementHolds,
} from '../../protocol/src/dkg.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { scalarFrom32, scalarTo32, FIELD } from '../../protocol/src/shares.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { toHex } from '../../protocol/src/hash.js';

const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((v, i) => v === b[i]);

export class Dkg {
  /**
   * `curve` is the group the daemon already injects everywhere else. `random`
   * makes the secrets; `peers` and `fetcher` are how a contribution reaches
   * the other seats, injected the way `Payouts` injects them.
   */
  constructor(round, { curve, random, peers = [], fetcher = null } = {}) {
    this.round = round;
    this.curve = curve;
    this.random = random;
    this.peers = peers;
    this.fetcher = fetcher;
  }

  get canDeal() { return !!(this.curve && this.random && this.round.identity); }

  /** Which epoch a committee is, and this node's place in it. */
  epochFor(seats) {
    let id;
    try { id = epochId(seats); }
    catch (e) { return { ok: false, why: e.message }; }
    const mine = this.round.pubkey;
    if (!seats.some((k) => same(k, mine)))
      return { ok: false, why: 'this node is not on that committee, so it makes no key with it' };
    return { ok: true, epochId: id };
  }

  /**
   * THIS SEAT'S OWN DEAL, MADE ONCE PER EPOCH AND NEVER AGAIN.
   *
   * A restart must serve the SAME contribution to a peer that has already seen
   * it. Re-dealing would publish a second polynomial under a second id, and
   * the seats that combined the first would be holding shares of a key nobody
   * else has - so the bytes are stored and handed back, and the secret behind
   * them is gone the moment they are made.
   *
   * SEATS ARE SORTED, because the seat numbers are the x of the polynomial and
   * every seat must use the same ones. `epochId` sorts to make its hash; this
   * sorts for the same reason and it is the same order.
   */
  async deal(seats) {
    if (!this.canDeal) return { ok: false, why: 'this node cannot make key material' };
    const where = this.epochFor(seats);
    if (!where.ok) return where;

    const held = this.round.epoch(where.epochId);
    if (held && held.mine)
      return { ok: true, contribution: decodeContribution(held.mine), again: true };

    // THE COMMITTEE'S OWN THRESHOLD (M3.3-28): 2 of 2, 5 of 7 - the rule the
    // stake follows (`receiptsNeeded`). One `needed` of 5 for every committee
    // this daemon was ever on refused a two-seat one outright - "a threshold of
    // 5 cannot be dealt to 2 seats" - and its round's pool had no key at all.
    let needed;
    try { needed = receiptsNeeded(seats.length); }
    catch (e) { return { ok: false, why: e.message }; }

    const order = [...seats].sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));
    // A SECRET BELOW THE ORDER, or it is not a scalar of the group. The same
    // rule `stakeFor` follows, and the answer is another one rather than this
    // one reduced.
    let secret = this.random(32);
    for (let tries = 0; scalarFrom32(secret) >= FIELD || scalarFrom32(secret) === 0n; tries++) {
      if (tries > 8) return { ok: false, why: 'this randomness never produced a scalar of the group' };
      secret = this.random(32);
    }
    const ephemeralSecret = this.random(32);
    const dealt = await dealContribution({
      secret, seats: order, epochId: where.epochId, from: this.round.pubkey,
      ephemeralSecret, ephemeralPubkey: this.curve.pointX(ephemeralSecret),
      coefficients: Array.from({ length: needed - 1 },
        () => scalarFrom32(this.random(32)) % FIELD),
      needed, curve: this.curve,
    });
    if (!dealt.ok) return dealt;

    this.round.putEpoch({ epochId: where.epochId, seats: order, mine: encodeContribution(dealt.contribution) });
    // AND THIS SEAT ACCEPTS ITS OWN, so the combine below sees the whole
    // committee rather than everybody except itself.
    await this.accept(encodeContribution(dealt.contribution));
    return { ok: true, contribution: dealt.contribution };
  }

  /**
   * TAKE SOMEBODY ELSE'S DEAL - AND OPEN THE ONE ENVELOPE ADDRESSED HERE.
   *
   * A contribution this seat cannot open is not stored. That is the whole of
   * letter 29 in the committee's own key: a seat that cut two polynomials
   * hands somebody a share that is not on the commitments it published, and
   * THAT seat refuses it now, at the deal, rather than at a settlement months
   * later when there is nothing to be done.
   */
  async accept(bytes) {
    let c;
    try { c = decodeContribution(bytes); }
    catch (e) { return { ok: false, why: 'that is not a contribution: ' + e.message }; }

    const shaped = acceptContribution(c, { curve: this.curve });
    if (!shaped.ok) return shaped;

    const held = this.round.epoch(c.epochId);
    if (!held)
      return { ok: false, why: 'this node knows no such epoch, so it is not making that key' };
    if (!held.seats.some((k) => same(k, c.from)))
      return { ok: false, why: 'that contribution was dealt by somebody who is not on this committee' };

    const mine = await openMyContribution(c, {
      pubkey: this.round.pubkey, secret: this.round.identity.secret, curve: this.curve,
    });
    if (!mine.ok) return mine;

    const fresh = this.round.rememberContribution({
      epochId: c.epochId, dealer: c.from, bytes: encodeContribution(c),
    });
    return { ok: true, fresh, seat: mine.seat, from: c.from };
  }

  /**
   * WHEN EVERY SEAT HAS DEALT, COMBINE - AND THE SHARE IS WRITTEN ONCE.
   *
   * A combine over a subset is a key that subset chose, so this refuses until
   * the whole committee has contributed. `combineShares` says so itself; this
   * is where the answer is kept.
   */
  async finish(seats) {
    const where = this.epochFor(seats);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held) return { ok: false, why: 'this node has dealt nothing for that committee' };
    if (held.share)
      return {
        ok: true, already: true, seat: held.seatNo,
        groupPublicKey: held.groupPubkey, negated: held.negated,
      };

    const stored = this.round.contributionsOf(where.epochId);
    const contributions = stored.map((r) => decodeContribution(r.bytes));
    if (contributions.length !== held.seats.length)
      return {
        ok: false, have: contributions.length, of: held.seats.length,
        why: `${contributions.length} of the committee's ${held.seats.length} seats have `
          + 'contributed, and a key a subset chose is a key that subset can steer',
      };

    const opened = [];
    for (const c of contributions) {
      const one = await openMyContribution(c, {
        pubkey: this.round.pubkey, secret: this.round.identity.secret, curve: this.curve,
      });
      if (!one.ok) return { ok: false, why: `a stored contribution no longer opens: ${one.why}` };
      opened.push(one);
    }

    const combined = combineShares({
      opened, seats: held.seats, contributions, curve: this.curve,
    });
    if (!combined.ok) return combined;

    // AND EVERY SEAT COMBINED THE SAME SET, or this one keeps nothing.
    // Measured without it: a dealer sent two valid contributions to two halves
    // of a 5-of-7 committee and the honest seats finished on two keys and two
    // pool addresses. Each seat signs the set it holds; a share is written only
    // when every seat of the committee has signed the same one.
    const own = this.agreementBytes(where.epochId);
    if (!own.ok) return own;
    const statements = [splitSignedAgreement(own.bytes)];
    for (const peer of this.peers) {
      try {
        const r = await (this.fetcher || fetch)(`${peer.replace(/\/+$/, '')}/dkg-agreement?epoch=${toHex(where.epochId)}`);
        if (!r.ok) continue;
        statements.push(splitSignedAgreement(new Uint8Array(await r.arrayBuffer())));
      } catch { /* a seat that does not answer is waited for, by name */ }
    }
    const agreed = agreementHolds({
      epochId: where.epochId, seats: held.seats, statements,
      verify: (sig, digest, key) => schnorr.verify(sig, digest, key),
    });
    if (!agreed.ok) return { ok: false, why: agreed.why };

    this.round.putEpoch({
      epochId: where.epochId, seats: held.seats,
      share: scalarTo32(combined.share), seatNo: combined.seat,
      groupPubkey: combined.groupPublicKey, negated: combined.negated,
    });
    return {
      ok: true, seat: combined.seat,
      groupPublicKey: combined.groupPublicKey, negated: combined.negated,
    };
  }

  /**
   * WHICH CONTRIBUTIONS THIS SEAT COMBINED FOR AN EPOCH, SIGNED BY ITS OWN KEY.
   * Only once it holds one from every seat: before that it has combined nothing
   * and says so rather than signing a partial set.
   */
  agreementBytes(epochIdBytes) {
    const held = this.round.epoch(epochIdBytes);
    if (!held) return { ok: false, why: 'this node has dealt nothing for that committee' };
    const stored = this.round.contributionsOf(epochIdBytes);
    if (stored.length !== held.seats.length)
      return { ok: false, why: `this node holds ${stored.length} of the committee's ${held.seats.length} contributions and has combined nothing yet` };
    const agreement = {
      epochId: epochIdBytes, seat: this.round.pubkey,
      held: contributionSetOf(stored.map((r) => decodeContribution(r.bytes))),
    };
    const body = encodeAgreement(agreement);
    const signature = schnorr.sign(agreementId(agreement), this.round.identity.secret);
    const bytes = new Uint8Array(body.length + signature.length);
    bytes.set(body, 0); bytes.set(signature, body.length);
    return { ok: true, bytes };
  }

  /**
   * EVERY SEAT'S PUBLIC SHARE OF THE COMMITTEE'S KEY, from the commitments this
   * seat stored - public data every seat holds - so a payout can check one
   * signer's share against what that signer must have. Y_j is the sum, over
   * every dealer's polynomial, of A_k * j^k; negated with the key when the key
   * came out odd, as the secret shares were.
   */
  publicSharesFor(seats) {
    const where = this.epochFor(seats);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held || !held.share) return { ok: false, why: 'this node holds no share of that committee\'s key yet' };
    const contributions = this.round.contributionsOf(where.epochId).map((r) => decodeContribution(r.bytes));
    const shares = new Map();
    for (let j = 1; j <= held.seats.length; j++) {
      const terms = [];
      for (const c of contributions) {
        let x = 1n;
        for (const A of c.commitments) { terms.push({ point: A, coefficient: x }); x = (x * BigInt(j)) % FIELD; }
      }
      let P = this.curve.combinePoints(terms);
      if (held.negated) P = this.curve.combinePoints([{ point: P, coefficient: FIELD - 1n }]);
      shares.set(String(j), P);
    }
    return { ok: true, shares };
  }

  /**
   * WHAT THIS SEAT HOLDS, in the shape `PoolSigning` already takes.
   *
   * `{ id, share }` is what a seat was HANDED before this letter, by whoever
   * started it. It is what the seat MADE now, and nothing else about the
   * signing changes - which is the point: item 17's two rounds, item 13's
   * pool output and item 10's arithmetic all carry on, over key material
   * nobody dealt.
   */
  seatFor(seats) {
    const where = this.epochFor(seats);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held || !held.share)
      return { ok: false, why: 'this node has no share of that committee\'s key yet' };
    return {
      ok: true,
      seat: { id: held.seatNo, share: scalarFrom32(held.share) },
      pool: { groupPublicKey: held.groupPubkey },
    };
  }

  /** One ask of one peer, and a refusal is an answer rather than a throw. */
  async tell(url, bytes) {
    try {
      const r = await (this.fetcher || fetch)(url, { method: 'POST', body: bytes });
      if (!r.ok) return { ok: false, why: `${r.status} ${(await r.text()).trim()}` };
      return { ok: true };
    } catch (e) { return { ok: false, why: e.message }; }
  }

  /**
   * DEAL, TELL EVERYBODY, AND ASK FOR THEIRS.
   *
   * Both directions, because a seat that only pushed would depend on every
   * peer being up at the moment it dealt, and a seat that only pulled would
   * never start. Running it twice is harmless: the deal is made once and the
   * contributions are keyed by dealer.
   */
  async run(seats) {
    const dealt = await this.deal(seats);
    if (!dealt.ok) return dealt;
    const bytes = encodeContribution(dealt.contribution);
    const id = toHex(dealt.contribution.epochId);

    const told = [];
    const refused = [];
    for (const peer of this.peers) {
      const said = await this.tell(`${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`, bytes);
      if (said.ok) told.push(peer); else refused.push(`${peer}: ${said.why}`);
    }

    // AND ASK FOR THEIRS. A peer serves its own contribution for an epoch, so
    // this fills in whatever did not arrive by being pushed.
    const got = [];
    for (const peer of this.peers) {
      try {
        const r = await (this.fetcher || fetch)(`${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`);
        if (!r.ok) { refused.push(`${peer}: ${r.status} ${(await r.text()).trim()}`); continue; }
        const theirs = new Uint8Array(await r.arrayBuffer());
        const took = await this.accept(theirs);
        if (took.ok) got.push(peer); else refused.push(`${peer}: ${took.why}`);
      } catch (e) { refused.push(`${peer}: ${e.message}`); }
    }

    const done = await this.finish(seats);
    return { ok: done.ok, told: told.length, got: got.length, refused, ...done };
  }
}
