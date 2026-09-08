// THE BOND OUTPUT KEY, AND WHY IT IS THE ONLY THING A VERIFIER CAN CHECK.
//
// 5A.3B builds the bond as a P2TR output with three spend paths:
//
//     key path      MuSig2(node_key, arbitration_aggregate_key)
//     script path A <node_key> CHECKSIGVERIFY
//                   <bond_maturity> CHECKLOCKTIMEVERIFY DROP
//     script path B <k-of-m arbitration keys> CHECKMULTISIG
//
// A TAPROOT OUTPUT SHOWS NOTHING UNTIL IT IS SPENT - which is the whole reason
// 5A.3B chose it: "a cooperative release and a cooperative slash are the same
// transaction", and an observer cannot tell a bond was here. So "check the
// script" can never mean READ the script. It means RECOMPUTE: given the keys
// and the maturity a node declares, rebuild the tree, take the tweak, and see
// whether the 32 bytes on chain are the answer. Construction and verification
// are therefore one function used twice, and the second use is what closes
// `BOND_UNCHECKED`'s last entry for anyone holding the declared inputs.
//
// THE CURVE IS INJECTED. Everything here is hashing and byte layout, which
// this package may do; the single point addition Q = P + t*G is not, because
// this is the package every other one reads and it carries no curve. The
// caller passes `tweakPoint`, exactly as 23's advertisement check passes
// `verifyAdvert`.
//
// THE LEAVES ARE THE SPEND PROGRAMS, SO THEY HAVE TO RUN.
//
// 5A.3B writes path A as `<node_key> CHECKSIGVERIFY <bond_maturity>
// CHECKLOCKTIMEVERIFY DROP` and path B with CHECKMULTISIG. Neither would ever
// spend: the first ends with DROP and therefore an EMPTY stack, and Bitcoin
// requires a true left on it; the second uses an opcode tapscript removed
// (BIP-342), so the leaf is invalid the moment it is revealed.
//
// A leaf is not documentation. It is the program that moves the money, and its
// hash is in the output key - so hashing the faults would mean either a bond
// that can never pay out, or changing the key later and invalidating every
// bond already posted. The whitepaper is intent; it is not a licence to hash
// an unspendable script, exactly as a leftover constant in C# was not a
// licence to copy a wrong unit.
//
// So the INTENT is implemented:
//
//   path A   <maturity> CLTV DROP <node_key> CHECKSIG
//            the timelock first, then the signature that leaves the true
//   path B   <k1> CHECKSIG <k2> CHECKSIGADD ... <km> CHECKSIGADD <k> NUMEQUAL
//            BIP-342's own counting form, which is what tapscript runs
//
// Both say what 5A.3B says - the node alone after maturity, the quorum before
// it - in bytes that a node can actually spend with.
import { taggedHash } from './hash.js';

/** BIP-341's leaf version for tapscript. */
export const TAPLEAF_VERSION = 0xc0;

const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_DROP = 0x75;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGADD = 0xba;
const OP_NUMEQUAL = 0x9c;

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const is32 = (b) => b instanceof Uint8Array && b.length === 32;

/** Bitcoin's minimal push of a number, as a script encodes a locktime. */
function pushNumber(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('a locktime is a whole number of blocks or seconds');
  if (n === 0) return Uint8Array.from([0x00]);
  if (n >= 1 && n <= 16) return Uint8Array.from([0x50 + n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.push(v & 0xff); v >>>= 8; }
  // A leading byte of 0x80 or more would read as negative, so it is padded.
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Uint8Array.from([bytes.length, ...bytes]);
}

/** OP_1..OP_16 for the small numbers a k-of-m uses. */
const smallNumber = (n) => {
  if (!Number.isInteger(n) || n < 1 || n > 16)
    throw new RangeError(`a k-of-m needs 1..16, got ${n}`);
  return Uint8Array.from([0x50 + n]);
};

const pushKey = (key) => {
  if (!is32(key)) throw new TypeError('a taproot key is 32 bytes');
  return cat(Uint8Array.from([0x20]), key);
};

/**
 * PATH A, THE RECOVERY LEAF: the node alone, after maturity.
 *
 * `bond_maturity` is why this exists at all - 5A.3B: "arbitration can never
 * freeze a bond forever: if arbitration disappears, path A returns the money
 * to its owner." A bond whose only way out needed somebody else's cooperation
 * is not one anybody should post.
 */
export function recoveryLeaf(nodeKey, bondMaturity) {
  // THE LOCKTIME FIRST, THEN THE SIGNATURE. CLTV leaves its own argument on
  // the stack, so it is dropped and the signature check supplies the true the
  // script must end with. The other order - the spec's - ends on DROP with
  // nothing left, and a script that ends empty does not spend.
  return cat(pushNumber(bondMaturity),
    Uint8Array.from([OP_CHECKLOCKTIMEVERIFY, OP_DROP]),
    pushKey(nodeKey), Uint8Array.from([OP_CHECKSIG]));
}

/**
 * PATH B, THE SLASH LEAF: k of m arbitration keys, before maturity.
 *
 * The keys are sorted, because a leaf whose bytes depended on the order
 * somebody listed them in would give one node several different output keys
 * for one arrangement, and a verifier could not say which was meant.
 */
export function slashLeaf(arbitrationKeys, k) {
  if (!Array.isArray(arbitrationKeys) || !arbitrationKeys.length)
    throw new TypeError('a slash leaf needs the arbitration keys');
  for (const key of arbitrationKeys) if (!is32(key)) throw new TypeError('an arbitration key is 32 bytes');
  const sorted = [...arbitrationKeys].sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  if (k > sorted.length) throw new RangeError(`${k} of ${sorted.length} cannot be satisfied`);

  // BIP-342'S COUNTING FORM, because tapscript removed CHECKMULTISIG: the
  // first key checks and leaves 0 or 1, every later key ADDS to that running
  // count, and the total is compared with k. A spender supplies an empty
  // signature for each key it does not have, which counts as zero without
  // failing the script.
  const parts = [pushKey(sorted[0]), Uint8Array.from([OP_CHECKSIG])];
  for (const key of sorted.slice(1)) {
    parts.push(pushKey(key), Uint8Array.from([OP_CHECKSIGADD]));
  }
  parts.push(smallNumber(k), Uint8Array.from([OP_NUMEQUAL]));
  return cat(...parts);
}

/** BIP-341: tagged_hash("TapLeaf", version || compact_size(script) || script). */
export function tapLeafHash(script, version = TAPLEAF_VERSION) {
  if (script.length > 252) throw new RangeError('this template writes no script that long');
  return taggedHash('TapLeaf', cat(Uint8Array.from([version, script.length]), script));
}

/** BIP-341: tagged_hash("TapBranch", the two children in lexicographic order). */
export function tapBranchHash(a, b) {
  for (let i = 0; i < 32; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? taggedHash('TapBranch', cat(a, b)) : taggedHash('TapBranch', cat(b, a));
  }
  return taggedHash('TapBranch', cat(a, b));
}

/** BIP-341: t = tagged_hash("TapTweak", internal_key || merkle_root). */
export const tapTweak = (internalKey, merkleRoot) =>
  taggedHash('TapTweak', cat(internalKey, merkleRoot));

/**
 * THE WHOLE TREE, AS HASHES: the two leaves, their branch, and the tweak.
 *
 * Returned separately from the output key because everything here is this
 * package's to compute and the last step is not.
 */
export function bondTapTree({ nodeKey, arbitrationKeys, arbitrationK, bondMaturity, internalKey }) {
  if (!is32(internalKey)) throw new TypeError('the internal key is 32 bytes');
  const a = tapLeafHash(recoveryLeaf(nodeKey, bondMaturity));
  const b = tapLeafHash(slashLeaf(arbitrationKeys, arbitrationK));
  const merkleRoot = tapBranchHash(a, b);
  return { recovery: a, slash: b, merkleRoot, tweak: tapTweak(internalKey, merkleRoot) };
}

/**
 * THE OUTPUT KEY ITSELF: Q = P + t*G, with the point addition done by the
 * caller's curve.
 *
 * `internalKey` is 5A.3B's MuSig2(node_key, arbitration_aggregate_key), which
 * this package also cannot compute - aggregating is curve work. A caller that
 * brought a different internal key gets a different Q and its bond will not
 * recompute, which is the check doing its job rather than a special case.
 */
export function bondOutputKey(inputs, { tweakPoint } = {}) {
  if (typeof tweakPoint !== 'function')
    return { ok: false, why: 'no curve was given to add the tweak with' };
  let tree;
  try { tree = bondTapTree(inputs); }
  catch (e) { return { ok: false, why: e.message }; }

  let outputKey;
  try { outputKey = tweakPoint(inputs.internalKey, tree.tweak); }
  catch (e) { return { ok: false, why: `that curve refused the tweak: ${e.message}` }; }
  if (!is32(outputKey)) return { ok: false, why: 'that curve did not return a 32-byte key' };

  return { ok: true, outputKey, ...tree };
}

/**
 * AND THE SAME FUNCTION AGAIN, ASKED THE OTHER WAY: are these 32 bytes on
 * chain the output key these inputs produce?
 *
 * Refused by name, because the three ways it can fail are three different
 * mistakes: a key that is not the node's, a maturity that is not the
 * network's, and a tree that is not this template.
 */
export function bondOutputKeyMatches(onChain, inputs, { tweakPoint } = {}) {
  if (!is32(onChain)) return { ok: false, why: 'that is not a 32-byte taproot output key' };
  const built = bondOutputKey(inputs, { tweakPoint });
  if (!built.ok) return built;
  if (!built.outputKey.every((b, i) => b === onChain[i])) {
    return {
      ok: false,
      why: 'that output key is not the taproot tweak of the keys and maturity it declares',
    };
  }
  return { ok: true, ...built };
}
