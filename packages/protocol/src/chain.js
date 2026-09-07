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
import { advertId, decodeAdvert, splitSignedAdvert } from './advert.js';
import {
  hash256, parseTransaction, commitmentsOf, witnessItemsOf,
} from './tx.js';
import { fromHex } from './hash.js';

export { hash256 };

/** A block header is exactly this, and a shorter one is not a header. */
export const HEADER_BYTES = 80;

/**
 * BITCOIN'S FIRST BLOCK, in hashing order.
 *
 * Not a parameter and not a choice: this number IS mainnet, the way a network
 * id is. Anyone can check it, it can never go stale, and no operator can
 * change it. It is here because a chain has to be anchored to something the
 * client already knows - a set of headers that link and are mined is only a
 * chain of SOMETHING, and mining a short easy one costs almost nothing.
 *
 * WHAT IT COSTS TO USE THIS ONE. Section 25.1 says "80 bytes a block; under
 * 4 MB for all of history". That figure is wrong: at 900,000 blocks it is
 * 68.7 MB, seventeen times what the spec says, and no browser will fetch it to
 * open a round. So a deployment will anchor on a later block instead - which is
 * a constant somebody must choose and keep - and choosing it is not this
 * slice's to make. What is decided here is that there MUST be one.
 */
export const BITCOIN_MAINNET_GENESIS = fromHex(
  '6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000');

/**
 * And the eighty bytes themselves, so a chain can actually START here.
 *
 * The hash above is enough to REFUSE with; this is what an honest chain has to
 * contain, and it is written down rather than fetched because it has been the
 * same eighty bytes since 2009 and will not change. Nothing takes it on trust:
 * `blockHashOf` of these bytes is the hash above, and a test says so, which is
 * the only reason to believe either of them.
 */
export const BITCOIN_MAINNET_GENESIS_HEADER = fromHex(
  '01000000000000000000000000000000000000000000000000000000000000000000000'
  + '03ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f'
  + '49ffff001d1dac2b7c');

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
 * The target a header CLAIMS, from its compact form at bytes 72..76.
 *
 * Claims, because these four bytes are written by whoever hands the header
 * over. Nothing about them is proof of anything until `meetsTarget` compares
 * them against the hash, and that is the whole reason this is a separate
 * function from the work it implies.
 */
export function targetOf(h) {
  const b = header(h);
  const exponent = b[75];
  const mantissa = (b[74] << 16) | (b[73] << 8) | b[72];
  // The high bit of the mantissa is a sign bit. A negative target is not a
  // target, and Bitcoin has never had a valid header carrying one.
  if (mantissa === 0 || (mantissa & 0x800000)) return 0n;
  return exponent <= 3
    ? BigInt(mantissa) >> BigInt(8 * (3 - exponent))
    : BigInt(mantissa) << BigInt(8 * (exponent - 3));
}

/**
 * WAS THIS HEADER ACTUALLY MINED?
 *
 * The one question that makes "most work wins" mean anything. Without it the
 * work of a chain is a number the provider chose: the difficulty lives in four
 * bytes of the header, so anybody can write down a target of 1, claim
 * 5.8 * 10^76 of work for a header nobody mined, and outweigh the whole of
 * Bitcoin by thirty-two orders of magnitude. Measured before this existed: one
 * fabricated header beat mainnet 499998-500000 by exactly that.
 *
 * The comparison is numeric, and the byte order is the usual trap: a block
 * hash is stored and displayed reversed from the way it is read as a number,
 * so it is the REVERSED bytes that must come out below the target.
 */
export function meetsTarget(h) {
  const target = targetOf(h);
  if (target <= 0n) return false;
  let value = 0n;
  for (const b of blockHashOf(h).reverse()) value = (value << 8n) | BigInt(b);
  return value <= target;
}

/**
 * The work one header stands for.
 *
 * Work is 2^256 / (target + 1), which is how much hashing the block is
 * expected to have cost. BigInt because the numbers are far past what a double
 * can hold exactly, and a comparison that silently rounded would pick the
 * wrong chain. It says nothing about whether the work was DONE - see
 * `meetsTarget` - and a caller that sums this without asking that question is
 * adding up somebody else's arithmetic.
 */
export function workOf(h) {
  const target = targetOf(h);
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
    // Before its work is added, not after: a header nobody mined contributes
    // whatever difficulty its author felt like writing down.
    if (!meetsTarget(headers[i]))
      return {
        ok: false, at: i, work: 0n,
        why: 'this header was not mined: its hash does not meet the target it claims',
      };
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
 *
 * THE SIGNATURE IS RETURNED, NOT CHECKED. 5A.1 ends the body with "signature -
 * by node_pubkey over all of the above", and this package carries no crypto on
 * purpose: a curve in here would be an implementation of the thing that pins
 * money, sitting in every consumer, that nobody audits. So a body must ARRIVE
 * signed - 64 bytes beside it, or it is not an advertisement - and the caller
 * that owns a verifier is the one that says whether the signature is good.
 * `blwp-client` refuses the session if it is not.
 */
export function acceptAdvert({ transaction, signedAdvert, header, branch, position }) {
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
  const read = (bytes) => {
    try {
      const { body, signature } = splitSignedAdvert(bytes);
      offered.push({ advert: decodeAdvert(body), signature });
    } catch { /* not a signed body; most witness items are not */ }
  };
  for (const item of witnessItemsOf(tx)) read(item);
  if (signedAdvert) read(signedAdvert);

  const taken = offered.find((o) =>
    commitments.some((c) => sameBytes(c, advertId(o.advert))));
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
  const carriesUs = taken.advert.bondTxid.every((b) => b === 0);
  if (!carriesUs && !sameBytes(taken.advert.bondTxid, tx.txid))
    return { ok: false, why: 'the advertisement names a different bond transaction' };
  if (taken.advert.bondVout >= tx.outputs.length)
    return { ok: false, why: 'the advertisement names an output that transaction does not have' };

  return {
    ok: true,
    endpoint: taken.advert.endpoint,
    nodePubkey: taken.advert.nodePubkey,
    signature: taken.signature,
    txid: tx.txid,
    advert: taken.advert,
  };
}
