// THE KEY THE ADVERTISEMENT NAMES IS THE KEY THAT WROTE IT.
//
// 5A.1 ends the body with "signature - by node_pubkey over all of the above",
// and until now nothing checked it: `acceptAdvert` handed back a list of what
// it could not look at, and the signature was on it - "no curve in this
// package". The chain half is unchanged and still does the heavier work: the
// bond output commits to H(NodeAdvertisement), so the endpoint of somebody
// else's bond cannot be swapped without spending it. This is the smaller
// claim, and 5A.1 lists it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { acceptSignedAdvert, advertIsSigned, STILL_UNCHECKED } from '../src/advert.js';
import { acceptAdvert, BOND_UNCHECKED, hash256 } from '../../protocol/src/chain.js';
import {
  encodeAdvert, decodeAdvert, advertId, joinSignedAdvert,
} from '../../protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secret = ed25519.utils.randomSecretKey();
const NODE = schnorr.getPublicKey(secret);
const other = ed25519.utils.randomSecretKey();

const advertFor = (endpoint = 'wss://node.example:443', nodePubkey = NODE) => ({
  nodePubkey, operatorId: 'somebody', protocolVersions: [1],
  roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), timestamp: 1788700000000n,
});

/** The body, signed by whoever is given - the signature sits BESIDE it. */
const courier = (a, key = secret) =>
  joinSignedAdvert(encodeAdvert(a), schnorr.sign(advertId(a), key));

const blockAround = (txid, sibling = new Uint8Array(32).fill(0x99)) => ({
  ...blockOf(hash256, [txid, sibling]), branch: [sibling], position: 0,
});

/**
 * A bond transaction carrying that SIGNED body, and the block that proves it.
 *
 * 5A.2: "the body itself travels in the witness of the same transaction, so it
 * is retrievable by anyone with the chain and there is nothing to serve". So
 * the signature has to be in the transaction, not handed alongside it - which
 * is also why `acceptAdvert` takes the body it finds on chain over anything a
 * caller offers.
 */
function onChain(a, key = secret) {
  const transaction = bondTransaction(a, { signature: schnorr.sign(advertId(a), key) });
  const { header, branch, position } = blockAround(parseTransaction(transaction).txid);
  return { transaction, header, branch, position };
}

/**
 * BEFORE AND AFTER, on one fixture: the chain door says the signature is
 * unchecked, and this door checks it.
 */
test('the chain door leaves the signature unchecked and this one does not', () => {
  const a = advertFor();
  const chain = onChain(a);
  const signed = courier(a);

  const before = acceptAdvert({ ...chain, signedAdvert: signed });
  void signed;
  assert.equal(before.ok, true, before.why);
  assert.ok(BOND_UNCHECKED.some((u) => /advertisement signature/.test(u)),
    'the chain door no longer says the signature is unchecked');

  const after = acceptSignedAdvert({ ...chain, signedAdvert: signed });
  assert.equal(after.ok, true, after.why);
  assert.equal(STILL_UNCHECKED.some((u) => /advertisement signature/.test(u)), false,
    'this door still lists the signature as unchecked after checking it');
  assert.deepEqual(after.unchecked, STILL_UNCHECKED);
  assert.equal(STILL_UNCHECKED.length, BOND_UNCHECKED.length - 1,
    'exactly one thing should have come off the list');

  // and everything the chain door found is still there
  assert.deepEqual(after.nodePubkey, NODE);
  assert.equal(after.endpoint, a.endpoint);
  assert.equal(after.bondSats > 0n, true);
  assert.deepEqual(after.advertId, advertId(a));
});

/**
 * SIGNED BY ANOTHER KEY IS NOT SIGNED. The body still commits correctly and
 * the bond is still a bond - which is the point: this is the one failure the
 * chain cannot see.
 */
test('an advertisement signed by another key is refused by name', () => {
  const a = advertFor();
  const chain = onChain(a);

  const chainWrong = onChain(a, other);          // signed by somebody else
  const wrong = acceptSignedAdvert(chainWrong);
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, new RegExp(`not signed by ${toHex(NODE)}, the node it names`));

  // THE CHAIN DOOR ACCEPTS THAT SAME TRANSACTION, which is why this one
  // exists: the bond is a bond and the commitment matches, and the only thing
  // wrong with it is a signature nothing was checking.
  assert.equal(acceptAdvert(chainWrong).ok, true);

  // an empty signature is not a signature either
  const unsigned = bondTransaction(a);           // 64 zero bytes by default
  const at = blockAround(parseTransaction(unsigned).txid);
  assert.equal(acceptSignedAdvert({ transaction: unsigned, ...at }).ok, false);
});

/**
 * A GOOD SIGNATURE OVER A DIFFERENT BODY IS NOT A SIGNATURE OVER THIS ONE.
 *
 * This is the swap the commitment already refuses on chain; checked here too,
 * because a caller holding a body and a signature has no block to lean on.
 */
test('a signature that covers another body is refused', () => {
  const a = advertFor();
  const elsewhere = advertFor('wss://whoever-the-provider-prefers:443');

  // the signature is over the OTHER body, carried beside this one
  const mismatched = joinSignedAdvert(encodeAdvert(a), schnorr.sign(advertId(elsewhere), secret));
  const seen = advertIsSigned(mismatched);
  assert.equal(seen.ok, false);
  assert.match(seen.why, /not signed by/);

  // and the same body with its own signature passes
  const right = advertIsSigned(courier(a));
  assert.equal(right.ok, true, right.why);
  assert.deepEqual(right.advertId, advertId(a));
  assert.deepEqual(right.signedBy, NODE);
  assert.deepEqual(decodeAdvert(encodeAdvert(right.advert)), a);

  // A BODY THAT VERIFIES IS NOT A BOND. Eligibility is the bond output's
  // business; a door that returned "ok" for a signature alone would be the
  // gossip census 4.6.1 removed.
  assert.equal(right.bondSats, undefined);
  assert.equal(right.endpoint, undefined);

  assert.equal(advertIsSigned(new Uint8Array(10)).ok, false);
  assert.match(advertIsSigned(new Uint8Array(10)).why, /not a signed advertisement/);
});

/**
 * AND A BODY POINTING AT A TRANSACTION THAT IS NOT THE ONE IT ARRIVED IN is
 * refused - by the chain door, before this one is reached, and this door does
 * not paper over it.
 */
test('an advertisement naming another transaction is refused with the chain door\'s reason', () => {
  const a = advertFor();
  const chain = onChain(a);

  void chain;
  // A body claiming its bond is in some OTHER transaction, carried and
  // committed to by the one it actually arrived in, and signed perfectly.
  const elsewhere = { ...a, bondTxid: b32(0x77) };
  const seen = acceptSignedAdvert(onChain(elsewhere));
  assert.equal(seen.ok, false);
  assert.match(seen.why, /names a different bond transaction/);

  // a perfect signature does not rescue it, and the refusal is the chain's
  // reason rather than a signature complaint
  assert.equal(/not signed by/.test(seen.why), false,
    'a chain refusal was reported as a signature failure');
});

/**
 * A KEY OF NOTHING AND A SIGNATURE OF NOTHING VERIFY EACH OTHER.
 *
 * Measured on the curve this door uses: `ed25519.verify(zeros64, anything,
 * zeros32)` returns TRUE - zero decodes to a point of small order and the
 * equation closes trivially. `bondTransaction` fills an unsigned body with
 * exactly 64 zero bytes and calls them "a signature that verifies under no
 * key"; they verify under one. So an advertisement naming the zero key and
 * carrying no signature would otherwise be accepted as signed by the node it
 * names, and its endpoint handed to a player.
 */
test('the zero key and the empty signature do not sign each other', async () => {
  const { ed25519: curve } = await import('@noble/curves/ed25519.js');
  assert.equal(curve.verify(new Uint8Array(64), b32(0x5a), new Uint8Array(32)), true,
    'the curve no longer accepts zeros, so this fixture proves nothing');

  // an advertisement naming the zero key, unsigned - what a bond builder
  // produces by default
  const nobody = advertFor('wss://nobody.example:443', new Uint8Array(32));
  const raw = bondTransaction(nobody);
  const at = blockAround(parseTransaction(raw).txid);

  const seen = acceptSignedAdvert({ transaction: raw, ...at });
  assert.equal(seen.ok, false, 'the zero key signed itself');
  assert.match(seen.why, /names the zero key, which nobody holds/);

  // the chain door has no opinion about it, which is the point
  assert.equal(acceptAdvert({ transaction: raw, ...at }).ok, true);

  // and on a body with no block behind it, both halves are refused
  const body = advertIsSigned(joinSignedAdvert(encodeAdvert(nobody), new Uint8Array(64)));
  assert.equal(body.ok, false);
  assert.match(body.why, /zero key/);

  const real = advertFor();
  const empty = advertIsSigned(joinSignedAdvert(encodeAdvert(real), new Uint8Array(64)));
  assert.equal(empty.ok, false);
  assert.match(empty.why, /carries an empty signature/);
});

/**
 * AND THE CENSUS ITSELF, WITH A REAL CURVE.
 *
 * The door above is the one a client walks through. The census is the one that
 * decides who may be a committee at all, and it used to split the signed body
 * and throw the signature away - so eligibility rested on a body that had been
 * committed to and never authored. It takes a verifier now; this is that
 * verifier, on the curve this daemon already signs with.
 */
test('the census takes a body signed by the key it names, and refuses one that is not', async () => {
  const { resolveCensus } = await import('../../protocol/src/census.js');
  // BIP-340 UNDER THE ONE KEY (letter 26). This used to be ed25519, which is
  // what made a node's identity a different animal from its census entry: the
  // bond is derived from `node_pubkey` on secp256k1, so a body signed on
  // another curve could never be the same key that posted the bond.
  const verifyAdvert = (sig, id, pub) => {
    try { return schnorr.verify(sig, id, pub); } catch { return false; }
  };

  const a = advertFor('wss://census.example:443');
  const bondFrom = (key) => bondTransaction(a, {
    previousTxid: b32(0xa1), previousVout: 0, signature: schnorr.sign(advertId(a), key),
  });
  const entryOf = (transaction) => ({
    txid: parseTransaction(transaction).txid, vout: 0, pubkey: NODE,
    bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
  });
  const contract = { bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST };

  const mine = bondFrom(secret);
  const ok = resolveCensus([entryOf(mine)], {
    contract, resolve: () => ({ transaction: mine }), verifyAdvert,
  });
  assert.equal(ok.ok, true, ok.why);
  // The reasons, not the objects: an entry carries BigInt sats, and
  // JSON.stringify over one throws - so a failing assertion used to raise a
  // TypeError instead of saying what was refused.
  assert.equal(ok.eligible.length, 1, `refused its own signer: ${ok.excluded.map((e) => e.why).join(' | ')}`);
  assert.equal(ok.unchecked.some((u) => /advertisement signature/.test(u)), false);

  const theirs = bondFrom(other);
  const forged = resolveCensus([entryOf(theirs)], {
    contract, resolve: () => ({ transaction: theirs }), verifyAdvert,
  });
  assert.equal(forged.eligible.length, 0, 'a body signed by another key was made eligible');
  assert.match(forged.excluded[0].why, /not signed by the node it names/);

  // and without the verifier the same body is eligible and the gap is named -
  // which is what the census did for every body until now
  const blind = resolveCensus([entryOf(theirs)], {
    contract, resolve: () => ({ transaction: theirs }),
  });
  assert.equal(blind.eligible.length, 1);
  assert.equal(blind.unchecked.some((u) => /advertisement signature/.test(u)), true);
});

/**
 * THE BOND OPTION REACHES THE END OF THIS DOOR.
 *
 * A door that swallowed it would check the signature and then accept whatever
 * thirty-two bytes the poster wrote in the output - and a caller holding the
 * network's arbitration set would have no way to say so. What a daemon does
 * with the set is a later letter's; that it CAN be said is this one's.
 */
test('a signed advertisement over somebody else\'s bond output is refused', async () => {
  const { genesisFor } = await import('../../protocol/src/genesis.js');
  const {
    bondOutputKey, bondInternalKey, BOND_SCRIPT_TEMPLATE_VERSION,
  } = await import('../../protocol/src/bond-script.js');

  const big = (b) => BigInt('0x' + toHex(b));
  const tweakPoint = (internalKey, tweak) => {
    const P = schnorr.utils.lift_x(big(internalKey));
    const Q = P.add(secp256k1.Point.BASE.multiply(big(tweak)));
    return { outputKey: schnorr.utils.pointToBytes(Q), parity: Number(Q.toAffine().y & 1n) };
  };
  const combine = (terms) => {
    let sum = null;
    for (const { key, coefficient } of terms) {
      const point = schnorr.utils.lift_x(big(key)).multiply(big(coefficient));
      sum = sum === null ? point : sum.add(point);
    }
    return schnorr.utils.pointToBytes(sum);
  };

  const g = genesisFor('regtest');
  const bond = {
    arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity, tweakPoint, combine,
  };

  // The node signs with ed25519 and bonds with secp: two keys, two curves,
  // exactly as 5A.1 and 5A.3B have it.
  const bondSecret = schnorr.utils.randomSecretKey();
  const bondKey = schnorr.getPublicKey(bondSecret);
  const honest = bondOutputKey({
    nodeKey: bondKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK,
    bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey: bondKey, arbitrationKeys: g.arbitrationKeys },
      { combine }).internalKey,
  }, { tweakPoint, combine }).outputKey;

  // The advertisement names the BOND key, so the output can be rebuilt from it.
  const a = { ...advertFor('wss://bonded.example:443'), nodePubkey: bondKey };
  const signedFor = (secret) => schnorr.sign(advertId(a), secret);
  const ed = ed25519.utils.randomSecretKey();
  void signedFor; void ed;

  const built = (outputKey) => {
    const tx = bondTransaction(a, { outputKey, signature: new Uint8Array(64).fill(7) });
    return { transaction: tx, ...blockAround(parseTransaction(tx).txid) };
  };

  // A bond that is not this node's - the output key is a stranger's taproot -
  // is refused once the set is handed in, and accepted without it.
  const stranger = built(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const withSet = acceptSignedAdvert({ ...stranger, bond });
  assert.equal(withSet.ok, false, "a stranger's output passed the door");
  assert.match(withSet.why, /not the taproot tweak/);

  const withoutSet = acceptSignedAdvert(stranger);
  assert.equal(withoutSet.ok, false, 'the signature is still checked either way');
  assert.match(withoutSet.why, /not signed by/, 'the refusal changed shape without the set');

  // AND THE UNCHECKED LIST SHRINKS BY BOTH, INDEPENDENTLY: the signature comes
  // off because this door reads it, the template because the set was given.
  assert.equal(STILL_UNCHECKED.some((u) => /advertisement signature/.test(u)), false);
  assert.equal(honest.length, 32);
});

/**
 * THE DOOR A PLAYER WALKS THROUGH CHECKS THE MARKER OF THE ROUND'S NETWORK.
 *
 * 5A.2 makes the dust output to BOND_MARKER the whole of findability, one
 * address per network. This door had no opinion about which network it was on,
 * so it looked for the regtest output whatever the round said - and what comes
 * back from here is an ENDPOINT a player connects to, backed by a bond that
 * might have been posted on another chain entirely.
 */
test('an advertisement is checked against its own network\'s marker, not always regtest', async () => {
  const { bondMarker } = await import('../../protocol/src/constants.js');
  assert.notDeepEqual(bondMarker('regtest'), bondMarker('testnet'));

  const a = advertFor('wss://bonded.example:443');
  const at = (tx) => {
    const sibling = new Uint8Array(32).fill(0x99);
    return { ...blockOf(hash256, [parseTransaction(tx).txid, sibling]), branch: [sibling], position: 0 };
  };
  const onRegtest = bondTransaction(a, {
    signature: schnorr.sign(advertId(a), secret), network: 'regtest',
  });
  const onTestnet = bondTransaction(a, {
    signature: schnorr.sign(advertId(a), secret), network: 'testnet', previousTxid: b32(0xb2),
  });

  // A TESTNET ROUND TAKES THE TESTNET BOND AND REFUSES THE REGTEST ONE.
  const good = acceptSignedAdvert({ transaction: onTestnet, ...at(onTestnet), network: 'testnet' });
  assert.equal(good.ok, true, good.why);
  assert.equal(good.endpoint, a.endpoint);

  const wrongChain = acceptSignedAdvert({ transaction: onRegtest, ...at(onRegtest), network: 'testnet' });
  assert.equal(wrongChain.ok, false, 'a testnet round took a bond posted on regtest');
  assert.match(wrongChain.why, /no dust output to BOND_MARKER/);

  // AND THE MIRROR, so the check is the network's and not a preference for one.
  assert.equal(acceptSignedAdvert({ transaction: onRegtest, ...at(onRegtest), network: 'regtest' }).ok,
    true);
  assert.equal(acceptSignedAdvert({ transaction: onTestnet, ...at(onTestnet), network: 'regtest' }).ok,
    false, 'a regtest round took a bond posted on testnet');

  // WITH NO NETWORK NAMED it behaves as it always did - regtest - so nothing
  // that worked before stopped working, and a caller that knows the round is
  // the one that says otherwise.
  assert.equal(acceptSignedAdvert({ transaction: onRegtest, ...at(onRegtest) }).ok, true);
  assert.equal(acceptSignedAdvert({ transaction: onTestnet, ...at(onTestnet) }).ok, false);
});
