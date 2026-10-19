// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

/**
 * WHICH TEMPLATE THESE BYTES ARE.
 *
 * 5A.1's advertisement carries `bond_script_template_version`, and until now
 * it was written to the wire, read back, and compared with nothing - a number
 * that meant whatever its reader assumed. Two nodes could read one version as
 * two trees and disagree about a bond without either being wrong.
 *
 * Version one is THIS tree: a recovery leaf of `<maturity> CLTV DROP
 * <node_key> CHECKSIG`, a slash leaf of BIP-342 CHECKSIGADD counting to k, and
 * a taproot output over the MuSig2 aggregate of the node and arbitration keys.
 * A body naming any other version is a body this code cannot rebuild, and it
 * says so rather than guessing.
 */
export const BOND_SCRIPT_TEMPLATE_VERSION = 1;

/**
 * TEMPLATE 2: THE SAME TREE, AT THE BOND'S OWN MATURITY (spec 5A.3B: "`bond_maturity` is an absolute
 * locktime, reference 30 days after the bond confirms").
 *
 * Template 1 put genesis' `bondMaturity` in the recovery leaf - 100 on regtest AND on testnet4. That is a height, not a
 * duration: on testnet4 (tip near 156 000) path A of every bond was spendable the block it confirmed. Template 2 is the
 * same two leaves with the bond's own height in the CLTV, carried in its advertisement as `bond_maturity_height`, and a
 * census counts it only when that height is at least the block the bond confirmed in plus this network's offset.
 *
 * The offset sits here, beside genesis and not in it (2026-10-11, the plan): a genesis field would move
 * testnet4's network id, its series and every re-affirmation for a number no round reads.
 */
export const BOND_TEMPLATE_V2 = 2;

/** Blocks from a template-2 bond's confirmation to its maturity: ~30 days, ~1 day, regtest's 100 (5A.3B networks table). */
export const BOND_MATURITY_OFFSET = Object.freeze({ mainnet: 4320, testnet4: 144, regtest: 100 });

/**
 * WHERE TEMPLATE 1 IS STILL READ: the networks whose bonds were posted at genesis' fixed height before template 2 existed
 * - testnet4's seven, until they are re-bonded, and regtest's fixtures. Never mainnet: there a bond at a passed height is
 * a bond withdrawable the block it is posted, which is the Sybil door 5A.3 exists to shut.
 */
export const BOND_V1_READABLE = Object.freeze(['regtest', 'testnet4']);

/** BIP-65: a CLTV argument at or above this is a time, not a height. */
const LOCKTIME_THRESHOLD = 500000000;

/**
 * THE MATURITY A BOND'S RECOVERY LEAF CARRIES, off its advertisement: genesis' for template 1, the advertisement's own
 * `bondMaturityHeight` for template 2. Refused by name for any other template, for a template 1 on a network that no
 * longer reads it, and for a height that is not a block height.
 */
export function bondMaturityOf(advert, { genesisMaturity, network } = {}) {
  const v = advert && advert.bondScriptTemplateVersion;
  if (v === BOND_SCRIPT_TEMPLATE_VERSION) {
    if (network !== undefined && !BOND_V1_READABLE.includes(network))
      return { ok: false, why: `bond script template 1 is not read on ${network}: its maturity is genesis' fixed height, not the bond's` };
    if (!Number.isInteger(genesisMaturity))
      return { ok: false, why: 'no bond maturity was given to rebuild the bond with' };
    return { ok: true, maturity: genesisMaturity };
  }
  if (v === BOND_TEMPLATE_V2) {
    const h = advert.bondMaturityHeight;
    if (!Number.isInteger(h) || h < 1 || h >= LOCKTIME_THRESHOLD)
      return { ok: false, why: `that advertisement's bond_maturity_height ${h} is not a block height` };
    return { ok: true, maturity: h };
  }
  return { ok: false, why: `that advertisement names bond script template ${v}, and this code reads templates 1 and 2` };
}

/**
 * WHETHER A TEMPLATE-2 BOND'S MATURITY IS FAR ENOUGH FROM ITS CONFIRMATION (5A.3B): at least `confirmationHeight` plus
 * this network's offset. A later height is the node's own choice and only keeps its money longer; an earlier one is a
 * bond the node can take back before the network's maturity, and is not counted. Template 1 answers ok where it is
 * still read (`bondMaturityOf` refuses it elsewhere).
 */
export function maturityStands(advert, confirmationHeight, network) {
  if (!advert || advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V2) return { ok: true };
  const offset = BOND_MATURITY_OFFSET[network];
  if (!Number.isInteger(offset)) return { ok: false, why: `no bond maturity offset is set for ${network}` };
  if (!Number.isInteger(confirmationHeight))
    return { ok: false, why: 'no confirmation height is known to measure that bond\'s maturity from' };
  const want = confirmationHeight + offset;
  const h = advert.bondMaturityHeight;
  if (!Number.isInteger(h) || h < want)
    return { ok: false, why: `that bond matures at height ${h}, ${want - h} block(s) short of its confirmation ${confirmationHeight} plus ${offset}` };
  return { ok: true, maturity: h, want };
}

/** The maturity height a node writes into a new template-2 bond: the next block plus the offset plus `slackBlocks` it may wait for. */
export function maturityHeightFor(tipHeight, network, { slackBlocks = 6 } = {}) {
  const offset = BOND_MATURITY_OFFSET[network];
  if (!Number.isInteger(offset)) throw new Error(`no bond maturity offset is set for ${network}`);
  return tipHeight + 1 + slackBlocks + offset;
}

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

// Named for this file: the bundler flattens every module into one scope, so a
// helper called is32 here and is32 in contracts.js would be two values under
// one name for whoever reads it last.
const isKey32 = (b) => b instanceof Uint8Array && b.length === 32;

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
  if (!isKey32(key)) throw new TypeError('a taproot key is 32 bytes');
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
  for (const key of arbitrationKeys) if (!isKey32(key)) throw new TypeError('an arbitration key is 32 bytes');
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
 * THE INTERNAL KEY IS DERIVED, NOT CHOSEN.
 *
 * 5A.3B: the key path is `MuSig2(node_key, arbitration_aggregate_key)`, and
 * it is the path that moves the money without revealing anything - "a
 * cooperative release and a cooperative slash are the same transaction". A
 * template that ACCEPTED thirty-two bytes for it would let whoever calls it
 * choose that path: a node could post a bond whose cooperative spend is a key
 * only it holds, and every check would pass, because the internal key was an
 * input to the check rather than a fact derived from the named keys. That is
 * the fault taken out of the census depth, the committee size, the bond floor
 * and the payout table, on the one path where nobody would ever see it.
 *
 * BIP-327's KeyAgg, and the coefficients are this package's to compute:
 *
 *     L    = H("KeyAgg list", pk1 || pk2 || ... )
 *     a_i  = H("KeyAgg coefficient", L || pk_i)      with a_i = 1 for the
 *            SECOND distinct key, which is BIP-327's own optimisation
 *     Q    = sum a_i * P_i
 *
 * The sum is curve work and belongs to the caller, like every other point
 * operation here. The coefficients are hashing, which is this package's.
 *
 * KEY AGGREGATION ONLY. No session, no nonces, nothing signed: this says what
 * the key IS, not how it is used.
 */
export function keyAggCoefficients(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new TypeError('an aggregate needs keys');
  for (const key of keys) if (!isKey32(key)) throw new TypeError('an aggregated key is 32 bytes');

  const list = taggedHash('KeyAgg list', cat(...keys));

  // BIP-327 gives the SECOND DISTINCT key a coefficient of one, so the common
  // two-key case costs one multiplication instead of two. Skipping it would
  // produce a self-consistent aggregate that no other MuSig2 implementation
  // agrees with - and a key path nobody else can sign is a key path that does
  // not exist.
  let second = null;
  for (const key of keys) {
    if (!sameKey(key, keys[0])) { second = key; break; }
  }

  return keys.map((key) => ({
    key,
    coefficient: second && sameKey(key, second)
      ? ONE_COEFFICIENT
      : taggedHash('KeyAgg coefficient', cat(list, key)),
  }));
}

const sameKey = (a, b) => a.every((v, i) => v === b[i]);
const ONE_COEFFICIENT = (() => {
  const one = new Uint8Array(32);
  one[31] = 1;
  return one;
})();

/**
 * The aggregate itself, with the caller's curve doing the sum.
 */
export function aggregateKeys(keys, { combine } = {}) {
  if (typeof combine !== 'function')
    return { ok: false, why: 'no curve was given to add the keys with' };
  let terms;
  try { terms = keyAggCoefficients(keys); }
  catch (e) { return { ok: false, why: e.message }; }

  let key;
  try { key = combine(terms); }
  catch (e) { return { ok: false, why: `that curve refused the aggregate: ${e.message}` }; }
  if (!isKey32(key)) return { ok: false, why: 'that curve did not return a 32-byte aggregate' };
  return { ok: true, key, terms };
}

/**
 * 5A.3B'S OWN INTERNAL KEY: the node and the arbitration set, aggregated in
 * that order.
 *
 * The arbitration keys are aggregated FIRST, into the one key 5A.3B calls
 * `arbitration_aggregate_key`, and the internal key is the aggregate of the
 * node's key with that. Two steps, because the spec names two things - and
 * because the arbitration aggregate is the same for every bond on a network
 * while the node's key is not.
 */
export function bondInternalKey({ nodeKey, arbitrationKeys }, { combine } = {}) {
  if (!isKey32(nodeKey)) return { ok: false, why: 'the node key is 32 bytes' };
  const set = aggregateKeys(arbitrationKeys, { combine });
  if (!set.ok) return set;
  const both = aggregateKeys([nodeKey, set.key], { combine });
  if (!both.ok) return both;
  return { ok: true, internalKey: both.key, arbitrationAggregate: set.key };
}

/**
 * THE WHOLE TREE, AS HASHES: the two leaves, their branch, and the tweak.
 *
 * Returned separately from the output key because everything here is this
 * package's to compute and the last step is not.
 */
export function bondTapTree({
  nodeKey, arbitrationKeys, arbitrationK, bondMaturity, internalKey,
}, { combine } = {}) {
  // NO TREE WITHOUT THE CURVE. This used to build one for a caller with no way
  // to aggregate, on any thirty-two bytes it liked - and a tree is enough to
  // produce a control block, so the guard on `bondOutputKey` had a door beside
  // it. There is no honest reason to want a tree over a key path nobody can
  // check.
  if (typeof combine !== 'function')
    throw new Error('no curve was given to aggregate the key path with');

  const want = bondInternalKey({ nodeKey, arbitrationKeys }, { combine });
  if (!want.ok) throw new Error(want.why);
  if (!isKey32(internalKey)) throw new TypeError('the internal key is 32 bytes');
  if (!sameKey(want.internalKey, internalKey))
    throw new Error('that internal key is not the MuSig2 aggregate of the node and arbitration keys');
  const a = tapLeafHash(recoveryLeaf(nodeKey, bondMaturity));
  const b = tapLeafHash(slashLeaf(arbitrationKeys, arbitrationK));
  const merkleRoot = tapBranchHash(a, b);
  // The internal key comes back with the tree because a control block needs
  // it: a caller holding the hashes and not the key it was tweaked from could
  // not prove a leaf belongs to anything.
  return {
    internalKey, recovery: a, slash: b, merkleRoot,
    tweak: tapTweak(internalKey, merkleRoot),
  };
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
export function bondOutputKey(inputs, { tweakPoint, combine } = {}) {
  if (typeof tweakPoint !== 'function')
    return { ok: false, why: 'no curve was given to add the tweak with' };

  // BOTH CURVES OR NEITHER. Requiring the tweak and not the aggregate would
  // leave a door open beside the one just shut: a caller could pass the tweak
  // alone and still choose the internal key, which is the whole fault this
  // check exists against. The two are the same curve - anything that can add
  // t*G can add a_i*P_i - so asking for both costs a caller nothing and closes
  // the bypass.
  if (typeof combine !== 'function')
    return { ok: false, why: 'no curve was given to aggregate the key path with' };
  let tree;
  try { tree = bondTapTree(inputs, { combine }); }
  catch (e) { return { ok: false, why: e.message }; }

  // THE PARITY IS PART OF THE ANSWER, not a detail the x-only form may drop.
  //
  // An output key is published x-only, and that is fine for RECOGNISING one.
  // It is not enough to SPEND one: the control block's first byte carries the
  // y-parity of Q in its low bit, and a spender that guesses it wrong has an
  // invalid witness. So the curve is asked for both halves, and a curve that
  // answers with 32 bytes alone is refused rather than assumed even - because
  // an assumed parity is a bond that cannot be recovered half the time, and
  // path A exists so that a bond can ALWAYS be recovered.
  let answer;
  try { answer = tweakPoint(inputs.internalKey, tree.tweak); }
  catch (e) { return { ok: false, why: `that curve refused the tweak: ${e.message}` }; }

  const outputKey = answer && answer.outputKey;
  const parity = answer && answer.parity;
  if (!isKey32(outputKey)) return { ok: false, why: 'that curve did not return a 32-byte key' };
  if (parity !== 0 && parity !== 1)
    return { ok: false, why: 'that curve did not say whether the output key is even or odd' };

  return { ok: true, outputKey, parity, ...tree };
}

/**
 * THE CONTROL BLOCK: what a spender shows to prove a leaf belongs to the
 * output it is spending.
 *
 * BIP-341 gives it as `(leaf_version | parity) || internal_key || path`, and
 * for a two-leaf tree the path is one sibling hash - 65 bytes. Without it
 * NEITHER leaf is reachable: the output key hides the tree, which is the point,
 * so the tree has to be handed over at spend time. A bond whose control block
 * nobody could build would be a bond nobody could recover, and path A exists
 * precisely so that arbitration cannot freeze one forever.
 *
 * `path` names which leaf is being spent, and the sibling is the OTHER one -
 * a control block that named its own leaf as the sibling would rebuild a
 * different root and prove nothing.
 */
export function controlBlockFor(path, { recovery, slash, internalKey, parity }) {
  if (path !== 'recovery' && path !== 'slash')
    return { ok: false, why: `a bond has a recovery path and a slash path, not ${path}` };
  if (!isKey32(internalKey)) return { ok: false, why: 'the internal key is 32 bytes' };
  if (!isKey32(recovery) || !isKey32(slash)) return { ok: false, why: 'both leaf hashes are 32 bytes' };
  if (parity !== 0 && parity !== 1)
    return { ok: false, why: 'a control block carries the output key parity, and none was given' };

  const sibling = path === 'recovery' ? slash : recovery;
  return {
    ok: true,
    path,
    controlBlock: cat(Uint8Array.from([TAPLEAF_VERSION | parity]), internalKey, sibling),
  };
}

/**
 * AND THE SAME THING READ BACKWARDS: the root a control block proves for a
 * leaf, which is what lets a verifier rebuild Q and compare.
 *
 * This is the check a spender's own witness has to pass, so it is written once
 * and used from both sides rather than trusted in one direction.
 */
export function rootFromControlBlock(leafHash, controlBlock) {
  if (!isKey32(leafHash)) return { ok: false, why: 'a leaf hash is 32 bytes' };
  if (!(controlBlock instanceof Uint8Array) || controlBlock.length < 33
    || (controlBlock.length - 33) % 32 !== 0)
    return { ok: false, why: 'a control block is 33 bytes plus one hash per level' };

  const parity = controlBlock[0] & 1;
  if ((controlBlock[0] & 0xfe) !== TAPLEAF_VERSION)
    return { ok: false, why: 'that control block names another leaf version' };

  const internalKey = controlBlock.subarray(1, 33);
  let root = leafHash;
  for (let at = 33; at < controlBlock.length; at += 32) {
    root = tapBranchHash(root, controlBlock.subarray(at, at + 32));
  }
  return { ok: true, parity, internalKey, merkleRoot: root, tweak: tapTweak(internalKey, root) };
}

/**
 * AND THE SAME FUNCTION AGAIN, ASKED THE OTHER WAY: are these 32 bytes on
 * chain the output key these inputs produce?
 *
 * Refused by name, because the three ways it can fail are three different
 * mistakes: a key that is not the node's, a maturity that is not the
 * network's, and a tree that is not this template.
 */
export function bondOutputKeyMatches(onChain, inputs, { tweakPoint, combine } = {}) {
  if (!isKey32(onChain)) return { ok: false, why: 'that is not a 32-byte taproot output key' };
  const built = bondOutputKey(inputs, { tweakPoint, combine });
  if (!built.ok) return built;
  if (!built.outputKey.every((b, i) => b === onChain[i])) {
    return {
      ok: false,
      why: 'that output key is not the taproot tweak of the keys and maturity it declares',
    };
  }
  return { ok: true, ...built };
}
