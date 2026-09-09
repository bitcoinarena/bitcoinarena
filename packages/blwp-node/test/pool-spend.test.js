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
import { toHex, fromHex } from '../../protocol/src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const FIXED_TXID = new Uint8Array(32).fill(0xab);
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
function spendOf({ out, value = 100000n, to = new Uint8Array(P2TR_SCRIPT_BYTES).fill(0x51),
  // THE INPUT IS FIXED BY DEFAULT. A fresh random txid per call would change
  // the sighash on its own, and a test comparing two spends would then pass
  // whatever the sighash did with the outputs - measured: a mutant that
  // dropped the outputs from the message survived exactly that way.
  txid = FIXED_TXID }) {
  const inputs = [{ txid, vout: 0, sequence: 0xffffffff }];
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

test('the sighash is over every part of the spend, and a key path is not a script path', () => {
  const { out } = pool();
  const one = spendOf({ out });

  // THE OUTPUTS ARE IN IT. Same input, different destination.
  const elsewhere = spendOf({ out, to: new Uint8Array(P2TR_SCRIPT_BYTES).fill(0x52) });
  assert.notEqual(toHex(one.sighash), toHex(elsewhere.sighash),
    'the destination is not in the message this committee signs');

  // THE AMOUNT IS IN IT.
  const cheaper = spendOf({ out, value: 90000n });
  assert.notEqual(toHex(one.sighash), toHex(cheaper.sighash));

  // WHICH INPUT IS IN IT. Two inputs, one message each.
  const two = {
    inputs: [{ txid: FIXED_TXID, vout: 0, sequence: 0xffffffff },
      { txid: FIXED_TXID, vout: 1, sequence: 0xffffffff }],
    prevouts: [{ value: 100000n, script: out.script }, { value: 100000n, script: out.script }],
    outputs: one.outputs,
  };
  assert.notEqual(toHex(tapSighash({ ...two, inputIndex: 0 })),
    toHex(tapSighash({ ...two, inputIndex: 1 })),
    'two inputs of one transaction sign the same message');

  // AND A KEY PATH IS NOT A SCRIPT PATH. BIP-341 puts a different spend_type
  // byte and three extra fields in the script-path message; signing one as the
  // other produces a perfectly valid signature over the wrong thing, which a
  // node rejects with nothing to say about why.
  const asScript = tapSighash({
    inputs: one.inputs, prevouts: one.prevouts, outputs: one.outputs, inputIndex: 0,
    leafHash: new Uint8Array(32).fill(7),
  });
  assert.notEqual(toHex(one.sighash), toHex(asScript),
    'a key-path spend and a script-path spend sign the same message');
});

test('the tweak is the committee\'s own key, and a different committee is a different output', () => {
  const a = pool();
  const b = pool();
  assert.notEqual(toHex(a.out.internalKey), toHex(b.out.internalKey));
  assert.notEqual(toHex(a.out.tweak), toHex(b.out.tweak),
    'two committees share a tweak, so it commits to no key');
  assert.notEqual(toHex(a.out.outputKey), toHex(b.out.outputKey));
  assert.deepEqual(a.out.tweak, poolTweak(a.out.internalKey));
});

test('a group key with odd y is refused rather than turned into an output', () => {
  const { dealt } = pool();
  const odd = new Uint8Array(dealt.groupPublicKey);
  odd[0] = 0x03;
  const seen = poolOutput({ groupPublicKey: odd, curve });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /odd y: normalise it when it is dealt/);
  assert.equal(poolOutput({ groupPublicKey: new Uint8Array(32), curve }).ok, false);
  assert.equal(poolOutput({ groupPublicKey: dealt.groupPublicKey, curve: {} }).ok, false);
});

test('a key-path witness is one 64-byte signature and nothing else', () => {
  const sig = new Uint8Array(64).fill(9);
  assert.deepEqual(poolWitness(sig), [sig]);
  for (const bad of [new Uint8Array(65), new Uint8Array(32), null, 'signature'])
    assert.throws(() => poolWitness(bad), /64 bytes, and a key-path witness is only that/);
});

/**
 * THE SCRIPT-PATH MESSAGE, PINNED, AND ITS AUTHORITY IS NOT THIS FILE.
 *
 * Adding the key-path case to `tapSighash` put a branch in the middle of the
 * one thing every taproot spend in this project signs. A mutant that wrote
 * spend_type 0 for BOTH paths survived every test here: the two messages still
 * differed, because the script path also appends a leaf hash, so nothing could
 * tell.
 *
 * What can tell is a real node. `tools/bond-regtest.mjs` builds this exact
 * spend, broadcasts it to a bitcoind, and prints the sighash it signed;
 * "recovery, honest {ok:true}" is that transaction being accepted. The value
 * below is that run's, so this assertion's authority is a consensus engine
 * taking the spend, not this suite agreeing with itself.
 */
test('the script-path sighash is the one a real node accepted', () => {
  const sighash = tapSighash({
    version: 2, locktime: 100,
    inputs: [{ txid: new Uint8Array(32).fill(0x22), vout: 1, sequence: 0xfffffffe }],
    prevouts: [{
      value: 100000000n,
      script: new Uint8Array([0x51, 0x20,
        ...fromHex('fb0a797f025871162be6a1324da67c64234c10aacb309af30b7e7ab5450da51e')]),
    }],
    outputs: [{ value: 99998000n, script: fromHex('0014' + '33'.repeat(20)) }],
    inputIndex: 0,
    leafHash: fromHex('29b15fdfb9cdfd0e23b8ccba647dee6c2e6ab711a2e6b2e24f404626b0df7e64'),
  });
  assert.equal(toHex(sighash),
    'a5510d85b9795b6af07a3f875fc2f267cb0d2df72350ef60b8e0f1ac50fcd97e',
    'the script-path message changed, so every bond spend this project makes is now invalid');
});
