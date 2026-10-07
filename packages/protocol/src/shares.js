// THE STAKE PREIMAGE, SPLIT SEVEN WAYS SO FIVE CAN PUT IT BACK.
//
// Section 23.1: "The player splits P with verifiable secret sharing (Shamir,
// threshold 5-of-7) and encrypts one share to each settlement-committee
// member; vss_shares_ref points at the published shares. Verifiability means
// each node can confirm its share is consistent without reconstructing P."
//
// And 23.4 says what it buys: "Settling a loser's HTLC requires reconstructing
// P, which requires 5 of the 7 shares, which the mechanical rule releases only
// against a FINAL result." So four colluding settlement nodes hold nothing at
// all, and that is the property measured here rather than asserted.
//
// THE FIELD IS SECP256K1'S SCALAR ORDER, and it is not a free choice. Feldman
// commits to a polynomial by publishing g^a for each coefficient, so the
// exponents have to be scalars OF THE GROUP the commitments live in - and the
// group is the curve this system already trusts for bonds and BIP-340, because
// a second group would be a second thing to audit for one property.
//
// It used to be 2^521 - 1, a Mersenne prime chosen so a 32-byte preimage fit
// with room to spare. The order is a little BELOW 2^256, so that room is gone
// and a 32-byte preimage can be too large - about one in 2^128, and it is
// REFUSED BY NAME rather than reduced. Reducing would change the number whose
// hash the player already put in the Entry Contract, so the shares would open
// a preimage the payment hash does not name.
//
// Every operation is exact integer arithmetic on BigInt. No float goes near
// this, for the same reason none goes near the payout table.
//
// WHAT "VERIFIABLE" MEANS, IN TWO LAYERS THAT CATCH DIFFERENT THINGS.
//
// The first is a hash commitment per share: a holder checks the value it was
// handed against the value that was published for its signer node, so a share
// corrupted in transit or swapped by whoever passed it on is caught. It says
// nothing about the DEALER, because the dealer wrote both.
//
// The second is Feldman, and it is what 23.1's "verifiability" is for. The
// dealer publishes g^a for every coefficient, and a signer node checks
//
//     g^(its share)  ==  product of C_j ^ (its signer node number ^ j)
//
// which holds only if that share lies on the ONE polynomial those commitments
// describe. It is checked without reconstructing anything and by anybody, not
// only by the holder.
//
// THE HOLE THIS CLOSES, MEASURED RATHER THAN ASSERTED. A dealer who splits
// with two polynomials and gives three signer nodes the second one hands out seven
// shares that each pass their own hash commitment, and leaves NONE of the
// twenty-one five-subsets able to open the committed P - a stake that can
// never be settled, dealt by the player who stakes it. With the polynomial
// commitments those three signer nodes refuse the share the moment they are handed
// it, so the entry never becomes an entry.
//
// THE GROUP IS INJECTED, like every other curve operation in this package.
// `packages/protocol` carries no curve on purpose - it does the arithmetic and
// the refusals, and whoever has a curve brings it.
import { taggedHash, toHex } from './hash.js';
import { TAG } from './constants.js';
import { sha256bytes } from './sha256.js';

/**
 * secp256k1's group order. Written out rather than imported, because this
 * package holds no curve - a constant is a number and a curve is code.
 */
export const FIELD =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** 5-of-7, the same threshold as the receipts and the signatures. */
export const SHARES_NEEDED = 5;
export const SHARES_TOTAL = 7;

const mod = (n) => ((n % FIELD) + FIELD) % FIELD;

/** Fermat, since the field is prime: a^(p-2) is a's inverse. */
function inverse(a) {
  let result = 1n;
  let base = mod(a);
  let e = FIELD - 2n;
  while (e > 0n) {
    if (e & 1n) result = mod(result * base);
    base = mod(base * base);
    e >>= 1n;
  }
  return result;
}

/**
 * A scalar and its 32 bytes, exported because the wire needs the same pair.
 *
 * `handout.js` encodes share values and would otherwise declare its own copy -
 * which the bundler refuses by name, and rightly: two functions with one name
 * in one scope is a program whose behaviour depends on file order.
 */
export const scalarFrom32 = (bytes) => {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
};
export const scalarTo32 = (v) => {
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
  if (n !== 0n) throw new Error('that value does not fit in 32 bytes');
  return out;
};

/** What a signer node can check its own share against, without reconstructing. */
export const shareCommitment = (signerNode, value) =>
  taggedHash(TAG.vssShare, new TextEncoder().encode(`${signerNode}:${value.toString(16)}`));

/**
 * Split a 32-byte secret into `signer nodes` shares, `needed` of which rebuild it.
 *
 * The polynomial's constant term is the secret and the rest are the caller's
 * randomness - injected, because this package has no business deciding where
 * randomness comes from, and a test needs the same split twice.
 */
export function splitSecret(secret, { signerNodes = SHARES_TOTAL, needed = SHARES_NEEDED,
  coefficients, curve } = {}) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32)
    throw new Error('a stake preimage is 32 bytes');
  // BELOW THE ORDER, OR IT IS NOT A SCALAR. About one preimage in 2^128 is
  // not, and the answer is another preimage rather than this one reduced:
  // reducing changes the number the payment hash already commits to, so the
  // shares would open something the Entry Contract does not name.
  if (scalarFrom32(secret) >= FIELD)
    throw new Error('that preimage is not below the group order: generate another, '
      + 'because reducing it would change the number its payment hash commits to');
  if (!Number.isInteger(needed) || needed < 2)
    throw new Error('a threshold below two is not a threshold');
  if (!Number.isInteger(signerNodes) || signerNodes < needed)
    throw new Error(`${signerNodes} signer nodes cannot carry a threshold of ${needed}`);
  if (!Array.isArray(coefficients) || coefficients.length !== needed - 1)
    throw new Error(`a threshold of ${needed} needs ${needed - 1} coefficients`);

  const a = [scalarFrom32(secret), ...coefficients.map(mod)];
  const shares = [];
  for (let signerNode = 1; signerNode <= signerNodes; signerNode++) {
    let value = 0n;
    for (let j = a.length - 1; j >= 0; j--) value = mod(value * BigInt(signerNode) + a[j]);
    shares.push({ signerNode, value, commitment: shareCommitment(signerNode, value) });
  }

  // AND THE POLYNOMIAL ITSELF, WHEN THERE IS A GROUP TO COMMIT IN. One point
  // per coefficient, the constant term first - so C_0 is g^P, which is why a
  // signer node can check its share against the polynomial without anybody learning
  // P: the discrete log is the whole security of it.
  const commitments = curve
    ? a.map((coefficient) => curve.pointFromScalar(coefficient))
    : undefined;
  return { shares, needed, signerNodes, ...(commitments ? { commitments } : {}) };
}

/**
 * DOES THIS SHARE LIE ON THE POLYNOMIAL THE DEALER PUBLISHED?
 *
 * Feldman: g^s must equal the product of C_j raised to (signer node ^ j). A signer node
 * checks this on its own, learns nothing about P by doing it, and refuses at
 * HANDOUT rather than leaving a stake that no five signer nodes can ever settle.
 *
 * A SIGNER NODE WITH NO COMMITMENTS REFUSES, and that is not pedantry: "I was given
 * no way to check" and "I checked and it is fine" are different answers, and a
 * function that returned the second for the first would make the whole layer
 * optional at the dealer's choice.
 */
export function shareOpensTo(share, { commitments, curve } = {}) {
  if (!share || !Number.isInteger(share.signerNode) || share.signerNode < 1)
    return { ok: false, why: 'that is not a share of any signer node' };
  if (!Array.isArray(commitments) || commitments.length === 0)
    return { ok: false, why: 'this share names no polynomial, so nothing about the dealer can be checked' };
  if (!curve || typeof curve.pointFromScalar !== 'function'
      || typeof curve.combinePoints !== 'function')
    return { ok: false, why: 'checking a share against a polynomial needs a group, and none was injected' };

  const terms = [];
  let power = 1n;
  for (const point of commitments) {
    terms.push({ point, coefficient: power });
    power = mod(power * BigInt(share.signerNode));
  }

  const wanted = curve.combinePoints(terms);
  const got = curve.pointFromScalar(mod(share.value));
  if (toHex(got) !== toHex(wanted))
    return {
      ok: false,
      why: `signer node ${share.signerNode} was handed a share that is not on the polynomial the dealer published`,
    };
  return { ok: true, why: `signer node ${share.signerNode} lies on the published polynomial` };
}

/**
 * EVERY SIGNER NODE'S OWN CHECK, AND WHAT THE HANDOUT LOOKS LIKE FROM OUTSIDE.
 *
 * This is not a committee decision and it is not settlement: it is each signer node
 * doing what 23.1 gives it to do, collected so the dealer's handout can be
 * described by a number. `refused` is the figure this letter moves.
 */
export function checkHandout({ shares, commitments, curve, published } = {}) {
  if (!Array.isArray(shares) || shares.length === 0)
    throw new Error('a handout of no shares is not a handout');

  const signerNodes = [];
  for (let i = 0; i < shares.length; i++) {
    const share = shares[i];
    const against = published ? published[i] : share.commitment;
    // A HANDOUT ON THE WIRE CARRIES NO PER-SHARE HASH, and that is right: the
    // hash commitment answers "is this the value published for this signer node",
    // and on the wire the bytes ARE that value - the entry's `vss_shares_ref`
    // is what binds them. So with nothing to compare against, the transit half
    // does not apply and the polynomial half is the whole check. It is skipped
    // rather than passed silently: `why` still comes from the check that ran.
    const transit = against === undefined ? true : shareIsConsistent(share, against);
    const dealer = shareOpensTo(share, { commitments, curve });
    // BOTH HALVES THROUGH THE ONE DOOR TOO, so the collected answer and a
    // single signer node's own answer can never disagree about the same share.
    if (against !== undefined && transit
        && dealer.ok !== shareIsConsistent(share, against, { commitments, curve }))
      throw new Error(`signer node ${share.signerNode}: the two ways of asking disagree`);
    signerNodes.push({
      signerNode: share.signerNode,
      ok: transit && dealer.ok,
      why: !transit
        ? `signer node ${share.signerNode} was handed a value that is not the one published for it`
        : dealer.why,
    });
  }
  const refused = signerNodes.filter((s) => !s.ok);
  return {
    ok: refused.length === 0,
    signerNodes,
    refused: refused.length,
    accepted: signerNodes.length - refused.length,
    why: refused.length === 0
      ? `all ${signerNodes.length} signer nodes lie on one polynomial`
      : `${refused.length} of ${signerNodes.length} signer nodes refused their share: `
        + refused.map((s) => s.why).join('; '),
  };
}

/**
 * IS THIS SHARE CONSISTENT - with what was published for its signer node, and with
 * the polynomial the dealer published?
 *
 * Two questions and they catch different things, which is why both are here
 * and why the second is optional rather than folded into the first. The hash
 * commitment says the value is the one published for this signer node: it catches
 * transit and a swap by whoever passed it on, and it is BLIND to the dealer,
 * who wrote both sides of it. Given the polynomial as well, this also asks
 * 23.1's own question - is the share on the one polynomial - which is the
 * question a dishonest dealer fails.
 *
 * Called with two arguments it is exactly what it always was, and the test
 * that measures the blindness calls it that way on purpose.
 */
export function shareIsConsistent(share, commitment, { commitments, curve } = {}) {
  if (toHex(shareCommitment(share.signerNode, share.value)) !== toHex(commitment)) return false;
  if (commitments === undefined && curve === undefined) return true;
  return shareOpensTo(share, { commitments, curve }).ok;
}

/**
 * Put the secret back from `needed` shares, and refuse below that.
 *
 * REFUSES, rather than answering something. Four shares interpolate a
 * perfectly good polynomial of their own - they simply do not name P - and a
 * function that handed that back would be handing back a wrong preimage that
 * looks exactly like a right one.
 */
export function reconstruct(shares, { needed = SHARES_NEEDED, stakeCommitment } = {}) {
  const signerNodes = new Set(shares.map((s) => s.signerNode));
  if (signerNodes.size !== shares.length)
    throw new Error('two shares for one signer node are one share');
  if (shares.length < needed)
    throw new Error(`${shares.length} shares cannot reconstruct anything: ${needed} are needed`);

  const use = shares.slice(0, needed);
  let secret = 0n;
  for (let i = 0; i < use.length; i++) {
    let term = use[i].value;
    for (let j = 0; j < use.length; j++) {
      if (i === j) continue;
      const xi = BigInt(use[i].signerNode);
      const xj = BigInt(use[j].signerNode);
      term = mod(term * mod(-xj) * inverse(xi - xj));
    }
    secret = mod(secret + term);
  }
  const opened = scalarTo32(secret);

  // AND IF THE COMMITMENT IS TO HAND, THE ANSWER IS CHECKED AGAINST IT.
  //
  // Measured: a dealer who splits with two polynomials hands out seven shares
  // that each pass their own signer node, and of the twenty-one five-subsets, TWO
  // still produce a well-formed 32-byte value that is not P. Handed back
  // unchecked, that is a wrong preimage which looks exactly like a right one.
  // `stakeCommitment` is H(P) and it is in the entry contract the player
  // signed, so a caller settling a stake always has it.
  if (stakeCommitment !== undefined) {
    if (toHex(sha256bytes(opened)) !== toHex(stakeCommitment))
      throw new Error('those shares rebuild something that is not the committed preimage');
  }
  return opened;
}

/**
 * Try every combination of `needed` shares until one opens the committed
 * preimage, and say how the whole set behaved.
 *
 * This is what a settlement committee actually does, and it is also the
 * measurement of the hole below it: a dealer is free to hand out shares that
 * each pass their signer node and yet leave NO subset able to open P.
 */
export function openStake(shares, { needed = SHARES_NEEDED, stakeCommitment } = {}) {
  const subsets = [];
  const walk = (from, taken) => {
    if (taken.length === needed) { subsets.push(taken.slice()); return; }
    for (let i = from; i < shares.length; i++) { taken.push(shares[i]); walk(i + 1, taken); taken.pop(); }
  };
  walk(0, []);

  let opened = null;
  let openedBy = null;
  let refused = 0;
  for (const five of subsets) {
    try {
      const back = reconstruct(five, { needed, stakeCommitment });
      if (opened === null) { opened = back; openedBy = five.map((s) => s.signerNode); }
    } catch { refused++; }
  }
  return {
    ok: opened !== null,
    preimage: opened,
    openedBy,
    subsets: subsets.length,
    opens: subsets.length - refused,
    refused,
    why: opened === null
      ? `none of the ${subsets.length} ways to pick ${needed} shares opens the committed preimage`
      : `opened by signer nodes ${openedBy.join(',')}`,
  };
}

/**
 * A HANDOUT NO FIVE SIGNER NODES CAN OPEN IS THE DEALER'S DOING.
 *
 * The player IS the dealer of their own stake preimage: 23.1 has them split P
 * and encrypt one share to each settlement signer node. A handout where no five of
 * the seven open the committed P did not happen to anybody - it was made, and
 * only the player could have made it. Measured: three signer nodes given a second
 * polynomial's share leaves 0 of the 21 subsets able to open it, while all
 * seven still pass their holders' checks.
 *
 * SO IT IS FORFEIT AND NOT VOID, and the difference is the whole of it. VOID
 * is the operator-fault path - nobody acts, the HTLC expires, the stake goes
 * home - so classifying a sabotaged handout as VOID would hand a losing player
 * their money back for having broken the settlement themselves. That is the
 * same family as escaping by disconnect, and 13C is explicit that the only way
 * a player can cause a failure is one that forfeits.
 *
 * NOT A JUDGEMENT, AND NOT A GUESS. A settlement committee that cannot open a
 * preimage has tried every subset; `openStake` is that attempt, and this reads
 * its answer. A handout that opens is nothing to do with this function.
 */
export function handoutOutcome(opened) {
  if (!opened || typeof opened.ok !== 'boolean')
    throw new Error('that is not an answer from openStake');
  if (opened.ok)
    return { outcome: null, why: `the preimage opened: ${opened.why}` };
  return {
    outcome: 'FORFEIT',
    why: `no five of the seven shares open the committed preimage, and the player `
      + 'dealt them: sabotaging settlement of your own stake is not the operator\'s fault',
  };
}
