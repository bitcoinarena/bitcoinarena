// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE MAKES ITS OWN KEY, AND NOBODY EVER HOLDS IT.
//
// M3.3 item 14. Item 10 closed FROST against RFC 9591's own vectors and said
// what it had not done: the group secret came from a TRUSTED DEALER. Item 17
// put the signing on sockets - five daemons, one share each, no secret on the
// wire - which distributes the SIGNING and not the KEY. Measured before any of
// this was written (`dkg-dealer.test.js`): the dealing process held 7 of 7
// shares, five of them interpolate to the group secret, and `trustedDealerSplit`
// had zero callers under any `src/` - so the dealer was not code in this
// repository at all, it was whatever process started the seven daemons.
//
// PEDERSEN, AND IT IS n PARALLEL FELDMAN DEALS. Every signer node picks a secret,
// splits it to all signer nodes with `splitSecret`, publishes the polynomial's
// commitments and seals one share to each signer node's key. Every signer node then adds up
// the shares it was dealt: that sum is its share of a group secret equal to the
// sum of everybody's, which no signer node and no observer ever computes. The group
// key is the sum of the constant-term commitments, and every signer node works it out
// from public data alone.
//
// WHAT IS REUSED AND WHY. `splitSecret` already cuts a polynomial and publishes
// Feldman commitments; `sealShare`/`openShare` already put one share in an
// envelope only one signer node's key opens; `shareOpensTo` is already the check that
// a share lies on the published polynomial - the whole of letter 29. None of
// that is rewritten here. What is new is the ROUND: who deals to whom, what a
// signer node must have before it may combine, and the refusals.
//
// THE CURVE IS INJECTED, like everywhere else in this package: nothing here
// vendors an implementation of the thing that pins money.
import { Writer, Reader } from './encode.js';
import { TAG, TYPE_DKG_CONTRIBUTION, TYPE_DKG_AGREEMENT, PROTOCOL_VERSION, speaksVersion } from './constants.js';
import { taggedHash, toHex, bytesToBigInt } from './hash.js';
import { shareOpensTo, splitSecret, FIELD, SHARES_NEEDED, scalarFrom32, scalarTo32 } from './shares.js';
import { openShare, sealShare, VSS_SEALED_BYTES } from './seal.js';
import { COMMITMENT_BYTES } from './handout.js';
import { hashesFor } from './frost.js';
import { TR_CONTEXT } from './frost-bip340.js';

const mod = (v) => ((v % FIELD) + FIELD) % FIELD;
const same = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array
  && a.length === b.length && a.every((v, i) => v === b[i]);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * THE DEALER KNOWS THE SECRET BEHIND ITS FIRST COMMITMENT, OR ITS DEAL IS REFUSED.
 *
 * Measured without this (dkg-rogue.test.js, 734a2ec): in a 2-of-2 committee
 * the signer node that deals LAST takes the honest signer node's first commitment, publishes
 * A0 = X - (honest A0) for a key X it owns, and solves its second commitment
 * as a point so the one share it deals the honest signer node still verifies. Every
 * check passed, the group key was X, and that signer node alone signed for the pool.
 * Feldman proves a share lies on the published polynomial; it does not prove
 * the dealer knows the polynomial's secret. This does.
 *
 * Zcash Foundation frost-core round 1, taproot suite (frost-secp256k1-tr
 * v3.0.0), exactly: c = HDKG(id || A0 || R) with the id a 32-byte scalar and A0,
 * R compressed points; mu = k + a0*c; written as R's x (32) || mu (32), R read
 * back with even y. Verified against ZF's published proofs (zf-frost-tr.test).
 * The prover makes R even itself, which every such verifier accepts.
 */
export const PROOF_BYTES = 64;
const HDKG = (m) => hashesFor(TR_CONTEXT).HDKG(m);
const idBytes = (id) => scalarTo32(BigInt(id));

export function proveKnowledge({ id, secret, commitment, nonce, curve }) {
  let k = mod(nonce);
  if (k === 0n) throw new Error('a proof nonce of zero proves nothing');
  let R = curve.pointFromScalar(k);
  if (R[0] !== 0x02) { k = FIELD - k; R = curve.pointFromScalar(k); }
  const c = HDKG(cat(idBytes(id), commitment, R));
  return cat(R.subarray(1), scalarTo32(mod(k + mod(mod(secret) * c))));
}

export function knowledgeIsProven({ id, commitment, proof, curve } = {}) {
  if (!(proof instanceof Uint8Array) || proof.length !== PROOF_BYTES)
    return { ok: false, why: 'that contribution carries no 64-byte proof of knowledge' };
  if (!curve || typeof curve.combinePoints !== 'function')
    return { ok: false, why: 'checking a proof of knowledge needs a curve, and none was injected' };
  const refuse = {
    ok: false,
    why: `signer node ${id}'s proof of knowledge does not verify: it has not shown it knows the secret behind `
      + 'its first commitment, and a signer node that dealt after seeing the others could otherwise choose the group key',
  };
  const R = cat(Uint8Array.of(0x02), proof.subarray(0, 32));
  const mu = scalarFrom32(proof.subarray(32));
  if (mu === 0n || mu >= FIELD) return refuse;
  const c = HDKG(cat(idBytes(id), commitment, R));
  let rhs;
  try {
    rhs = curve.combinePoints([{ point: curve.pointFromScalar(mu), coefficient: 1n },
      { point: commitment, coefficient: FIELD - c }]);
  } catch { return refuse; }
  return toHex(rhs) === toHex(R) ? { ok: true } : refuse;
}

/** The dealer's own signer node number in its deal: the x its proof names. */
const dealerSignerNode = (c) => {
  const s = c && Array.isArray(c.shares) ? c.shares.find((x) => same(x.signerNodePubkey, c.from)) : null;
  return s ? s.signerNode : null;
};

function proofHolds(c, curve) {
  const id = dealerSignerNode(c);
  if (!id) return { ok: false, why: 'that signer node dealt to a committee it is not on' };
  if (!Array.isArray(c.commitments) || !c.commitments.length)
    return { ok: false, why: 'a contribution that publishes no polynomial cannot be checked' };
  return knowledgeIsProven({ id, commitment: c.commitments[0], proof: c.proof, curve });
}

/**
 * WHICH COMMITTEE THIS KEY BELONGS TO, AND IT IS THE SIGNER NODES THEMSELVES.
 *
 * the owner's rule for the lifetime: a DKG runs once per committee EPOCH, not per
 * round. The pool is one P2TR output across rounds (item 13), so a per-round
 * key would mint a new pool address every round and force the funds to move.
 * When sortition signer nodes a different committee, that epoch runs a new DKG; the
 * same signer nodes keep the same group key and the same address.
 *
 * So the epoch is named by the SET OF SIGNER NODES and by nothing else. Sorted, so
 * two nodes holding one committee in two orders compute one id; hashed with
 * its own tag, so an epoch id can never be produced by hashing something else.
 * Nothing is added to any contract: every signer node already knows who is joined.
 */
export function epochId(signerNodes) {
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    throw new Error('an epoch is a committee, and that is nobody');
  const keys = signerNodes.map((k) => {
    if (!(k instanceof Uint8Array) || k.length !== 32)
      throw new Error('a signer node is a 32-byte key');
    return k;
  }).sort((a, b) => (toHex(a) < toHex(b) ? -1 : toHex(a) > toHex(b) ? 1 : 0));
  for (let i = 1; i < keys.length; i++)
    if (same(keys[i], keys[i - 1]))
      throw new Error('two signer nodes of that committee are one key');

  const w = new Writer();
  w.u16(keys.length);
  for (const k of keys) w.bytes32(k);
  return taggedHash(TAG.dkgEpoch, w.finish());
}

/**
 * THE EPOCH OF A FEDERATION'S RESERVE KEY (§27A.9.2): the protocol reserves of `federationId` are locked to a
 * k-of-n key of its guardian seats, made by the same DKG as a round's claim key - under an epoch of its own, tagged apart and
 * bound to the federation, so a round committee of the same seven nodes never makes (or is handed) the reserve key.
 */
export function reserveEpochId(federationId, signerNodes) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) throw new Error('a reserve key belongs to a 32-byte federation');
  const committee = epochId(signerNodes);
  const b = new Uint8Array(64); b.set(federationId, 0); b.set(committee, 32);
  return taggedHash(TAG.reserveEpoch, b);
}

export function encodeContribution(c) {
  const w = new Writer();
  w.u8(TYPE_DKG_CONTRIBUTION);
  w.u16(PROTOCOL_VERSION);
  // WHICH COMMITTEE, so a contribution dealt to one set of signer nodes cannot be
  // replayed into another - the signer nodes are what the epoch id is made of, so a
  // contribution naming an epoch is a contribution naming its recipients.
  w.bytes32(c.epochId);
  // WHO DEALT IT. Not decoration: every signer node must contribute exactly once, and
  // a combine that counted one signer node twice would let that signer node choose the group
  // key by dealing again after seeing everybody else's commitments.
  w.bytes32(c.from);
  w.bytes32(c.ephemeralPubkey);
  w.u16(c.needed);
  w.vec(c.commitments, (p, ww) => ww.bytes(p, COMMITMENT_BYTES));
  // THE PROOF THAT THE DEALER KNOWS a0 - carried with the polynomial it proves.
  w.bytes(c.proof, PROOF_BYTES);
  w.vec(c.shares, (s, ww) => {
    ww.u16(s.signerNode);
    ww.bytes32(s.signerNodePubkey);
    ww.bytes(s.sealed, VSS_SEALED_BYTES);
  }, { sortedBy: (a, b) => a.signerNode - b.signerNode });
  return w.finish();
}

export function decodeContribution(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DKG_CONTRIBUTION) throw new Error('not a DkgContribution');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('protocol version ' + version);
  const c = {
    epochId: r.bytes32(),
    from: r.bytes32(),
    ephemeralPubkey: r.bytes32(),
    needed: r.u16(),
    commitments: r.vec((rr) => rr.bytes(COMMITMENT_BYTES)),
    proof: r.bytes(PROOF_BYTES),
    shares: r.vec((rr) => ({
      signerNode: rr.u16(),
      signerNodePubkey: rr.bytes32(),
      sealed: rr.bytes(VSS_SEALED_BYTES),
    })),
  };
  r.end();
  return c;
}

export const contributionId = (c) => taggedHash(TAG.dkgContribution, encodeContribution(c));

/**
 * ONE SIGNER NODE'S DEAL: a secret nobody is meant to know, split to the committee.
 *
 * The secret is this signer node's own contribution to the group secret and is
 * forgotten the moment the shares are sealed - it is never stored, never sent,
 * and never needed again. What survives is one share per signer node and the
 * polynomial's commitments.
 *
 * SIGNER NODE NUMBERS ARE 1..n IN THE ORDER THE COMMITTEE WAS GIVEN, the same rule
 * `dealHandout` follows and for the same reason: they are the x of the
 * polynomial, so zero is the secret itself, and the opener must use the numbers
 * the dealer used.
 */
export async function dealContribution({ secret, signerNodes, epochId: id, from,
  ephemeralSecret, ephemeralPubkey, coefficients, needed = SHARES_NEEDED, curve } = {}) {
  if (!Array.isArray(signerNodes) || signerNodes.length < needed)
    return { ok: false, why: `a threshold of ${needed} cannot be dealt to ${signerNodes ? signerNodes.length : 0} signer nodes` };
  if (!curve || typeof curve.pointFromScalar !== 'function')
    return { ok: false, why: 'dealing needs a curve, and none was injected' };
  if (!(id instanceof Uint8Array) || id.length !== 32)
    return { ok: false, why: 'a contribution names the epoch it belongs to' };
  if (!(from instanceof Uint8Array) || from.length !== 32)
    return { ok: false, why: 'a contribution names the signer node that dealt it' };
  if (!signerNodes.some((k) => same(k, from)))
    return { ok: false, why: 'that signer node is not on the committee it is dealing to' };
  // THE DEALER'S KEY ON THE WIRE IS THE POINT OF THE SECRET IT SEALS WITH. Measured before: a mismatched pair dealt ok and
  // was accepted, and no signer node could open its share - one dealer stalled the key without being refused at the deal.
  const ephemeralFromSecret = curve.pointX(ephemeralSecret);
  if (!(ephemeralPubkey instanceof Uint8Array) || toHex(ephemeralPubkey) !== toHex(ephemeralFromSecret))
    return { ok: false, why: `the ephemeral key ${ephemeralPubkey instanceof Uint8Array ? toHex(ephemeralPubkey) : String(ephemeralPubkey)} `
      + `is not the point of the secret the shares are sealed with (${toHex(ephemeralFromSecret)}), so no signer node could open its share` };

  let split;
  try { split = splitSecret(secret, { signerNodes: signerNodes.length, needed, coefficients, curve }); }
  catch (e) { return { ok: false, why: e.message }; }

  const shares = [];
  for (const share of split.shares) {
    const signerNodePubkey = signerNodes[share.signerNode - 1];
    shares.push({
      signerNode: share.signerNode,
      signerNodePubkey,
      sealed: await sealShare({
        value: share.value, signerNode: share.signerNode, signerNodePubkey, ephemeralSecret, curve,
      }),
    });
  }
  // AND THE PROOF THAT THIS SIGNER NODE KNOWS a0. Its nonce is derived from the secret,
  // the epoch and the commitment, so two proofs never share one.
  const signerNodeNo = signerNodes.findIndex((k) => same(k, from)) + 1;
  const nonce = mod(bytesToBigInt(taggedHash(TAG.dkgProofNonce, cat(secret, id, split.commitments[0]))));
  let proof;
  try {
    proof = proveKnowledge({ id: signerNodeNo, secret: scalarFrom32(secret), commitment: split.commitments[0], nonce, curve });
  } catch (e) { return { ok: false, why: e.message }; }
  return {
    ok: true,
    contribution: { epochId: id, from, ephemeralPubkey, needed, commitments: split.commitments, proof, shares },
  };
}

/**
 * IS THIS CONTRIBUTION ONE A SIGNER NODE CAN ACT ON?
 *
 * The same family of shape checks `acceptHandout` makes, and they are not
 * ceremony: a threshold that disagrees with the number of commitments, two
 * shares for one signer node, or a signer node numbered zero each describe a deal that would
 * pass a per-share check and still be unusable.
 */
export function acceptContribution(c, { curve } = {}) {
  if (!c || !Array.isArray(c.shares) || c.shares.length === 0)
    return { ok: false, why: 'a contribution of no shares is not a contribution' };
  if (!Array.isArray(c.commitments) || c.commitments.length === 0)
    return { ok: false, why: 'a contribution that publishes no polynomial cannot be checked' };
  if (c.commitments.length !== c.needed)
    return {
      ok: false,
      why: `a threshold of ${c.needed} is a polynomial of ${c.needed} coefficients, `
        + `and this contribution publishes ${c.commitments.length}`,
    };
  if (c.shares.length < c.needed)
    return { ok: false, why: `${c.shares.length} shares cannot carry a threshold of ${c.needed}` };

  const signerNodes = new Set();
  const keys = new Set();
  for (const s of c.shares) {
    if (!Number.isInteger(s.signerNode) || s.signerNode < 1)
      return { ok: false, why: 'a share of signer node zero is a share of the secret itself' };
    if (signerNodes.has(s.signerNode)) return { ok: false, why: `two shares for signer node ${s.signerNode} are one share` };
    signerNodes.add(s.signerNode);
    if (!(s.signerNodePubkey instanceof Uint8Array) || s.signerNodePubkey.length !== 32)
      return { ok: false, why: `signer node ${s.signerNode} is not addressed to a key` };
    if (!(s.sealed instanceof Uint8Array) || s.sealed.length !== VSS_SEALED_BYTES)
      return { ok: false, why: `signer node ${s.signerNode}'s envelope is not a sealed share` };
    if (keys.has(toHex(s.signerNodePubkey)))
      return { ok: false, why: 'two signer nodes of that contribution are one key' };
    keys.add(toHex(s.signerNodePubkey));
  }
  // AND THE DEALER IS ONE OF THE RECIPIENTS. A signer node that dealt to everybody
  // but itself would hold no share of its own contribution and could never
  // sign with the key it helped make.
  if (!keys.has(toHex(c.from)))
    return { ok: false, why: 'that signer node dealt to a committee it is not on' };

  // AND THE DEALER KNOWS a0. Without this a signer node dealing last chose the key.
  const known = proofHolds(c, curve);
  if (!known.ok) return known;

  return { ok: true, why: `${c.shares.length} sealed shares, threshold ${c.needed}` };
}

/**
 * OPEN THE ONE ENVELOPE THIS SIGNER NODE WAS DEALT, AND CHECK IT AGAINST THE
 * POLYNOMIAL THE DEALER PUBLISHED.
 *
 * A CROOKED DEALER IS CAUGHT AT THE DEAL, which is the whole point of Feldman
 * being here rather than a plain Shamir split: a signer node that cuts two
 * polynomials hands somebody a share that does not lie on the commitments it
 * published, and THAT signer node refuses it now - not at reconstruction months
 * later, when there is nothing left to do about it.
 */
export async function openMyContribution(c, { pubkey, secret, curve } = {}) {
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32)
    return { ok: false, why: 'a signer node opens a share with its own 32-byte key, and that is not one' };
  // A CONTRIBUTION WITH NO SHARES LIST IS REFUSED BY NAME: measured before, this threw "Cannot read properties of undefined".
  if (!c || !Array.isArray(c.shares))
    return { ok: false, why: 'that contribution carries no shares list, so it has no share for this node' };
  const mine = c.shares.find((s) => toHex(s.signerNodePubkey) === toHex(pubkey));
  if (!mine) return { ok: false, why: 'this node is not one of the signer nodes that contribution was dealt to' };
  // A SHARE ON A POLYNOMIAL NOBODY KNOWS IS NOT A SHARE: refused before it is opened.
  const known = proofHolds(c, curve);
  if (!known.ok) return known;

  const opened = await openShare({
    sealed: mine.sealed, signerNode: mine.signerNode, secret, ephemeralPubkey: c.ephemeralPubkey, curve,
  });
  if (!opened.ok) return opened;

  const consistent = shareOpensTo(opened.share, { commitments: c.commitments, curve });
  if (!consistent.ok)
    return { ok: false, why: `${consistent.why} - that signer node dealt a crooked polynomial` };
  return { ok: true, share: opened.share, signerNode: mine.signerNode };
}

/**
 * THE GROUP KEY, FROM PUBLIC DATA ALONE.
 *
 * The sum of every contribution's constant-term commitment. Every signer node
 * computes it from the commitments it was shown, so all of them arrive at the
 * same 33 bytes without anybody being told what it is - and nobody, at any
 * point, holds the secret behind it.
 */
export function groupKeyOf(contributions, curve) {
  if (!Array.isArray(contributions) || !contributions.length)
    return { ok: false, why: 'no contributions, so there is no key to compute' };
  if (!curve || typeof curve.combinePoints !== 'function')
    return { ok: false, why: 'summing commitments needs a curve, and none was injected' };
  // A CONTRIBUTION WITHOUT ITS FIRST COMMITMENT IS REFUSED BY NAME: measured before, it threw "reading '0'".
  const bare = contributions.find((c) => !c || !Array.isArray(c.commitments) || !(c.commitments[0] instanceof Uint8Array));
  if (bare !== undefined)
    return { ok: false, why: `the contribution of ${bare && bare.from instanceof Uint8Array ? toHex(bare.from).slice(0, 16) : 'an unnamed signer node'} publishes no first commitment, so there is no key to compute` };
  const terms = contributions.map((c) => ({ point: c.commitments[0], coefficient: 1n }));
  const summed = curve.combinePoints(terms);

  // AND ITS PARITY, WHICH IS WHERE A DEALERLESS KEY DIFFERS FROM A DEALT ONE.
  //
  // `signShare340` refuses an odd-y group key by name - "normalise the secret
  // when it is dealt, not here" - and with a dealer that is what happened:
  // `evenGroupSecret` negated the SECRET before splitting it. Nobody holds the
  // secret here, so nobody can negate it.
  //
  // What every signer node CAN do is negate its own share. The sum of -x_i is
  // -(sum x_i), so negated shares are shares of FIELD - s, whose point is the
  // even-y one - and each signer node decides it alone, from the parity of a key it
  // computed from public data. It is the same move `poolShare` already makes
  // for the taproot tweak, and it needs no round and no message.
  const even = summed[0] === 0x02;
  const groupPublicKey = even
    ? summed
    : Uint8Array.from([0x02, ...summed.subarray(1)]);
  return { ok: true, groupPublicKey, negated: !even, summed };
}

/**
 * THIS SIGNER NODE'S SHARE OF THE GROUP SECRET: the sum of what it was dealt.
 *
 * EVERY SIGNER NODE MUST HAVE CONTRIBUTED, and it is checked rather than assumed. A
 * combine over a subset is a key a subset chose: whoever was left out is a
 * party whose randomness is not in the secret, and - worse - a signer node that could
 * see everybody else's commitments before dealing its own could steer the
 * group key. So the set of contributions must be exactly the committee, once
 * each, or this refuses by name.
 *
 * The signer node number must also agree across the whole set: signer node 3 in one deal and
 * signer node 5 in another are two different x, and the sum would lie on no
 * polynomial at all.
 */
export function combineShares({ opened, signerNodes, contributions, curve }) {
  if (!Array.isArray(opened) || !opened.length)
    return { ok: false, why: 'this signer node opened nothing, so it has no share' };
  if (!Array.isArray(signerNodes) || !signerNodes.length)
    return { ok: false, why: 'a combine needs the committee it is over' };
  if (!Array.isArray(contributions) || contributions.length !== signerNodes.length)
    return {
      ok: false,
      why: `${contributions ? contributions.length : 0} of the committee's ${signerNodes.length} `
        + 'signer nodes contributed, and a key a subset chose is a key that subset can steer',
    };

  const dealers = new Set(contributions.map((c) => toHex(c.from)));
  if (dealers.size !== contributions.length)
    return { ok: false, why: 'one signer node contributed twice, so it dealt after seeing the others' };
  for (const k of signerNodes)
    if (!dealers.has(toHex(k)))
      return { ok: false, why: `signer node ${toHex(k).slice(0, 16)} contributed nothing` };

  if (opened.length !== contributions.length)
    return {
      ok: false,
      why: `this signer node opened ${opened.length} of ${contributions.length} contributions, `
        + 'so its share would be a sum of some of them',
    };
  const at = new Set(opened.map((o) => o.signerNode));
  if (at.size !== 1)
    return { ok: false, why: 'this signer node was dealt different signer node numbers by different dealers' };

  // `openShare` hands back `{ signer node, value }` and the value is the scalar, so
  // the sum is over `share.value` and not over the object.
  let sum = 0n;
  for (const o of opened) {
    const v = o.share && o.share.value;
    if (typeof v !== 'bigint')
      return { ok: false, why: 'one of those is not an opened share' };
    sum = mod(sum + v);
  }
  if (sum === 0n)
    return { ok: false, why: 'this signer node\'s share summed to zero, which is no share at all' };

  // NORMALISED HERE, so a signer node never holds a share that cannot sign. A curve
  // is optional only because the epoch and the wire are measured without one;
  // a caller that means to sign passes it, and `groupKeyOf` says which way.
  if (curve) {
    // EVERY DEALER PROVED IT KNOWS ITS a0, or the key is one a dealer chose.
    for (const c of contributions) {
      const known = proofHolds(c, curve);
      if (!known.ok) return known;
    }
    const key = groupKeyOf(contributions, curve);
    if (!key.ok) return key;
    return {
      ok: true,
      share: key.negated ? mod(FIELD - sum) : sum,
      signerNode: [...at][0],
      groupPublicKey: key.groupPublicKey,
      negated: key.negated,
    };
  }
  return { ok: true, share: sum, signerNode: [...at][0] };
}

/**
 * EVERY SIGNER NODE COMBINED THE SAME CONTRIBUTIONS, OR NOBODY KEEPS A SHARE.
 *
 * Measured without this (dkg-equivocation.test.js): on a 5-of-7 committee a
 * dealer sent two DIFFERENT contributions - both with valid proofs, valid
 * shares for every signer node - to two halves of the honest signer nodes. Every check
 * passed, all six honest signer nodes finished, and they held shares of TWO group
 * keys with two pool addresses: a committee that cannot sign, and sats sent to
 * either address that could stick.
 *
 * So each signer node signs the set it combined - (dealer, contribution id) for every
 * signer node, sorted by dealer - and keeps its share only when every signer node of the
 * committee has signed the same set. A dealer who equivocates is named, by the
 * contribution the signer nodes disagree on. The price is liveness, not money: a signer node
 * that never says anything stops the key from forming, which it could always
 * do by not dealing.
 */
export const AGREEMENT_SIGNATURE_BYTES = 64;

const byDealer = (a, b) => (toHex(a.dealer) < toHex(b.dealer) ? -1 : toHex(a.dealer) > toHex(b.dealer) ? 1 : 0);

/** The set a signer node combined: one (dealer, contribution id) per contribution, sorted by dealer. */
export const contributionSetOf = (contributions) =>
  contributions.map((c) => ({ dealer: c.from, id: contributionId(c) })).sort(byDealer);

export function encodeAgreement(a) {
  const w = new Writer();
  w.u8(TYPE_DKG_AGREEMENT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(a.epochId);
  // WHO SAYS SO is in the signed bytes, so a statement cannot be moved to another signer node.
  w.bytes32(a.signerNode);
  w.vec(a.held, (h, ww) => { ww.bytes32(h.dealer); ww.bytes32(h.id); }, { sortedBy: byDealer });
  return w.finish();
}

export function decodeAgreement(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_DKG_AGREEMENT) throw new Error('not a DKG agreement');
  const version = r.u16();
  if (!speaksVersion(version)) throw new Error('protocol version ' + version);
  const a = { epochId: r.bytes32(), signerNode: r.bytes32(), held: r.vec((rr) => ({ dealer: rr.bytes32(), id: rr.bytes32() })) };
  r.end();
  return a;
}

/** What a signer node signs. */
export const agreementId = (a) => taggedHash(TAG.dkgAgreement, encodeAgreement(a));

/** A signed statement on the wire: the agreement, then its 64-byte signature. */
export function splitSignedAgreement(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length <= AGREEMENT_SIGNATURE_BYTES)
    throw new Error('that is not a signed DKG agreement');
  return {
    agreement: decodeAgreement(bytes.subarray(0, bytes.length - AGREEMENT_SIGNATURE_BYTES)),
    signature: bytes.subarray(bytes.length - AGREEMENT_SIGNATURE_BYTES),
  };
}

/**
 * DID EVERY SIGNER NODE SAY THE SAME SET? `statements` are `{ agreement, signature }`;
 * `verify(signature, digest, signerNodeKey)` is injected, as everywhere here. Two
 * valid statements that differ refuse at once, naming the dealer they differ
 * on; a signer node that has not said anything yet is waited for, by name.
 */
export function agreementHolds({ epochId: id, signerNodes, statements, verify } = {}) {
  if (typeof verify !== 'function') return { ok: false, why: 'checking an agreement needs a verifier, and none was injected' };
  if (!Array.isArray(signerNodes) || !signerNodes.length) return { ok: false, why: 'an agreement is over a committee, and that is nobody' };
  const joined = new Set(signerNodes.map(toHex));
  const said = new Map();
  for (const s of statements || []) {
    const a = s && s.agreement;
    if (!a || !same(a.epochId, id) || !joined.has(toHex(a.signerNode))) continue;
    let good = false;
    try { good = !!verify(s.signature, agreementId(a), a.signerNode); } catch { good = false; }
    if (!good) continue;
    const who = toHex(a.signerNode);
    const set = a.held.map((h) => `${toHex(h.dealer)}:${toHex(h.id)}`).join(',');
    if (said.has(who) && said.get(who).set !== set)
      return { ok: false, why: `signer node ${who.slice(0, 16)} signed two different contribution sets` };
    said.set(who, { set, held: a.held });
  }
  const sets = [...said.values()];
  for (const other of sets.slice(1)) {
    if (other.set === sets[0].set) continue;
    const mine = new Map(sets[0].held.map((h) => [toHex(h.dealer), toHex(h.id)]));
    const differ = other.held.filter((h) => mine.get(toHex(h.dealer)) !== toHex(h.id)).map((h) => toHex(h.dealer).slice(0, 16));
    return {
      ok: false,
      why: `the signer nodes hold different contribution sets - they differ on the deal of ${differ.join(', ') || 'a missing dealer'}: `
        + 'a dealer sent different contributions to different signer nodes, and combining would split the committee onto different keys',
    };
  }
  if (said.size < signerNodes.length)
    return { ok: false, have: said.size, of: signerNodes.length,
      why: `${said.size} of the committee's ${signerNodes.length} signer nodes have said which contributions they combined; all must agree before a share is kept` };
  if (sets[0].held.length !== signerNodes.length || sets[0].held.some((h) => !joined.has(toHex(h.dealer))))
    return { ok: false, why: 'the agreed set is not one contribution from every signer node of the committee' };
  return { ok: true, of: signerNodes.length };
}
