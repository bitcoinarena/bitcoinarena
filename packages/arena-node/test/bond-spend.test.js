// THE LEAVES ACTUALLY RUN.
//
// A leaf is not documentation: it is the program that moves the money, and its
// hash is inside the output key. 5A.3B's own bytes would never spend - path A
// ends on DROP with an empty stack, and Bitcoin requires a true left on it;
// path B uses CHECKMULTISIG, which tapscript removed. Hashing those would mean
// either a bond that can never pay out or an output key that has to change
// later, invalidating every bond already posted.
//
// SO THIS FILE RUNS THEM. The evaluator below is a FIXTURE, not a consensus
// engine: it knows the six opcodes these two programs use and nothing else. It
// can show that a program ends with a true on the stack for one witness and
// not for another, which is exactly the claim being made. It cannot show that
// Bitcoin accepts the transaction, and nothing here says it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { recoveryLeaf, slashLeaf } from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';

const genesis = genesisFor('regtest');
const SIGHASH = new Uint8Array(32).fill(0x5a);     // a stand-in for the real one

const keyPair = () => {
  const secret = schnorr.utils.randomSecretKey();
  return { secret, pubkey: schnorr.getPublicKey(secret) };
};

/** A number as a script pushes it, back to a number. */
const asNumber = (item) => {
  if (item.length === 0) return 0;
  let v = 0;
  for (let i = item.length - 1; i >= 0; i--) v = v * 256 + item[i];
  return v;
};
const asItem = (n) => {
  if (n === 0) return new Uint8Array(0);
  const out = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v >>>= 8; }
  return Uint8Array.from(out);
};

/**
 * A stack machine for exactly the opcodes these leaves use.
 *
 * `witness` is the spender's stack, bottom first. `locktime` is the
 * transaction's. Returns why it failed rather than a bare false, because "the
 * timelock refused" and "the signature refused" are different answers.
 */
function run(script, witness, { locktime = 0 } = {}) {
  const stack = witness.map((w) => Uint8Array.from(w));
  let at = 0;
  const pop = () => {
    if (!stack.length) return null;
    return stack.pop();
  };

  while (at < script.length) {
    const op = script[at++];

    if (op >= 0x01 && op <= 0x4b) {                 // a direct push
      stack.push(script.subarray(at, at + op));
      at += op;
      continue;
    }
    if (op >= 0x51 && op <= 0x60) {                 // OP_1 .. OP_16
      stack.push(asItem(op - 0x50));
      continue;
    }
    if (op === 0xb1) {                              // CHECKLOCKTIMEVERIFY
      const want = stack.length ? asNumber(stack[stack.length - 1]) : null;
      if (want === null) return { ok: false, why: 'CLTV on an empty stack' };
      if (locktime < want) return { ok: false, why: `the locktime ${locktime} is before ${want}` };
      continue;                                     // BIP-65 leaves its argument
    }
    if (op === 0x75) { if (pop() === null) return { ok: false, why: 'DROP on an empty stack' }; continue; }
    if (op === 0xac || op === 0xba) {               // CHECKSIG / CHECKSIGADD
      const key = pop();
      const n = op === 0xba ? asNumber(pop() || new Uint8Array(0)) : 0;
      const sig = pop();
      if (!key || !sig) return { ok: false, why: 'a signature check with nothing to check' };
      // BIP-342: an EMPTY signature counts as a failed check without failing
      // the script, which is how a spender says "not me" for a key it lacks.
      const good = sig.length !== 0 && (() => {
        try { return schnorr.verify(sig, SIGHASH, key); } catch { return false; }
      })();
      stack.push(op === 0xba ? asItem(n + (good ? 1 : 0)) : asItem(good ? 1 : 0));
      continue;
    }
    if (op === 0x9c) {                              // NUMEQUAL
      const b = pop(); const a = pop();
      if (!a || !b) return { ok: false, why: 'NUMEQUAL with nothing to compare' };
      stack.push(asItem(asNumber(a) === asNumber(b) ? 1 : 0));
      continue;
    }
    return { ok: false, why: `this fixture does not know opcode 0x${op.toString(16)}` };
  }

  if (stack.length !== 1) return { ok: false, why: `${stack.length} items left on the stack` };
  return { ok: asNumber(stack[0]) !== 0, why: asNumber(stack[0]) !== 0 ? null : 'the script ended false' };
}

/**
 * PATH A: the node alone, after maturity. 5A.3B calls it the one to get right,
 * because it is what returns the money if arbitration disappears.
 */
test('the recovery leaf spends after maturity and not before', () => {
  const node = keyPair();
  const leaf = recoveryLeaf(node.pubkey, genesis.bondMaturity);
  const witness = [schnorr.sign(SIGHASH, node.secret)];

  const after = run(leaf, witness, { locktime: genesis.bondMaturity });
  assert.equal(after.ok, true, `a valid recovery after maturity failed: ${after.why}`);

  const later = run(leaf, witness, { locktime: genesis.bondMaturity + 500 });
  assert.equal(later.ok, true, later.why);

  // THE SAME WITNESS, BEFORE MATURITY, DOES NOT SPEND.
  const early = run(leaf, witness, { locktime: genesis.bondMaturity - 1 });
  assert.equal(early.ok, false, 'the bond was recoverable before it matured');
  assert.match(early.why, /is before 100/);

  // and somebody else's signature never spends it, at any height
  const stranger = keyPair();
  const forged = run(leaf, [schnorr.sign(SIGHASH, stranger.secret)],
    { locktime: genesis.bondMaturity + 500 });
  assert.equal(forged.ok, false, "a stranger recovered the node's bond");

  // THE SPEC'S OWN ORDER LEAVES NOTHING ON THE STACK, which is why it is not
  // what is hashed: same opcodes, the other way round, and it cannot spend.
  const asWritten = Uint8Array.from([
    0x20, ...node.pubkey, 0xad, 0x01, genesis.bondMaturity, 0xb1, 0x75,
  ]);
  const broken = run(asWritten, witness, { locktime: genesis.bondMaturity });
  assert.equal(broken.ok, false, "the spec's own bytes spent after all");
});

/**
 * PATH B: five of seven, before maturity, counted the way tapscript counts.
 */
test('the slash leaf spends with five of seven and not with four', () => {
  const signerNodes = [1, 2, 3, 4, 5, 6, 7].map(keyPair);
  const sorted = [...signerNodes].sort((a, b) => {
    for (let i = 0; i < 32; i++) if (a.pubkey[i] !== b.pubkey[i]) return a.pubkey[i] - b.pubkey[i];
    return 0;
  });
  const leaf = slashLeaf(signerNodes.map((s) => s.pubkey), genesis.arbitrationK);

  // The witness is one item per key, in the order the SCRIPT checks them, and
  // pushed so the first key's signature is on top. A signer node that is not signing
  // supplies an empty item, which counts as zero without failing the script.
  const witnessOf = (signing) => sorted
    .map((s) => (signing.has(s) ? schnorr.sign(SIGHASH, s.secret) : new Uint8Array(0)))
    .reverse();

  const five = run(leaf, witnessOf(new Set(sorted.slice(0, 5))));
  assert.equal(five.ok, true, `five of seven failed: ${five.why}`);

  const four = run(leaf, witnessOf(new Set(sorted.slice(0, 4))));
  assert.equal(four.ok, false, 'four of seven slashed the bond');

  const six = run(leaf, witnessOf(new Set(sorted.slice(0, 6))));
  assert.equal(six.ok, false, 'six counted as five, so the quorum is a floor rather than a count');

  // ANY five, not a particular five
  const otherFive = run(leaf, witnessOf(new Set(sorted.slice(2, 7))));
  assert.equal(otherFive.ok, true, otherFive.why);

  // and five signatures from people who are not signer nodes slash nothing
  const strangers = [1, 2, 3, 4, 5].map(keyPair);
  const outside = sorted.map((s, i) => (i < 5 ? schnorr.sign(SIGHASH, strangers[i].secret) : new Uint8Array(0))).reverse();
  assert.equal(run(leaf, outside).ok, false, 'five strangers slashed the bond');
});
