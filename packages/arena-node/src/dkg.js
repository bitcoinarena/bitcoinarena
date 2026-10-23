// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THIS NODE'S HALF OF MAKING THE COMMITTEE'S KEY, AND IT KEEPS ONE SHARE.
//
// M3.3 item 14. Measured before any of it (`dkg-dealer.test.js`): the dealing
// process held 7 of 7 shares, five of them interpolate to the group secret,
// and `trustedDealerSplit` had zero callers under any `src/` - so the dealer
// was whatever process started the seven daemons, and "no one of them can
// steal" held among the signers and not against that process.
//
// `arena-protocol/src/dkg.js` is the round: what a contribution is, what an epoch
// is, and the arithmetic of combining. THIS is the signer node - what it deals, what
// it accepts, what it writes down, and what it refuses. The split is the one
// `pool-signing.js` and `frost-bip340.js` already keep: the maths has no
// business knowing a database and the signer node has no business knowing a field.
//
// EVERY SECRET DIES WHERE IT IS MADE. The contribution's own secret is chosen,
// split, sealed and forgotten inside one function - it is never stored and
// never sent. What survives is one share per signer node, and this node keeps exactly
// the one addressed to it.
import {
  epochId, dealContribution, acceptContribution, openMyContribution,
  groupKeyOf, combineShares, encodeContribution, decodeContribution,
  contributionSetOf, encodeAgreement, agreementId, splitSignedAgreement, agreementHolds,
} from '../../arena-protocol/src/dkg.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { scalarFrom32, scalarTo32, FIELD } from '../../arena-protocol/src/shares.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((v, i) => v === b[i]);

export class Dkg {
  /**
   * `curve` is the group the daemon already injects everywhere else. `random`
   * makes the secrets; `peers` and `fetcher` are how a contribution reaches
   * the other signer nodes, injected the way `Payouts` injects them.
   */
  constructor(round, { curve, random, peers = [], fetcher = null, epochOf = epochId, thresholdOf = receiptsNeeded } = {}) {
    this.round = round;
    // WHICH EPOCH A COMMITTEE IS: a round's by default; a federation's reserve key names its own (reserveEpochId)
    this.epochOf = epochOf;
    // ITS THRESHOLD: a round committee's by default; a federation's reserve key its guardian seats' own (guardianThreshold, kanban #397)
    this.thresholdOf = thresholdOf;
    this.curve = curve;
    this.random = random;
    this.peers = peers;
    this.fetcher = fetcher;
    this.openedKept = new Map();          // epoch:contribution bytes -> openMyContribution's answer (finish)
  }

  get canDeal() { return !!(this.curve && this.random && this.round.identity); }

  /** Which epoch a committee is, and this node's place in it. */
  epochFor(signerNodes) {
    let id;
    try { id = this.epochOf(signerNodes); }
    catch (e) { return { ok: false, why: e.message }; }
    const mine = this.round.pubkey;
    if (!signerNodes.some((k) => same(k, mine)))
      return { ok: false, why: 'this node is not on that committee, so it makes no key with it' };
    return { ok: true, epochId: id };
  }

  /**
   * THIS SIGNER NODE'S OWN DEAL, MADE ONCE PER EPOCH AND NEVER AGAIN.
   *
   * A restart must serve the SAME contribution to a peer that has already seen
   * it. Re-dealing would publish a second polynomial under a second id, and
   * the signer nodes that combined the first would be holding shares of a key nobody
   * else has - so the bytes are stored and handed back, and the secret behind
   * them is gone the moment they are made.
   *
   * SIGNER NODES ARE SORTED, because the signer node numbers are the x of the polynomial and
   * every signer node must use the same ones. `epochId` sorts to make its hash; this
   * sorts for the same reason and it is the same order.
   */
  async deal(signerNodes) {
    if (!this.canDeal) return { ok: false, why: 'this node cannot make key material' };
    const where = this.epochFor(signerNodes);
    if (!where.ok) return where;

    const held = this.round.epoch(where.epochId);
    if (held && held.mine)
      return { ok: true, contribution: decodeContribution(held.mine), again: true };

    // THE COMMITTEE'S OWN THRESHOLD (M3.3-28): 2 of 2, 5 of 7 - the rule the
    // stake follows (`receiptsNeeded`). One `needed` of 5 for every committee
    // this daemon was ever on refused a two-signer-node one outright - "a threshold of
    // 5 cannot be dealt to 2 signer nodes" - and its round's pool had no key at all.
    let needed;
    try { needed = this.thresholdOf(signerNodes.length); }
    catch (e) { return { ok: false, why: e.message }; }

    const order = [...signerNodes].sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));
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
      secret, signerNodes: order, epochId: where.epochId, from: this.round.pubkey,
      ephemeralSecret, ephemeralPubkey: this.curve.pointX(ephemeralSecret),
      coefficients: Array.from({ length: needed - 1 },
        () => scalarFrom32(this.random(32)) % FIELD),
      needed, curve: this.curve,
    });
    if (!dealt.ok) return dealt;

    this.round.putEpoch({ epochId: where.epochId, signerNodes: order, mine: encodeContribution(dealt.contribution) });
    // AND THIS SIGNER NODE ACCEPTS ITS OWN, so the combine below sees the whole
    // committee rather than everybody except itself.
    await this.accept(encodeContribution(dealt.contribution));
    return { ok: true, contribution: dealt.contribution };
  }

  /**
   * TAKE SOMEBODY ELSE'S DEAL - AND OPEN THE ONE ENVELOPE ADDRESSED HERE.
   *
   * A contribution this signer node cannot open is not stored. That is the whole of
   * letter 29 in the committee's own key: a signer node that cut two polynomials
   * hands somebody a share that is not on the commitments it published, and
   * THAT signer node refuses it now, at the deal, rather than at a settlement months
   * later when there is nothing to be done.
   */
  async accept(bytes) {
    let c;
    try { c = decodeContribution(bytes); }
    catch (e) { return { ok: false, why: 'that is not a contribution: ' + e.message }; }

    // ONE THIS NODE HOLDS ALREADY, byte for byte, is not proven and opened again: every run of a peer posts
    // its contribution anew, and checking it each time was a third of a seat's processor at grid density
    const had = this.round.contributionsOf(c.epochId).find((r) => Buffer.compare(Buffer.from(r.bytes), Buffer.from(bytes)) === 0);
    if (had) return { ok: true, fresh: false, from: c.from };

    const shaped = acceptContribution(c, { curve: this.curve });
    if (!shaped.ok) return shaped;

    const held = this.round.epoch(c.epochId);
    if (!held)
      return { ok: false, why: 'this node knows no such epoch, so it is not making that key' };
    if (!held.signerNodes.some((k) => same(k, c.from)))
      return { ok: false, why: 'that contribution was dealt by somebody who is not on this committee' };

    const mine = await openMyContribution(c, {
      pubkey: this.round.pubkey, secret: this.round.identity.secret, curve: this.curve,
    });
    if (!mine.ok) return mine;

    const fresh = this.round.rememberContribution({
      epochId: c.epochId, dealer: c.from, bytes: encodeContribution(c),
    });
    return { ok: true, fresh, signerNode: mine.signerNode, from: c.from };
  }

  /**
   * WHEN EVERY SIGNER NODE HAS DEALT, COMBINE - AND THE SHARE IS WRITTEN ONCE.
   *
   * A combine over a subset is a key that subset chose, so this refuses until
   * the whole committee has contributed. `combineShares` says so itself; this
   * is where the answer is kept.
   */
  async finish(signerNodes, peers = this.peers) {
    const where = this.epochFor(signerNodes);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held) return { ok: false, why: 'this node has dealt nothing for that committee' };
    if (held.share)
      return {
        ok: true, already: true, signerNode: held.signerNodeNo,
        groupPublicKey: held.groupPubkey, negated: held.negated,
      };

    const stored = this.round.contributionsOf(where.epochId);
    const contributions = stored.map((r) => decodeContribution(r.bytes));
    if (contributions.length !== held.signerNodes.length)
      return {
        ok: false, have: contributions.length, of: held.signerNodes.length,
        why: `${contributions.length} of the committee's ${held.signerNodes.length} signer nodes have `
          + 'contributed, and a key a subset chose is a key that subset can steer',
      };

    // EACH CONTRIBUTION OPENED ONCE: a finish that waits for the committee's agreements is asked again every
    // second, and opening every contribution again each time was most of a seat's processor at grid density. Kept by the
    // contribution's own bytes, so a different contribution is opened as before.
    const opened = [];
    for (const [i, c] of contributions.entries()) {
      const k = `${toHex(where.epochId)}:${Buffer.from(stored[i].bytes).toString('base64')}`;
      let one = this.openedKept.get(k);
      if (!one) {
        one = await openMyContribution(c, {
          pubkey: this.round.pubkey, secret: this.round.identity.secret, curve: this.curve,
        });
        if (one.ok) { this.openedKept.set(k, one); if (this.openedKept.size > 4096) this.openedKept.delete(this.openedKept.keys().next().value); }
      }
      if (!one.ok) return { ok: false, why: `a stored contribution no longer opens: ${one.why}` };
      opened.push(one);
    }

    const combined = combineShares({
      opened, signerNodes: held.signerNodes, contributions, curve: this.curve,
    });
    if (!combined.ok) return combined;

    // AND EVERY SIGNER NODE COMBINED THE SAME SET, or this one keeps nothing.
    // Measured without it: a dealer sent two valid contributions to two halves
    // of a 5-of-7 committee and the honest signer nodes finished on two keys and two
    // pool addresses. Each signer node signs the set it holds; a share is written only
    // when every signer node of the committee has signed the same one.
    const own = this.agreementBytes(where.epochId);
    if (!own.ok) return own;
    const statements = [splitSignedAgreement(own.bytes)];
    // THE SAME PEERS THE CONTRIBUTIONS CAME FROM. Measured: a run handed the
    // committee's census peers exchanged both contributions and then asked
    // nobody for their agreement - "1 of the committee's 2 signer nodes have said which
    // contributions they combined" - because this read the daemon-wide list.
    for (const peer of peers) {
      try {
        const r = await (this.fetcher || fetch)(`${peer.replace(/\/+$/, '')}/dkg-agreement?epoch=${toHex(where.epochId)}`);
        if (!r.ok) continue;
        statements.push(splitSignedAgreement(new Uint8Array(await r.arrayBuffer())));
      } catch { /* a signer node that does not answer is waited for, by name */ }
    }
    const agreed = agreementHolds({
      epochId: where.epochId, signerNodes: held.signerNodes, statements,
      verify: (sig, digest, key) => schnorr.verify(sig, digest, key),
    });
    if (!agreed.ok) return { ok: false, why: agreed.why };

    this.round.putEpoch({
      epochId: where.epochId, signerNodes: held.signerNodes,
      share: scalarTo32(combined.share), signerNodeNo: combined.signerNode,
      groupPubkey: combined.groupPublicKey, negated: combined.negated,
    });
    return {
      ok: true, signerNode: combined.signerNode,
      groupPublicKey: combined.groupPublicKey, negated: combined.negated,
    };
  }

  /**
   * WHICH CONTRIBUTIONS THIS SIGNER NODE COMBINED FOR AN EPOCH, SIGNED BY ITS OWN KEY.
   * Only once it holds one from every signer node: before that it has combined nothing
   * and says so rather than signing a partial set.
   */
  agreementBytes(epochIdBytes) {
    const held = this.round.epoch(epochIdBytes);
    if (!held) return { ok: false, why: 'this node has dealt nothing for that committee' };
    const stored = this.round.contributionsOf(epochIdBytes);
    if (stored.length !== held.signerNodes.length)
      return { ok: false, why: `this node holds ${stored.length} of the committee's ${held.signerNodes.length} contributions and has combined nothing yet` };
    const agreement = {
      epochId: epochIdBytes, signerNode: this.round.pubkey,
      held: contributionSetOf(stored.map((r) => decodeContribution(r.bytes))),
    };
    const body = encodeAgreement(agreement);
    const signature = schnorr.sign(agreementId(agreement), this.round.identity.secret);
    const bytes = new Uint8Array(body.length + signature.length);
    bytes.set(body, 0); bytes.set(signature, body.length);
    return { ok: true, bytes };
  }

  /**
   * EVERY SIGNER NODE'S PUBLIC SHARE OF THE COMMITTEE'S KEY, from the commitments this
   * signer node stored - public data every signer node holds - so a payout can check one
   * signer's share against what that signer must have. Y_j is the sum, over
   * every dealer's polynomial, of A_k * j^k; negated with the key when the key
   * came out odd, as the secret shares were.
   */
  publicSharesFor(signerNodes) {
    const where = this.epochFor(signerNodes);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held || !held.share) return { ok: false, why: 'this node holds no share of that committee\'s key yet' };
    const contributions = this.round.contributionsOf(where.epochId).map((r) => decodeContribution(r.bytes));
    const shares = new Map();
    for (let j = 1; j <= held.signerNodes.length; j++) {
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
   * WHAT THIS SIGNER NODE HOLDS, in the shape `PoolSigning` already takes.
   *
   * `{ id, share }` is what a signer node was HANDED before this letter, by whoever
   * started it. It is what the signer node MADE now, and nothing else about the
   * signing changes - which is the point: item 17's two rounds, item 13's
   * pool output and item 10's arithmetic all carry on, over key material
   * nobody dealt.
   */
  signerNodeFor(signerNodes) {
    const where = this.epochFor(signerNodes);
    if (!where.ok) return where;
    const held = this.round.epoch(where.epochId);
    if (!held || !held.share)
      return { ok: false, why: 'this node has no share of that committee\'s key yet' };
    return {
      ok: true,
      signerNode: { id: held.signerNodeNo, share: scalarFrom32(held.share) },
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
   * Both directions, because a signer node that only pushed would depend on every
   * peer being up at the moment it dealt, and a signer node that only pulled would
   * never start. Running it twice is harmless: the deal is made once and the
   * contributions are keyed by dealer.
   */
  async run(signerNodes, peers = this.peers) {
    const dealt = await this.deal(signerNodes);
    if (!dealt.ok) return dealt;
    const bytes = encodeContribution(dealt.contribution);
    const id = toHex(dealt.contribution.epochId);

    // THE PEERS OF THIS COMMITTEE, when the caller names them: a daemon on many
    // rounds has one committee per round, read from each round's own census.
    const told = [];
    const refused = [];
    for (const peer of peers) {
      const said = await this.tell(`${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`, bytes);
      if (said.ok) told.push(peer); else refused.push(`${peer}: ${said.why}`);
    }

    // AND ASK FOR THEIRS. A peer serves its own contribution for an epoch, so
    // this fills in whatever did not arrive by being pushed.
    const got = [];
    for (const peer of peers) {
      try {
        const r = await (this.fetcher || fetch)(`${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`);
        if (!r.ok) { refused.push(`${peer}: ${r.status} ${(await r.text()).trim()}`); continue; }
        const theirs = new Uint8Array(await r.arrayBuffer());
        const took = await this.accept(theirs);
        if (took.ok) got.push(peer); else refused.push(`${peer}: ${took.why}`);
      } catch (e) { refused.push(`${peer}: ${e.message}`); }
    }

    const done = await this.finish(signerNodes, peers);
    return { ok: done.ok, told: told.length, got: got.length, refused, ...done };
  }
}
