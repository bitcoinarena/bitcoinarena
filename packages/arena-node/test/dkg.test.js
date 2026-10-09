// A COMMITTEE MAKES ITS OWN KEY, AND NOBODY EVER HOLDS IT.
//
// The curve half of item 14. `arena-protocol/test/dkg.test.js` measures the epoch id
// and the wire, which need no group; this runs the round on the daemon's own
// injected curve, the same split `shares.test.js` and `shares-feldman.test.js`
// already keep.
//
// M3.3 item 14. Measured before a line of it was written
// (`arena-node/test/dkg-dealer.test.js`): the dealing process held 7 of 7
// shares, five of them interpolate to the group secret, and
// `trustedDealerSplit` had zero callers under any `src/` - so the dealer was
// whatever process started the daemons.
//
// Pedersen is n parallel Feldman deals: every signer node splits a secret of its own
// to all signer nodes, and each signer node adds up what it was dealt. The sum is a share of
// a group secret equal to the sum of everybody's, which nobody computes. The
// arithmetic is `shares.js`'s and the envelopes are `seal.js`'s; what is
// measured here is the ROUND.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import {
  epochId, dealContribution, acceptContribution, openMyContribution,
  groupKeyOf, combineShares,
} from '../../arena-protocol/src/dkg.js';
import { splitSecret, scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../arena-protocol/src/shares.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { signShare340, aggregate340 } from '../../arena-protocol/src/frost-bip340.js';
import { nonceGenerate } from '../../arena-protocol/src/frost.js';

const rand = (n) => new Uint8Array(randomBytes(n));

// THE DAEMON'S OWN GROUP, injected the way `serve` injects it. Not a copy
// written for this file: a second curve in a test is a second implementation
// of the thing that pins money, and it would agree right up until it did not.
const curve = { ...feldmanGroup, tweakPoint };

/** A committee of `n` signer nodes, each with its own identity key. */
function committee(n = SHARES_TOTAL) {
  const secrets = Array.from({ length: n }, () => rand(32));
  return { secrets, signerNodes: secrets.map((s) => schnorr.getPublicKey(s)) };
}

const belowOrder = () => {
  for (;;) { const s = rand(32); if (scalarFrom32(s) < FIELD && scalarFrom32(s) !== 0n) return s; }
};

/** Every signer node deals to every signer node. This is the whole round. */
async function runDkg({ signerNodes, secrets, needed = SHARES_NEEDED, crooked = null }) {
  const id = epochId(signerNodes);
  const contributions = [];
  const chosen = [];
  for (let i = 0; i < signerNodes.length; i++) {
    const secret = belowOrder();
    chosen.push(secret);
    const e = rand(32);
    const dealt = await dealContribution({
      secret, signerNodes, epochId: id, from: signerNodes[i],
      ephemeralSecret: e, ephemeralPubkey: curve.pointX(e),
      coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed, curve,
    });
    assert.equal(dealt.ok, true, dealt.why);

    // A CROOKED DEALER cuts a SECOND polynomial and gives one signer node a share off
    // it, which is letter 29's fault in the committee's own key.
    if (crooked && crooked.dealer === i) {
      const second = splitSecret(belowOrder(), {
        signerNodes: signerNodes.length, needed,
        coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        curve,
      });
      const { sealShare } = await import('../../arena-protocol/src/seal.js');
      const shares = [...dealt.contribution.shares];
      const victim = crooked.victim;
      shares[victim] = {
        ...shares[victim],
        sealed: await sealShare({
          value: second.shares[victim].value, signerNode: shares[victim].signerNode,
          signerNodePubkey: shares[victim].signerNodePubkey, ephemeralSecret: e, curve,
        }),
      };
      contributions.push({ ...dealt.contribution, shares });
      continue;
    }
    contributions.push(dealt.contribution);
  }
  return { id, contributions, chosen };
}

test('every signer node ends with one share of a key nobody made', async () => {
  const c = committee();
  const { contributions, chosen } = await runDkg(c);

  // Every signer node opens ONLY its own envelope from each contribution.
  const held = [];
  for (let i = 0; i < c.signerNodes.length; i++) {
    const opened = [];
    for (const one of contributions) {
      assert.equal(acceptContribution(one, { curve }).ok, true, acceptContribution(one, { curve }).why);
      const mine = await openMyContribution(one, {
        pubkey: c.signerNodes[i], secret: c.secrets[i], curve,
      });
      assert.equal(mine.ok, true, mine.why);
      opened.push(mine);
    }
    const combined = combineShares({ opened, signerNodes: c.signerNodes, contributions, curve });
    assert.equal(combined.ok, true, combined.why);
    held.push(combined);
  }

  // ONE SHARE EACH, AND THE SAME SIGNER NODE NUMBER ACROSS EVERY DEAL.
  assert.equal(held.length, SHARES_TOTAL);
  assert.deepEqual(held.map((h) => h.signerNode), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(held.map((h) => h.share)).size, SHARES_TOTAL,
    'two signer nodes ended up with the same share');
  console.log(`  ${held.length} signer nodes, ${held.length} distinct shares, one each`);

  // THE GROUP KEY IS THE SAME 33 BYTES FOR EVERY SIGNER NODE, from public data alone.
  const keys = c.signerNodes.map(() => groupKeyOf(contributions, curve));
  for (const k of keys) assert.equal(k.ok, true, k.why);
  const first = toHex(keys[0].groupPublicKey);
  for (const k of keys) assert.equal(toHex(k.groupPublicKey), first);
  console.log(`  every signer node computed the same group key: ${first.slice(0, 24)}… `
    + `(${keys[0].negated ? 'odd y, shares negated' : 'even y'})`);

  // AND THE RAW SUM IS THE KEY OF THE SUMMED SECRETS - which is the proof that
  // the shares belong to it, and the number NOBODY in this round ever held.
  // The test can add them up because the test dealt them; no signer node can.
  //
  // AGAINST `summed` AND NOT `groupPublicKey`, and this assertion was wrong
  // first: `groupKeyOf` hands back the EVEN-Y form, which differs from the raw
  // sum whenever the sum came out odd. It passed on a lucky draw and failed on
  // the next one. The signing key is the normalised point; the arithmetic
  // identity is about the sum.
  let total = 0n;
  for (const s of chosen) total = (total + scalarFrom32(s)) % FIELD;
  assert.deepEqual(keys[0].summed, curve.pointFromScalar(total),
    'the summed commitments are not the key of the summed secrets');
  assert.equal(keys[0].negated, keys[0].summed[0] !== 0x02);
  assert.deepEqual(keys[0].groupPublicKey.subarray(1), keys[0].summed.subarray(1),
    'normalising changed the x of the key, not only its parity');

  // AND THE SHARES INTERPOLATE TO THAT SECRET - or to its negation, which is
  // the same key with an even y and is what every signer node actually holds.
  const wanted = keys[0].negated ? (FIELD - total) % FIELD : total;
  const five = held.slice(0, SHARES_NEEDED).map((h) => ({ signerNode: h.signerNode, value: h.share }));
  let rebuilt = 0n;
  for (let i = 0; i < five.length; i++) {
    let term = five[i].value;
    for (let j = 0; j < five.length; j++) {
      if (i === j) continue;
      const xi = BigInt(five[i].signerNode), xj = BigInt(five[j].signerNode);
      const inv = (a) => { let [o, r, no, nr] = [0n, FIELD, 1n, ((a % FIELD) + FIELD) % FIELD];
        while (nr !== 0n) { const q = r / nr; [o, no] = [no, o - q * no]; [r, nr] = [nr, r - q * nr]; }
        return ((o % FIELD) + FIELD) % FIELD; };
      term = (term * (((-xj % FIELD) + FIELD) % FIELD) % FIELD) * inv(xi - xj) % FIELD;
    }
    rebuilt = (rebuilt + term) % FIELD;
  }
  assert.equal(rebuilt, wanted, 'five of the seven shares do not open the group secret');
  console.log('  five of seven interpolate to the secret nobody held');
});

test('a signer node that deals a crooked polynomial is refused by the signer node it cheated, at the deal', async () => {
  const c = committee();
  // Signer node 0 gives signer node 3 a share off a second polynomial.
  const { contributions } = await runDkg({ ...c, crooked: { dealer: 0, victim: 3 } });

  // The shape is fine - that is what makes this the interesting case.
  assert.equal(acceptContribution(contributions[0], { curve }).ok, true);

  let refused = 0;
  const why = [];
  for (let i = 0; i < c.signerNodes.length; i++) {
    const mine = await openMyContribution(contributions[0], {
      pubkey: c.signerNodes[i], secret: c.secrets[i], curve,
    });
    if (!mine.ok) { refused++; why.push(`signer node ${i + 1}: ${mine.why}`); }
  }
  assert.equal(refused, 1, 'a crooked deal was refused by nobody, or by more than the signer node it cheated');
  assert.match(why[0], /crooked polynomial/);
  assert.match(why[0], /signer node 4/);
  console.log(`  ${why[0]}`);
  console.log('  and the other six accepted it, which is what "caught by whoever he cheated" means');
});

test('a combine over anything less than the whole committee is refused', async () => {
  const c = committee();
  const { contributions } = await runDkg(c);
  const opened = [];
  for (const one of contributions) {
    const mine = await openMyContribution(one, { pubkey: c.signerNodes[0], secret: c.secrets[0], curve });
    assert.equal(mine.ok, true, mine.why);
    opened.push(mine);
  }

  // SIX OF SEVEN IS A KEY SIX SIGNER NODES CHOSE. A signer node left out has no randomness
  // in the secret, and a signer node that dealt after seeing the rest could steer it.
  const short = combineShares({
    opened: opened.slice(0, 6), signerNodes: c.signerNodes, contributions: contributions.slice(0, 6),
  });
  assert.equal(short.ok, false);
  assert.match(short.why, /6 of the committee's 7 signer nodes contributed/);

  // AND ONE SIGNER NODE CONTRIBUTING TWICE IS THE SAME ATTACK WEARING A HAT.
  const twice = combineShares({
    opened, signerNodes: c.signerNodes,
    contributions: [...contributions.slice(0, 6), contributions[0]],
  });
  assert.equal(twice.ok, false);
  assert.match(twice.why, /contributed twice/);
  console.log(`  ${short.why}`);
  console.log(`  ${twice.why}`);
});

/**
 * AND THE KEY THEY MADE SIGNS - which is not free, and is where a dealerless
 * key differs from a dealt one.
 *
 * `signShare340` refuses an odd-y group key BY NAME: "normalise the secret
 * when it is dealt, not here". With a dealer that is exactly what happened -
 * `evenGroupSecret` negated the secret before splitting it. Nobody holds the
 * secret here, so nobody can negate it; every signer node negates its OWN share
 * instead, decided alone from the parity of a key it computed from public
 * data. The sum of -x_i is -(sum x_i), so the shares belong to the even-y key.
 *
 * Run until BOTH parities have come up, because a test that only ever saw even
 * keys would pass with the normalisation deleted.
 */
test('five of seven sign under the key they made, whichever parity it came out', async () => {
  let sawEven = 0, sawOdd = 0;
  for (let round = 0; round < 12 && (sawEven === 0 || sawOdd === 0); round++) {
    const c = committee();
    const { contributions } = await runDkg(c);

    const key = groupKeyOf(contributions, curve);
    assert.equal(key.ok, true, key.why);
    if (key.negated) sawOdd++; else sawEven++;
    assert.equal(key.groupPublicKey[0], 0x02, 'the key handed to the signer is not even-y');

    // Every signer node's own share, normalised the way it will hold it.
    const held = [];
    for (let i = 0; i < c.signerNodes.length; i++) {
      const opened = [];
      for (const one of contributions)
        opened.push(await openMyContribution(one, { pubkey: c.signerNodes[i], secret: c.secrets[i], curve }));
      const mine = combineShares({ opened, signerNodes: c.signerNodes, contributions, curve });
      assert.equal(mine.ok, true, mine.why);
      assert.deepEqual(mine.groupPublicKey, key.groupPublicKey);
      assert.equal(mine.negated, key.negated, 'two signer nodes disagreed about the parity');
      held.push(mine);
    }

    // FIVE OF THE SEVEN, through the same two rounds a payout uses.
    const five = held.slice(0, SHARES_NEEDED);
    const message = rand(32);
    const nonces = five.map((h) => ({
      hiding: nonceGenerate(rand(32), h.share),
      binding: nonceGenerate(rand(32), h.share),
    }));
    const commitments = five.map((h, i) => ({
      id: h.signerNode,
      hiding: curve.pointFromScalar(nonces[i].hiding),
      binding: curve.pointFromScalar(nonces[i].binding),
    }));
    const shares = five.map((h, i) => signShare340({
      id: h.signerNode, share: h.share, groupPublicKey: key.groupPublicKey,
      nonces: nonces[i], message, commitments, curve,
    }));
    const sig = aggregate340({
      commitments, message, groupPublicKey: key.groupPublicKey, shares, curve,
    });

    // AND THE VERIFIER IS NOT OURS: it is the one a taproot spend gets.
    assert.equal(sig.signature.length, 64);
    assert.ok(schnorr.verify(sig.signature, message, key.groupPublicKey.subarray(1)),
      `a committee that made its own key produced no signature bitcoin would take `
      + `(parity ${key.negated ? 'odd' : 'even'})`);
  }
  assert.ok(sawEven > 0 && sawOdd > 0,
    `only saw ${sawEven} even and ${sawOdd} odd group keys, so one branch is untested`);
  console.log(`  signed under both parities: ${sawEven} even, ${sawOdd} odd, all verified`);
});

/**
 * AND FOUR OF SEVEN DO NOT, which is what makes the threshold real rather than
 * arithmetic that happens to need five inputs.
 */
test('four of the seven produce nothing a verifier takes', async () => {
  const c = committee();
  const { contributions } = await runDkg(c);
  const key = groupKeyOf(contributions, curve);

  const held = [];
  for (let i = 0; i < c.signerNodes.length; i++) {
    const opened = [];
    for (const one of contributions)
      opened.push(await openMyContribution(one, { pubkey: c.signerNodes[i], secret: c.secrets[i], curve }));
    held.push(combineShares({ opened, signerNodes: c.signerNodes, contributions, curve }));
  }

  const four = held.slice(0, SHARES_NEEDED - 1);
  const message = rand(32);
  const nonces = four.map((h) => ({
    hiding: nonceGenerate(rand(32), h.share), binding: nonceGenerate(rand(32), h.share),
  }));
  const commitments = four.map((h, i) => ({
    id: h.signerNode,
    hiding: curve.pointFromScalar(nonces[i].hiding),
    binding: curve.pointFromScalar(nonces[i].binding),
  }));
  const shares = four.map((h, i) => signShare340({
    id: h.signerNode, share: h.share, groupPublicKey: key.groupPublicKey,
    nonces: nonces[i], message, commitments, curve,
  }));
  const sig = aggregate340({
    commitments, message, groupPublicKey: key.groupPublicKey, shares, curve,
  });
  assert.equal(schnorr.verify(sig.signature, message, key.groupPublicKey.subarray(1)), false,
    'four of seven signed for a five-of-seven key');
  console.log('  four of seven: 64 bytes that verify against nothing');
});
