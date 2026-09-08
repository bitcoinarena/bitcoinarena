// SPENDING A BOND, AND THE MESSAGE THE SIGNATURES COVER.
//
// 24 proved the two leaves are programs that run and that each carries a
// control block rebuilding the output key. Neither makes a bond SLASHABLE: a
// spend has to be assembled, and what it signs is BIP-341's own sighash, which
// commits to every input's amount and script as well as the outputs. A bond
// nobody can spend is not collateral, and a slash nobody can broadcast is a
// threat with nothing behind it.
//
// EVERYTHING HERE IS SERIALIZATION AND HASHING, which this package may do. The
// signatures come from a caller with a curve, as everywhere else.
//
// AND THE ORACLE IS A REAL NODE. There are no BIP-341 vectors in this tree, so
// the first honest measurement of this file is "bitcoind accepted the
// transaction" - not a match against a published vector. That is a weaker
// claim about the CODE and a stronger one about the RESULT, and it is written
// down so nobody later reads a green test here as a vector match.
import { sha256bytes } from '../../core/src/sha256.js';
import { taggedHash } from './hash.js';

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const u32 = (n) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u64 = (v) => {
  const out = new Uint8Array(8);
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
};

/** Bitcoin's compact size, which prefixes every list and every script. */
export function compactSize(n) {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 255, (n >>> 8) & 255]);
  return cat(Uint8Array.from([0xfe]), u32(n));
}

const outpointOf = (input) => cat(input.txid, u32(input.vout));
const scriptWithLength = (script) => cat(compactSize(script.length), script);
const outputBytes = (o) => cat(u64(o.value), scriptWithLength(o.script));

/**
 * THE TAPROOT SIGHASH, BIP-341, for a SCRIPT-PATH spend with hash type
 * DEFAULT.
 *
 * The message commits to every input's AMOUNT and SCRIPT, not only its
 * outpoint - that is the change taproot made, and it is why a signer cannot be
 * lied to about what it is spending. Getting one of those hashes wrong
 * produces a signature that verifies against nothing, so each is named here
 * rather than folded into one loop.
 */
export function tapSighash({
  version = 2, locktime = 0, inputs, prevouts, outputs, inputIndex, leafHash,
}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('a spend has inputs');
  if (!Array.isArray(prevouts) || prevouts.length !== inputs.length)
    throw new Error('every input needs the output it spends');
  if (!Number.isInteger(inputIndex) || inputIndex >= inputs.length)
    throw new Error('that input index is not in this transaction');

  const shaPrevouts = sha256bytes(cat(...inputs.map(outpointOf)));
  const shaAmounts = sha256bytes(cat(...prevouts.map((p) => u64(p.value))));
  const shaScripts = sha256bytes(cat(...prevouts.map((p) => scriptWithLength(p.script))));
  const shaSequences = sha256bytes(cat(...inputs.map((i) => u32(i.sequence))));
  const shaOutputs = sha256bytes(cat(...outputs.map(outputBytes)));

  // spend_type = ext_flag * 2 + annex_present. A script path is ext_flag 1 and
  // this builder writes no annex, so it is 2 and never anything else.
  const spendType = Uint8Array.from([2]);

  const message = cat(
    Uint8Array.from([0x00]),                 // hash_type: DEFAULT
    u32(version), u32(locktime),
    shaPrevouts, shaAmounts, shaScripts, shaSequences,
    shaOutputs,
    spendType, u32(inputIndex),
    leafHash,
    Uint8Array.from([0x00]),                 // key_version
    u32(0xffffffff),                         // no CODESEPARATOR
  );

  // The epoch byte is inside the tagged hash and outside the message, which is
  // the one part of this that reads like a mistake and is not.
  return taggedHash('TapSighash', cat(Uint8Array.from([0x00]), message));
}

/**
 * THE WITNESS FOR A SCRIPT-PATH SPEND: the stack the leaf consumes, then the
 * leaf, then the proof that the leaf belongs to the output.
 *
 * The stack is written bottom-first, which is the order a witness is
 * serialised in and the reverse of the order a script pops. A five-of-seven
 * leaf checks its first key first, so that key's signature must end up on top
 * and therefore last in the list a caller passes.
 */
export function scriptPathWitness({ stack, script, controlBlock }) {
  if (!Array.isArray(stack)) throw new Error('a witness has a stack, even an empty one');
  return [...stack, script, controlBlock];
}

/** A transaction with its witnesses, as a node takes it. */
export function serializeSpend({ version = 2, locktime = 0, inputs, outputs, witnesses }) {
  const body = [
    u32(version),
    Uint8Array.from([0x00, 0x01]),           // the segwit marker and flag
    compactSize(inputs.length),
    ...inputs.map((i) => cat(outpointOf(i), compactSize(0), u32(i.sequence))),
    compactSize(outputs.length),
    ...outputs.map(outputBytes),
  ];
  for (const w of witnesses) {
    body.push(compactSize(w.length));
    for (const item of w) body.push(scriptWithLength(item));
  }
  body.push(u32(locktime));
  return cat(...body);
}
