// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { sha256bytes } from './sha256.js';
import { taggedHash } from './hash.js';

const joinBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const leU32 = (n) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const leU64 = (v) => {
  const out = new Uint8Array(8);
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) { out[i] = Number(n & 255n); n >>= 8n; }
  return out;
};

/** Bitcoin's compact size, which prefixes every list and every script. */
export function compactSize(n) {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 255, (n >>> 8) & 255]);
  return joinBytes(Uint8Array.from([0xfe]), leU32(n));
}

const inputOutpoint = (input) => joinBytes(input.txid, leU32(input.vout));
const scriptWithLength = (script) => joinBytes(compactSize(script.length), script);
const outputBytes = (o) => joinBytes(leU64(o.value), scriptWithLength(o.script));

/**
 * THE TAPROOT SIGHASH, BIP-341, for a key-path or script-path spend.
 *
 * The message commits to every input's AMOUNT and SCRIPT, not only its
 * outpoint - that is the change taproot made, and it is why a signer cannot be
 * lied to about what it is spending. Getting one of those hashes wrong
 * produces a signature that verifies against nothing, so each is named here
 * rather than folded into one loop.
 *
 * `hashType` is DEFAULT unless named. Template 3's advance signature is
 * SIGHASH_SINGLE|ANYONECANPAY (0x83, spec 5A.3B), and a slash has to read a
 * witness whatever type its signer chose: a panel member who signed with an
 * explicit 0x01 must not walk away because this file only knew 0x00. With
 * ANYONECANPAY only `prevouts[inputIndex]` is read.
 */
export function tapSighash({
  version = 2, locktime = 0, inputs, prevouts, outputs, inputIndex, leafHash = null, hashType = 0x00,
}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error('a spend has inputs');
  if (!Array.isArray(prevouts) || prevouts.length !== inputs.length)
    throw new Error('every input needs the output it spends');
  if (!Number.isInteger(inputIndex) || inputIndex >= inputs.length)
    throw new Error('that input index is not in this transaction');
  if (![0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83].includes(hashType))
    throw new Error(`${hashType} is not a taproot hash type`);

  const anyoneCanPay = (hashType & 0x80) !== 0;
  const outputType = hashType === 0x00 ? 0x01 : hashType & 0x03;
  if (outputType === 0x03 && inputIndex >= outputs.length)
    throw new Error('SIGHASH_SINGLE needs the output at its own input\'s index');

  // spend_type = ext_flag * 2 + annex_present. This builder writes no annex, so
  // a script path is 2 and a KEY PATH is 0 - and the key path also drops the
  // three extension fields entirely. Getting that wrong does not produce an
  // invalid signature, it produces a valid signature over a different message,
  // which a node rejects with nothing to say about why.
  const keyPath = leafHash === null || leafHash === undefined;
  const spendType = Uint8Array.from([keyPath ? 0 : 2]);

  const own = inputs[inputIndex];
  const message = joinBytes(
    Uint8Array.from([hashType]),
    leU32(version), leU32(locktime),
    ...(anyoneCanPay ? [] : [
      sha256bytes(joinBytes(...inputs.map(inputOutpoint))),
      sha256bytes(joinBytes(...prevouts.map((p) => leU64(p.value)))),
      sha256bytes(joinBytes(...prevouts.map((p) => scriptWithLength(p.script)))),
      sha256bytes(joinBytes(...inputs.map((i) => leU32(i.sequence)))),
    ]),
    ...(outputType === 0x01 ? [sha256bytes(joinBytes(...outputs.map(outputBytes)))] : []),
    spendType,
    ...(anyoneCanPay
      ? [inputOutpoint(own), leU64(prevouts[inputIndex].value), scriptWithLength(prevouts[inputIndex].script), leU32(own.sequence)]
      : [leU32(inputIndex)]),
    ...(outputType === 0x03 ? [sha256bytes(outputBytes(outputs[inputIndex]))] : []),
    ...(keyPath ? [] : [
      leafHash,
      Uint8Array.from([0x00]),               // key_version
      leU32(0xffffffff),                       // no CODESEPARATOR
    ]),
  );

  // The epoch byte is inside the tagged hash and outside the message, which is
  // the one part of this that reads like a mistake and is not.
  return taggedHash('TapSighash', joinBytes(Uint8Array.from([0x00]), message));
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

/**
 * WHO A SCRIPT-PATH WITNESS NAMES (spec 5A.3: "the release, whose witness names the signers"): the keys of the leaf in the order
 * it checks them, each with the signature on the stack for it, empty where that key did not sign. A leaf is read only as far as its
 * 32-byte pushes followed by CHECKSIG, CHECKSIGVERIFY or CHECKSIGADD; whether a signature is good is for the verifier to say.
 * An annex is refused by name: tapSighash writes none, so no signature beside one could be checked here.
 */
export function scriptPathSigners(witness) {
  if (!Array.isArray(witness) || witness.length < 2) return { ok: false, why: 'that is not a script-path witness' };
  if (witness[witness.length - 1][0] === 0x50) return { ok: false, why: 'that witness carries an annex' };
  const controlBlock = witness[witness.length - 1];
  const script = witness[witness.length - 2];
  const stack = witness.slice(0, -2);
  const keys = [];
  for (let at = 0; at < script.length;) {
    const op = script[at];
    if (op === 0x20 && [0xac, 0xad, 0xba].includes(script[at + 33])) { keys.push(script.subarray(at + 1, at + 33)); at += 34; continue; }
    at += op >= 0x01 && op <= 0x4b ? op + 1 : 1;
  }
  if (keys.length !== stack.length) return { ok: false, why: `that leaf checks ${keys.length} keys and the witness carries ${stack.length} items` };
  // bottom-first on the wire, so the first key checked is the last item
  return { ok: true, script, controlBlock, signers: keys.map((key, i) => ({ key, signature: stack[stack.length - 1 - i] })) };
}

/** A transaction with its witnesses, as a node takes it. */
export function serializeSpend({ version = 2, locktime = 0, inputs, outputs, witnesses }) {
  const body = [
    leU32(version),
    Uint8Array.from([0x00, 0x01]),           // the segwit marker and flag
    compactSize(inputs.length),
    ...inputs.map((i) => joinBytes(inputOutpoint(i), compactSize(0), leU32(i.sequence))),
    compactSize(outputs.length),
    ...outputs.map(outputBytes),
  ];
  for (const w of witnesses) {
    body.push(compactSize(w.length));
    for (const item of w) body.push(scriptWithLength(item));
  }
  body.push(leU32(locktime));
  return joinBytes(...body);
}

/**
 * THE OUTPUT A SLASH HAS TO CARRY, 5A.3B step 4.
 *
 * "OP_RETURN = H(fraud_proof) || retrieval hint", and `slash.js` fixes the
 * hash: the same 32 bytes as the proof's id. The hint's shape the spec does
 * not fix, so a caller may append bytes and this will carry them; inventing a
 * format for it here would be inventing a second protocol.
 *
 * The value is zero because an OP_RETURN is provably unspendable, which is the
 * point: the commitment costs a fee and nothing else.
 */
export function commitmentOutput(commitment, hint = new Uint8Array(0)) {
  if (!(commitment instanceof Uint8Array) || commitment.length !== 32)
    throw new TypeError('a slash commits to a 32-byte proof id');
  const payload = joinBytes(commitment, hint);
  if (payload.length > 80) throw new RangeError('an OP_RETURN carries at most 80 bytes');
  return { value: 0n, script: joinBytes(Uint8Array.from([0x6a]), compactSize(payload.length), payload) };
}

/**
 * AND THE READING OF IT: what proof does this spend commit to?
 *
 * CONSENSUS DOES NOT CARE. A five-of-seven spend with no OP_RETURN is a
 * perfectly valid Bitcoin transaction and a node will accept it - which is
 * exactly why the protocol has to check. "Because the slashing transaction
 * commits to the proof, every slash is permanently auditable"; a slash that
 * commits to nothing is a bond taken with no public record of why, and it is
 * the arbitration set's own offence.
 */
export function commitmentIn(outputs) {
  for (const o of outputs || []) {
    const script = o.script;
    if (!script || script.length < 34 || script[0] !== 0x6a) continue;
    // OP_RETURN, then a direct push of at least the 32-byte id.
    const len = script[1];
    if (len < 32 || script.length < 2 + len) continue;
    return { commitment: script.subarray(2, 34), hint: script.subarray(34, 2 + len) };
  }
  return null;
}

/**
 * DOES THIS SPEND COMMIT TO THAT PROOF? Refused by name, because "no
 * commitment at all" and "a commitment to some other proof" are different
 * failures and only one of them looks like a mistake.
 */
export function spendCommitsTo(outputs, commitment) {
  const found = commitmentIn(outputs);
  if (!found) return { ok: false, why: 'that spend carries no proof commitment, so no slash it makes is auditable' };
  if (!found.commitment.every((b, i) => b === commitment[i]))
    return { ok: false, why: 'that spend commits to a different proof than the one offered' };
  return { ok: true, hint: found.hint };
}
