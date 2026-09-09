// FIVE SEATS MOVE THE POOL AND FOUR CANNOT.
//
// Item 10 built a threshold signature with zero callers; item 13 is the thing
// that calls it. Measured before this existed: no object in any source file
// held a wallet, and a settled loser stake ended up in the channel balance of
// one Lightning node, spendable by one macaroon.
//
// The pool is one P2TR output whose key is the committee's, with NO SCRIPT
// PATH - 23.5 says every operation needs the threshold, and a leaf is a second
// way in. What is measured here is the transaction: five seats produce a
// witness BIP-340 accepts against the output key, four produce nothing, one
// produces nothing. `pool-regtest.mjs` then puts the same transaction in front
// of a real bitcoind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { trustedDealerSplit, nonceGenerate } from '../../protocol/src/frost.js';
import {
  signShare340, aggregate340, enoughToSign, evenGroupSecret, xOnly,
} from '../../protocol/src/frost-bip340.js';
import {
  poolOutput, poolShare, poolSigningKey, poolWitness, poolOwns, poolTweak,
  P2TR_SCRIPT_BYTES,
} from '../../protocol/src/pool.js';
import { tapSighash, serializeSpend } from '../../protocol/src/bond-spend.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import { tweakPoint } from '../src/curve.js';
import { toHex } from '../../protocol/src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };

/** A 5-of-7 committee and the pool output it owns. */
function pool() {
  const even = evenGroupSecret(scalarFrom32(rand(32)) % FIELD, feldmanGroup);
  const dealt = trustedDealerSplit({
    secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
    coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    curve: feldmanGroup,
  });
  const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
  assert.equal(out.ok, true, out.why);
  return { dealt, out };
}

/** A spend of one pool output to one address, and the sighash it signs. */
function spendOf({ out, value = 100000n, to = new Uint8Array(P2TR_SCRIPT_BYTES).fill(0x51) }) {
  const inputs = [{ txid: rand(32), vout: 0, sequence: 0xffffffff }];
  const prevouts = [{ value, script: out.script }];
  const outputs = [{ value: value - 300n, script: to }];
  const sighash = tapSighash({ inputs, prevouts, outputs, inputIndex: 0 });
  return { inputs, prevouts, outputs, sighash };
}

/** Round one and round two, over the tweaked shares, for one signing set. */
function sign({ dealt, out, sighash, who }) {
  const signers = who.map((id) => {
    const raw = dealt.shares.find((s) => s.id === id).share;
    const share = poolShare({ share: raw, tweak: out.tweak, negated: out.negated });
    const hiding = nonceGenerate(rand(32), share);
    const binding = nonceGenerate(rand(32), share);
    return {
      id, share, hiding, binding,
      commitment: {
        id,
        hiding: feldmanGroup.pointFromScalar(hiding),
        binding: feldmanGroup.pointFromScalar(binding),
      },
    };
  });
  const commitments = signers.map((s) => s.commitment);
  const groupPublicKey = poolSigningKey(out.outputKey);
  const shares = signers.map((s) => signShare340({
    id: s.id, share: s.share, groupPublicKey,
    nonces: { hiding: s.hiding, binding: s.binding },
    message: sighash, commitments, curve: feldmanGroup,
  }));
  return aggregate340({ commitments, message: sighash, groupPublicKey, shares, curve: feldmanGroup });
}

test('the pool is one P2TR output that commits to no script at all', () => {
  const { dealt, out } = pool();
  assert.equal(out.script.length, P2TR_SCRIPT_BYTES);
  assert.equal(out.script[0], 0x51, 'a pool output is not witness version 1');
  assert.equal(out.script[1], 0x20);
  assert.equal(out.outputKey.length, 32);

  // BIP-341's own instruction for a key-path-only output: tweak by the key
  // alone, with an empty merkle root. Nothing is being hidden in a tree.
  assert.deepEqual(out.tweak, poolTweak(out.internalKey));
  assert.deepEqual(out.internalKey, xOnly(dealt.groupPublicKey));
  assert.notDeepEqual(out.outputKey, out.internalKey,
    'the output key is the raw group key, so the output commits to nothing');

  assert.equal(poolOwns(out.script, out.outputKey).ok, true);
  const somebodyElse = new Uint8Array(out.script);
  somebodyElse[10] ^= 0xff;
  assert.equal(poolOwns(somebodyElse, out.outputKey).ok, false);
  assert.match(poolOwns(new Uint8Array(10), out.outputKey).why, /not a P2TR output/);
});

test('five of seven move the pool: BIP-340 accepts the witness', () => {
  let accepted = 0;
  for (let i = 0; i < 6; i++) {
    const { dealt, out } = pool();
    const spend = spendOf({ out });
    const who = [1, 2, 3, 4, 5, 6, 7].sort(() => (randomBytes(1)[0] < 128 ? -1 : 1)).slice(0, 5);
    const sig = sign({ dealt, out, sighash: spend.sighash, who });

    // The verifier is not ours: it is the check a full node runs on the
    // witness of a key-path spend.
    if (schnorr.verify(sig.signature, spend.sighash, out.outputKey)) accepted++;

    // AND THE WITNESS IS ONE ITEM. A second would be another way in.
    const witness = poolWitness(sig.signature);
    assert.equal(witness.length, 1);
    assert.equal(witness[0].length, 64);
  }
  assert.equal(accepted, 6, 'a five-seat spend was not accepted against the pool key');
});

test('four of seven are refused by name, and produce nothing if they sign anyway', () => {
  const { dealt, out } = pool();
  const spend = spendOf({ out });
  const four = [1, 2, 3, 4];
  const seen = enoughToSign({
    commitments: four.map((id) => ({ id })), needed: SHARES_NEEDED,
  });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /4 of 5 signers: a pool nobody can move stays where it is/);

  let accepted = 0;
  for (const who of [[1, 2, 3, 4], [3, 4, 5, 6], [1, 4, 6, 7]]) {
    const sig = sign({ dealt, out, sighash: spend.sighash, who });
    if (schnorr.verify(sig.signature, spend.sighash, out.outputKey)) accepted++;
  }
  assert.equal(accepted, 0, 'four of seven moved the pool');
});

test('one operator alone moves nothing', () => {
  const { dealt, out } = pool();
  const spend = spendOf({ out });
  let accepted = 0;
  for (const id of [1, 2, 3, 4, 5, 6, 7]) {
    const sig = sign({ dealt, out, sighash: spend.sighash, who: [id] });
    if (schnorr.verify(sig.signature, spend.sighash, out.outputKey)) accepted++;
  }
  assert.equal(accepted, 0, 'one operator spent the pool');
});

test('the signature is over THIS spend and no other', () => {
  const { dealt, out } = pool();
  const spend = spendOf({ out });
  const sig = sign({ dealt, out, sighash: spend.sighash, who: [1, 2, 3, 4, 5] });
  assert.equal(schnorr.verify(sig.signature, spend.sighash, out.outputKey), true);

  // A DIFFERENT DESTINATION IS A DIFFERENT SIGHASH. A committee that signed a
  // payout table must not have signed a spend to somebody else's address.
  const elsewhere = spendOf({ out, to: new Uint8Array(P2TR_SCRIPT_BYTES).fill(0x52) });
  assert.notEqual(toHex(spend.sighash), toHex(elsewhere.sighash));
  assert.equal(schnorr.verify(sig.signature, elsewhere.sighash, out.outputKey), false);

  // And a different amount, likewise.
  const cheaper = spendOf({ out, value: 90000n });
  assert.equal(schnorr.verify(sig.signature, cheaper.sighash, out.outputKey), false);
});

test('the tweak is not optional: the untweaked key signs for nothing', () => {
  // Adding the tweak to every share is what moves the secret onto the OUTPUT
  // key. A committee that skipped it holds shares of the internal key, which
  // no output pays to.
  const { dealt, out } = pool();
  const spend = spendOf({ out });
  const signers = [1, 2, 3, 4, 5].map((id) => {
    const share = dealt.shares.find((s) => s.id === id).share;   // NOT tweaked
    const hiding = nonceGenerate(rand(32), share);
    const binding = nonceGenerate(rand(32), share);
    return { id, share, hiding, binding,
      commitment: { id, hiding: feldmanGroup.pointFromScalar(hiding), binding: feldmanGroup.pointFromScalar(binding) } };
  });
  const commitments = signers.map((s) => s.commitment);
  const groupPublicKey = poolSigningKey(out.outputKey);
  const shares = signers.map((s) => signShare340({
    id: s.id, share: s.share, groupPublicKey,
    nonces: { hiding: s.hiding, binding: s.binding },
    message: spend.sighash, commitments, curve: feldmanGroup,
  }));
  const sig = aggregate340({ commitments, message: spend.sighash, groupPublicKey, shares, curve: feldmanGroup });
  assert.equal(schnorr.verify(sig.signature, spend.sighash, out.outputKey), false,
    'untweaked shares signed for the output key');
});

test('the spend serialises to a transaction a parser reads back', () => {
  const { dealt, out } = pool();
  const spend = spendOf({ out });
  const sig = sign({ dealt, out, sighash: spend.sighash, who: [2, 3, 4, 5, 6] });
  const raw = serializeSpend({
    inputs: spend.inputs, outputs: spend.outputs, witnesses: [poolWitness(sig.signature)],
  });
  const tx = parseTransaction(raw);
  assert.equal(tx.inputs.length, 1);
  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.txid.length, 32);
  assert.equal(toHex(tx.outputs[0].script), toHex(spend.outputs[0].script));
});
