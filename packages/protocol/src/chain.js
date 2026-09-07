// Reading Bitcoin without trusting whoever handed it to you.
//
// Section 25.1 is normative about this, and says why it is normative rather
// than advisory: "A client MUST verify every census entry against block
// headers it obtained independently. It MUST NOT take a census, a committee or
// an endpoint on the word of any API, including one operated by the same party
// that ships the client... A client that silently trusts a chain API behaves
// exactly like one that verifies - same screens, same rounds, same results -
// right up until the API returns a census that suits whoever runs it, and then
// the player has been playing against a committee that was never selected.
// There is no symptom to notice and nothing for the player to check."
//
// So these are the primitives that make a provider usable without being
// trusted. They fetch nothing: a proof and a header are handed in, and what
// comes back is whether they hold together. "A list provider can then OMIT but
// not FORGE, and omission is answered by asking a second one."
//
// NOTHING HERE IS BITCOIN CONSENSUS. It does not validate scripts, amounts or
// difficulty retargeting; it answers two questions only - is this transaction
// in this header's block, and which of these header chains carries the most
// work. That is what discovery needs and it is deliberately not more.
import { advertId, decodeAdvert } from './advert.js';
import {
  hash256, parseTransaction, commitmentsOf, witnessItemsOf,
} from './tx.js';

export { hash256 };

/** A block header is exactly this, and a shorter one is not a header. */
export const HEADER_BYTES = 80;

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function header(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== HEADER_BYTES)
    throw new Error(`a block header is ${HEADER_BYTES} bytes, got ${bytes && bytes.length}`);
  return bytes;
}

/** The previous block's hash, bytes 4..36, in the order the header stores it. */
export const previousHashOf = (h) => header(h).slice(4, 36);

/** The merkle root the header commits to, bytes 36..68. */
export const merkleRootOf = (h) => header(h).slice(36, 68);

/** A block's own id: the double hash of its 80 bytes. */
export const blockHashOf = (h) => hash256(header(h));

/**
 * The work one header stands for, from its compact target at bytes 72..76.
 *
 * Work is 2^256 / (target + 1), which is how much hashing the block is
 * expected to have cost. BigInt because the numbers are far past what a double
 * can hold exactly, and a comparison that silently rounded would pick the
 * wrong chain.
 */
export function workOf(h) {
  const b = header(h);
  const exponent = b[75];
  const mantissa = (b[74] << 16) | (b[73] << 8) | b[72];
  if (mantissa === 0) return 0n;
  const target = exponent <= 3
    ? BigInt(mantissa) >> BigInt(8 * (3 - exponent))
    : BigInt(mantissa) << BigInt(8 * (exponent - 3));
  if (target <= 0n) return 0n;
  return (1n << 256n) / (target + 1n);
}

/**
 * Is this a chain - each header naming the one before it - and what is it
 * worth?
 *
 * A list of headers that do not link is not a chain and is worth nothing,
 * however many of them there are. Answering with `false` rather than throwing
 * because a caller is comparing sources, and a bad source is an ordinary
 * event.
 */
export function chainWork(headers) {
  if (!headers.length) return { ok: false, why: 'no headers', work: 0n };
  let work = 0n;
  for (let i = 0; i < headers.length; i++) {
    try { header(headers[i]); } catch (e) { return { ok: false, at: i, why: e.message, work: 0n }; }
    if (i > 0 && !sameBytes(previousHashOf(headers[i]), blockHashOf(headers[i - 1])))
      return { ok: false, at: i, why: 'this header does not follow the one before it', work: 0n };
    work += workOf(headers[i]);
  }
  return { ok: true, work };
}

/**
 * Most work wins, which is Bitcoin's own rule and not a vote.
 *
 * Section 25.1: "block headers from several independent sources, most work
 * wins". A chain that does not link is not in the running at all - it is not a
 * chain - and ties go to the first source offered, so the answer does not
 * depend on the order two equal chains happened to arrive in.
 */
export function mostWork(sources) {
  let best = null;
  for (let i = 0; i < sources.length; i++) {
    const seen = chainWork(sources[i]);
    if (!seen.ok) continue;
    if (best === null || seen.work > best.work) best = { at: i, work: seen.work, headers: sources[i] };
  }
  return best;
}

/**
 * Does this header's block contain this transaction?
 *
 * BYTE ORDER IS THE TRAP HERE, and it is the reason this takes bytes rather
 * than the hex strings an API hands over. A txid is displayed reversed from
 * the way it is hashed, and so is a merkle root; the header stores the root in
 * hashing order. Everything below is in HASHING order, and a caller that
 * passes what an API printed will get a refusal rather than a wrong answer,
 * because the root will simply not match.
 *
 * `position` is the transaction's index in the block, and its bits say which
 * side each step of the branch goes on - the low bit first. That is Bitcoin's
 * encoding, not a choice made here.
 */
export function merkleRootFromProof(txid, branch, position) {
  if (!(txid instanceof Uint8Array) || txid.length !== 32)
    throw new Error('a txid is 32 bytes in hashing order');
  if (!Number.isInteger(position) || position < 0)
    throw new Error('a position is a non-negative whole number');

  let node = txid.slice();
  let index = position;
  for (const step of branch) {
    if (!(step instanceof Uint8Array) || step.length !== 32)
      throw new Error('every step of a merkle branch is 32 bytes');
    const pair = new Uint8Array(64);
    if (index & 1) { pair.set(step, 0); pair.set(node, 32); }
    else { pair.set(node, 0); pair.set(step, 32); }
    node = hash256(pair);
    index >>= 1;
  }
  return node;
}

/**
 * The whole question, in one answer: is this transaction in this block?
 *
 * This is what makes an advertisement worth reading. A provider hands over a
 * transaction and a branch; if they do not rebuild the root the header already
 * commits to, the provider is making it up, and nothing further is looked at.
 */
export function provesTransaction(headerBytes, txid, branch, position) {
  const root = merkleRootOf(headerBytes);
  try { return sameBytes(merkleRootFromProof(txid, branch, position), root); }
  catch { return false; }
}

/**
 * The whole of step 4: where do I reach this node, and why should I believe it?
 *
 * Section 5A.1: "The advertisement is not what makes a node eligible. The bond
 * output is. The advertisement is the body that the bond output commits to, so
 * that chain data alone identifies both the node and its terms."
 *
 * WHAT IS HANDED IN IS RAW BYTES, NOT FINDINGS. The transaction, a branch, a
 * header. The txid is computed from the transaction and the commitment is read
 * out of its outputs, because the earlier shape of this function took both as
 * arguments and that made the proof theatre: whoever handed over the
 * advertisement also handed over the hash of the advertisement they wanted,
 * their own txid to go with it, and every check passed. The page could put any
 * endpoint it liked behind a real block. Now the only inputs are bytes whose
 * hashes it does not control.
 *
 *   the transaction is really in the block   or a provider invented it
 *   an output really commits to THIS body    or a provider swapped the endpoint
 *
 * The second is the one that matters in practice, because a swapped endpoint
 * is invisible: the node is real, the bond is real, and the player connects to
 * whoever the provider preferred. So the answer names which failed.
 *
 * The body may come from the transaction's own witness (25.1: "the body of
 * 5A.1 is carried in the witness of the funding transaction") or be handed in
 * beside it. It does not matter which, and that is the point - the witness is
 * not covered by the txid, so a body from either place has to earn its standing
 * from the committed output, and one that cannot is refused the same way.
 */
export function acceptAdvert({ transaction, advert, header, branch, position }) {
  let tx;
  try { tx = parseTransaction(transaction); }
  catch (e) { return { ok: false, why: `that is not a transaction: ${e.message}` }; }

  if (!provesTransaction(header, tx.txid, branch, position))
    return { ok: false, why: 'the transaction is not in that block' };

  const commitments = commitmentsOf(tx);
  if (!commitments.length)
    return { ok: false, why: 'no output of that transaction commits to anything' };

  // Every body on offer, from the witness first, and the one handed in last:
  // order decides nothing, since a body is taken only if an output commits to
  // it, and a transaction that committed to two of them would be one operator
  // advertising twice rather than an ambiguity to resolve here.
  const offered = [];
  for (const item of witnessItemsOf(tx)) {
    try { offered.push(decodeAdvert(item)); } catch { /* not a body; most are not */ }
  }
  if (advert) offered.push(advert);

  const taken = offered.find((body) =>
    commitments.some((c) => sameBytes(c, advertId(body))));
  if (!taken)
    return { ok: false, why: 'the bond output commits to a different advertisement' };

  // The advertisement must point back at the bond that gives it standing, or
  // it says where to reach somebody with nothing to say why they count. An
  // all-zero txid is the only value a body CAN carry when it rides in the
  // transaction it names - 5A.1 makes bond_outpoint mandatory and 25.1 puts
  // the body in the same transaction, so the txid is not knowable when the
  // body is signed. Reading it as "the transaction carrying me" is the only
  // reading available; which output is the bond still waits on BOND_MARKER,
  // and neither is settled here.
  const carriesUs = taken.bondTxid.every((b) => b === 0);
  if (!carriesUs && !sameBytes(taken.bondTxid, tx.txid))
    return { ok: false, why: 'the advertisement names a different bond transaction' };
  if (taken.bondVout >= tx.outputs.length)
    return { ok: false, why: 'the advertisement names an output that transaction does not have' };

  return {
    ok: true,
    endpoint: taken.endpoint,
    nodePubkey: taken.nodePubkey,
    txid: tx.txid,
    advert: taken,
  };
}
