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

/**
 * WHEN A CLAIM KEY'S RUN GOES AGAIN (kanban #791, measured 2026-10-30 01:3xZ on second-host seat 3: 232 keys ended "no key after" 30 to 5,878
 * runs, one a second, waiting for a committee member that never dealt). `said` is run()'s answer; `waitMs` the last wait, `had` the
 * contributions held at the last run short of some. With every contribution in (or no count at all) the next run is in `everyMs`; short
 * of one, a run that added a peer or a contribution goes back to `everyMs`, one that added nothing doubles the wait, up to `maxMs`.
 */
export function runAgainIn(said, { waitMs, had = -1, everyMs = 1000, maxMs = 30000 }) {
  const short = !!said && typeof said.have === 'number' && said.have < said.of;
  if (!short) return { waitMs: everyMs, had };
  const moved = (said.moved || 0) > 0 || said.have > had;
  return { waitMs: moved ? everyMs : Math.min(Math.max(waitMs, everyMs) * 2, maxMs), had: said.have };
}

/**
 * EVERY ASK OF A PEER IS BOUNDED, IN TIME AND IN BYTES (kanban #2541, wf1489 r13 gossip-1): run() asked each peer of both committees
 * one after the other, POST /dkg, GET /dkg and GET /dkg-agreement, with no timeout - one seat that took the connection and never
 * finished its answer (or trickled it) held the run forever, the peers after it were never told or asked, no share was stored, and
 * makeClaimKey's attempt never scheduled another run. Now the peers are asked side by side, each ask is aborted after
 * DKG_ASK_MS, and an answer longer than DKG_ANSWER_MAX bytes is refused: a hung peer is passed by like a refusing one and asked
 * again on the next run.
 */
export const DKG_ASK_MS = 10000;
export const DKG_ANSWER_MAX = 1 << 20;

/** One fetch of one peer, aborted after `ms`; its body read in the same time and at most `max` bytes. */
export async function askPeer(fetcher, url, opts = {}, { ms = DKG_ASK_MS, max = DKG_ANSWER_MAX } = {}) {
  const ctl = new AbortController();
  let timer;
  const expired = new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error(`no answer in ${ms} ms`)); }, ms); });
  if (timer.unref) timer.unref();
  const read = (async () => {
    const r = await (fetcher || fetch)(url, { ...opts, signal: ctl.signal });
    const chunks = []; let size = 0;
    if (r.body) {
      for await (const c of r.body) {
        size += c.length;
        if (size > max) { ctl.abort(); throw new Error(`an answer over ${max} bytes`); }
        chunks.push(c);
      }
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return { ok: r.ok, status: r.status, bytes, text: () => Buffer.from(bytes).toString('utf8') };
  })();
  try { return await Promise.race([read, expired]); }
  finally { clearTimeout(timer); read.catch(() => {}); }
}

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
    // THE COMBINE AND THE SIGNED AGREEMENT, KEPT BY THE CONTRIBUTIONS THEY ARE MADE OF (kanban #786, profiled 2026-10-29 18:3xZ on two
    // test host seats: finish took 14-20 % of a seat's CPU - while a committee waits for its agreements, finish is asked every second and
    // combined the same contributions again (their proofs checked, the shares summed), and each peer's GET /dkg-agreement signed the same
    // set again); a different stored set makes them anew
    this.combinedKept = new Map();        // epoch + the stored contributions -> combineShares' answer
    this.agreementKept = new Map();       // epoch + the stored contributions -> { ok, bytes } signed
    // A PEER'S SIGNED AGREEMENT, CHECKED ONCE (kanban #786, profiled 2026-10-29 20:25Z on test host seat 1: agreementHolds took 6.5 % - each
    // second's finish verified every peer's same signature again): a signature check is a function of its bytes alone
    this.verifiedKept = new Map();        // signature:digest:key hex -> true / false
    // WHICH PEERS ARE DONE FOR AN EPOCH (kanban #791, measured 2026-10-30 01:3xZ on second-host seat 3: 25,000 /dkg requests served and
    // 39,000 sent a minute - a committee one member never deals to is run every second until its entry closes, up to 5,878 runs a
    // key, and every run posted this node's contribution to each peer again and fetched each peer's again): a peer that took this
    // node's contribution is not told again, a peer whose contribution this node holds is not asked again
    this.peersDone = new Map();           // epoch hex -> { told: Set of peer urls, got: Set of peer urls }
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
  async deal(signerNodes, { needed: given = null } = {}) {
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
    // OR THE ROUND'S OWN, when the caller names it (kanban #675, measured 2026-10-26 07:4xZ: a round naming 5 or 6 nodes for 7 slots got
    // "no key after 158 runs - no committee threshold for 6 slots", so no claim key and no entry): the threshold of its committee's
    // slots, which every signer node reads the same off the contract
    let needed = given;
    if (!(Number.isInteger(needed) && needed > 0)) {
      try { needed = this.thresholdOf(signerNodes.length); }
      catch (e) { return { ok: false, why: e.message }; }
    }
    if (needed > signerNodes.length) return { ok: false, why: `a threshold of ${needed} cannot be dealt to ${signerNodes.length} signer nodes` };

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
  /** The key of what an epoch's stored contributions make (combinedKept, agreementKept): the epoch and each contribution's bytes. */
  keptKeyOf(epochIdBytes, stored) {
    return `${toHex(epochIdBytes)}:${stored.map((r) => Buffer.from(r.bytes).toString('base64')).join(',')}`;
  }

  /** A kept answer, the oldest dropped past `cap` (256). */
  static keep(map, k, v, cap = 256) { map.set(k, v); if (map.size > cap) map.delete(map.keys().next().value); return v; }

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

    const kk = this.keptKeyOf(where.epochId, stored);
    const combined = this.combinedKept.get(kk) || combineShares({
      opened, signerNodes: held.signerNodes, contributions, curve: this.curve,
    });
    if (!combined.ok) return combined;
    Dkg.keep(this.combinedKept, kk, combined);

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
    // each peer asked side by side and bounded (kanban #2541)
    const answers = await Promise.allSettled(peers.map((peer) =>
      askPeer(this.fetcher, `${peer.replace(/\/+$/, '')}/dkg-agreement?epoch=${toHex(where.epochId)}`)));
    for (const a of answers) {
      try {
        if (a.status !== 'fulfilled' || !a.value.ok) continue;
        statements.push(splitSignedAgreement(a.value.bytes));
      } catch { /* a signer node that does not answer is waited for, by name */ }
    }
    const agreed = agreementHolds({
      epochId: where.epochId, signerNodes: held.signerNodes, statements,
      verify: (sig, digest, key) => {
        const k = `${toHex(sig)}:${toHex(digest)}:${toHex(key)}`;
        const was = this.verifiedKept.get(k);
        return was !== undefined ? was : Dkg.keep(this.verifiedKept, k, schnorr.verify(sig, digest, key), 4096);
      },
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
    const kk = this.keptKeyOf(epochIdBytes, stored);
    const was = this.agreementKept.get(kk);
    if (was) return was;
    const agreement = {
      epochId: epochIdBytes, signerNode: this.round.pubkey,
      held: contributionSetOf(stored.map((r) => decodeContribution(r.bytes))),
    };
    const body = encodeAgreement(agreement);
    const signature = schnorr.sign(agreementId(agreement), this.round.identity.secret);
    const bytes = new Uint8Array(body.length + signature.length);
    bytes.set(body, 0); bytes.set(signature, body.length);
    return Dkg.keep(this.agreementKept, kk, { ok: true, bytes });
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
      const r = await askPeer(this.fetcher, url, { method: 'POST', body: bytes });   // bounded (kanban #2541)
      if (!r.ok) return { ok: false, why: `${r.status} ${r.text().trim()}` };
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
  async run(signerNodes, peers = this.peers, opts = {}) {
    const dealt = await this.deal(signerNodes, opts);
    if (!dealt.ok) return dealt;
    const bytes = encodeContribution(dealt.contribution);
    const id = toHex(dealt.contribution.epochId);

    // THE PEERS OF THIS COMMITTEE, when the caller names them: a daemon on many
    // rounds has one committee per round, read from each round's own census.
    const done = this.peersDone.get(id) || Dkg.keep(this.peersDone, id, { told: new Set(), got: new Set() }, 4096);
    const told = [];
    const refused = [];
    // every peer told side by side, so one that never answers holds nobody else up (kanban #2541)
    const toTell = peers.filter((peer) => !done.told.has(peer));
    const tellings = await Promise.all(toTell.map((peer) => this.tell(`${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`, bytes)));
    for (const [i, said] of tellings.entries()) {
      const peer = toTell[i];
      if (said.ok) { told.push(peer); done.told.add(peer); } else refused.push(`${peer}: ${said.why}`);
    }

    // AND ASK FOR THEIRS. A peer serves its own contribution for an epoch, so
    // this fills in whatever did not arrive by being pushed.
    const got = [];
    // fetched side by side and bounded (kanban #2541), each answer then taken in turn as before
    const toAsk = peers.filter((peer) => !done.got.has(peer));
    const fetched = await Promise.allSettled(toAsk.map((peer) => askPeer(this.fetcher, `${peer.replace(/\/+$/, '')}/dkg?epoch=${id}`)));
    for (const [i, a] of fetched.entries()) {
      const peer = toAsk[i];
      try {
        if (a.status !== 'fulfilled') throw a.reason;
        const r = a.value;
        if (!r.ok) { refused.push(`${peer}: ${r.status} ${r.text().trim()}`); continue; }
        const took = await this.accept(r.bytes);
        if (took.ok) { got.push(peer); done.got.add(peer); } else refused.push(`${peer}: ${took.why}`);
      } catch (e) { refused.push(`${peer}: ${e.message}`); }
    }

    const finished = await this.finish(signerNodes, peers);
    // `told` / `got`: the peers that hold this node's contribution / whose contribution this node holds, all runs together;
    // `moved`: how many of them this run added
    return { ok: finished.ok, told: done.told.size, got: done.got.size, moved: told.length + got.length, refused, ...finished };
  }
}
