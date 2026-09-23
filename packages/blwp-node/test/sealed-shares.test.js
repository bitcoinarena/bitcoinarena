// ONE SHARE, ONE SIGNER NODE, AND NOBODY ELSE.
//
// Measured before this existed, against a running daemon: a stranger holding
// only the entry contract's public `vss_shares_ref` read all seven shares and
// reconstructed the stake preimage - 21 of the 21 five-subsets opened it. That
// is what `handout.js` warned about itself ("a build that pays sats must not
// use this file as it stands"), and the hold invoice made it true.
//
// What is measured here is the closing number: a stranger opens ZERO.
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup, ecdhShared } from '../src/curve.js';
import { splitSecret, reconstruct, SHARES_NEEDED } from '../../protocol/src/shares.js';
import { sealShare, openShare } from '../../protocol/src/seal.js';
import {
  dealHandout, encodeHandout, decodeHandout, openMyShare, acceptHandout,
} from '../../protocol/src/handout.js';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const secret = () => new Uint8Array(randomBytes(32));

const contractFor = (node) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  // seven settlement signer nodes: the handout is dealt 5-of-7, and the door asks the
  // round what its stakes open at (M3.3-26)
  gameVerifySlots: 2, settlementSlots: 7, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', startTimeMs: 500n + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: 200000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [node.round.pubkey, b32(9)],
});

/** A committee of seven whose keys this test holds, so it can play any of them. */
function committee(n = 7) {
  const secrets = Array.from({ length: n }, () => secret());
  return { secrets, keys: secrets.map((s) => schnorr.getPublicKey(s)) };
}

async function deal(preimage, keys, roundId = b32(1)) {
  const e = secret();
  const out = await dealHandout({
    preimage, signerNodes: keys, roundId, playerPubkey: b32(5),
    ephemeralSecret: e, ephemeralPubkey: schnorr.getPublicKey(e),
    coefficients, curve: feldmanGroup,
  });
  assert.equal(out.ok, true, out.why);
  return Object.assign(out.handout, { ephemeralSecret: e });
}

test('the shared secret is the same from either end, and different for every signer node', () => {
  // NO NEGATION IS NEEDED AND THAT IS MEASURED, not assumed: x(kP) equals
  // x(-kP), which is why an x-only agreement works at all. The first version
  // normalised the secret to an even-y point the way BIP-340 signing does, a
  // mutant deleting it survived every test, and it turned out to be ceremony.
  let agreed = 0;
  const seen = new Set();
  for (let i = 0; i < 32; i++) {
    const a = secret(); const b = secret();
    const fromA = ecdhShared(a, schnorr.getPublicKey(b));
    const fromB = ecdhShared(b, schnorr.getPublicKey(a));
    if (toHex(fromA) === toHex(fromB)) agreed++;
    seen.add(toHex(fromA));
  }
  assert.equal(agreed, 32, 'the two ends of an ECDH did not agree');
  assert.equal(seen.size, 32, 'two different pairs derived one secret');
});

test('a signer node opens exactly one share, and no other signer node\'s', async () => {
  const { secrets, keys } = committee();
  const preimage = sha256(b32(3));
  const handout = await deal(preimage, keys);

  let mine = 0, theirs = 0;
  for (let i = 0; i < keys.length; i++) {
    for (const share of handout.shares) {
      const out = await openShare({
        sealed: share.sealed, signerNode: share.signerNode, secret: secrets[i],
        ephemeralPubkey: handout.ephemeralPubkey, curve: feldmanGroup,
      });
      if (out.ok) { if (share.signerNode === i + 1) mine++; else theirs++; }
    }
  }
  assert.equal(mine, 7, 'a signer node could not open the share it was dealt');
  assert.equal(theirs, 0, 'a signer node opened a share dealt to somebody else');
});

test('a stranger with the whole handout opens nothing at all', async () => {
  const { keys } = committee();
  const preimage = sha256(b32(4));
  const handout = await deal(preimage, keys);

  // The stranger has everything that is public: the envelopes, the recipients,
  // the dealer's one-time key and the commitments. What it does not have is a
  // signer node's secret, and that is the whole difference.
  const passerBy = secret();
  let opened = 0;
  for (const share of handout.shares) {
    const out = await openShare({
      sealed: share.sealed, signerNode: share.signerNode, secret: passerBy,
      ephemeralPubkey: handout.ephemeralPubkey, curve: feldmanGroup,
    });
    if (out.ok) opened++;
    else assert.match(out.why, /sealed to somebody else/);
  }
  assert.equal(opened, 0, `a stranger opened ${opened} shares, and ${SHARES_NEEDED} is the whole stake`);
  for (const share of handout.shares)
    assert.equal(share.sealed.length, 48, 'a sealed share is 32 bytes of scalar and a 16-byte tag');
});

test('the daemon serves the handout to anyone and it is still worth nothing', async () => {
  const node = await serve(openStore(':memory:'), {
    port: 0, funded: () => true, randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }),
  });
  try {
    const contract = contractFor(node);
    const rid = new Uint8Array(await (await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(contract) })).arrayBuffer());

    const { keys } = committee(6);
    const signerNodes = [node.round.pubkey, ...keys];
    const preimage = sha256(b32(6));
    const handout = await deal(preimage, signerNodes, rid);
    // ONE READ OF THE BODY. A Response body is consumable once, and reading
    // it for an assertion message and then for its bytes throws.
    const posted = await fetch(`http://127.0.0.1:${node.port}/handout`,
      { method: 'POST', body: encodeHandout(handout) });
    const id = new Uint8Array(await posted.arrayBuffer());
    assert.equal(posted.status, 201, new TextDecoder().decode(id));
    assert.equal(posted.headers.get('x-signer-node'), '1');

    // THE SAME GET THAT USED TO HAND OVER THE STAKE.
    const got = await fetch(`http://127.0.0.1:${node.port}/handout?id=${toHex(id)}`);
    assert.equal(got.status, 200);
    const seen = decodeHandout(new Uint8Array(await got.arrayBuffer()));
    assert.equal(seen.shares.length, 7);
    assert.equal(seen.shares.filter((s) => s.value !== undefined).length, 0,
      'the wire still carries a share in the clear');

    const passerBy = secret();
    let opened = 0;
    for (const share of seen.shares) {
      const out = await openShare({
        sealed: share.sealed, signerNode: share.signerNode, secret: passerBy,
        ephemeralPubkey: seen.ephemeralPubkey, curve: feldmanGroup,
      });
      if (out.ok) opened++;
    }
    assert.equal(opened, 0, 'a stranger opened a share off the public door');
    assert.throws(() => reconstruct([], { needed: SHARES_NEEDED }),
      /0 shares cannot reconstruct anything/);
  } finally { await node.close(); }
});

test('a dealer is refused by the signer node he cheated, and only by that signer node', async () => {
  // What changed with secrecy: a node sees ONE share, so it catches a crooked
  // dealer when it is the one cheated. That is not weaker - a handout five
  // signer nodes accepted is a handout five signer nodes can open - but it IS different, and
  // the difference is measured rather than argued.
  const { secrets, keys } = committee();
  const honest = await deal(sha256(b32(7)), keys);
  const second = splitSecret(secret(), {
    coefficients: coefficients.map((x) => x + 99n), curve: feldmanGroup,
  });

  // SEALED UNDER THE SAME ONE-TIME KEY, so it OPENS and is simply not on the
  // polynomial. A share sealed under a different key would not open at all,
  // which is a different fault with a different name.
  const crookedAt = 4;                       // signer node 5, counting from one
  const shares = [...honest.shares];
  shares[crookedAt] = {
    ...shares[crookedAt],
    sealed: await sealShare({
      value: second.shares[crookedAt].value, signerNode: shares[crookedAt].signerNode,
      signerNodePubkey: shares[crookedAt].signerNodePubkey,
      ephemeralSecret: honest.ephemeralSecret, curve: feldmanGroup,
    }),
  };
  const handout = { ...honest, shares };
  assert.equal(acceptHandout(handout).ok, true, 'the shape is fine; only one share is a lie');

  let refused = 0, accepted = 0;
  for (let i = 0; i < keys.length; i++) {
    const seen = await openMyShare(handout, {
      pubkey: keys[i], secret: secrets[i], curve: feldmanGroup,
    });
    if (seen.ok) accepted++;
    else refused++;
  }
  assert.equal(refused, 1, 'the cheated signer node did not refuse, or an honest one did');
  assert.equal(accepted, 6);

  const cheated = await openMyShare(handout, {
    pubkey: keys[crookedAt], secret: secrets[crookedAt], curve: feldmanGroup,
  });
  assert.equal(cheated.ok, false);
  assert.match(cheated.why, /not on the polynomial the dealer published/);
});

test('a node that was dealt nothing keeps nothing', async () => {
  const { keys } = committee();
  const handout = await deal(sha256(b32(8)), keys);
  const outsider = secret();
  const seen = await openMyShare(handout, {
    pubkey: schnorr.getPublicKey(outsider), secret: outsider, curve: feldmanGroup,
  });
  assert.equal(seen.ok, false);
  assert.match(seen.why, /not one of the signer nodes that handout was dealt to/);
});

test('two signer nodes never share a key, even holding one secret between them', async () => {
  // THE SIGNER NODE IS IN THE KEY DERIVATION, and this is what that buys. Without it
  // the key would be the ECDH secret alone - unique per signer node today only
  // because `acceptHandout` refuses a handout that addresses one key twice.
  // Domain separation should not depend on a rule three files away.
  const s = secret();
  const signerNodePubkey = schnorr.getPublicKey(s);
  const e = secret();
  const value = 12345678901234567890n;
  const one = await sealShare({ value, signerNode: 1, signerNodePubkey, ephemeralSecret: e, curve: feldmanGroup });
  const two = await sealShare({ value, signerNode: 2, signerNodePubkey, ephemeralSecret: e, curve: feldmanGroup });
  assert.notEqual(toHex(one), toHex(two),
    'one share sealed under two signer node numbers produced one ciphertext');

  // And each opens only under its own number.
  const right = await openShare({ sealed: one, signerNode: 1, secret: s,
    ephemeralPubkey: schnorr.getPublicKey(e), curve: feldmanGroup });
  assert.equal(right.ok, true, right.why);
  assert.equal(right.share.value, value);
  const wrong = await openShare({ sealed: one, signerNode: 2, secret: s,
    ephemeralPubkey: schnorr.getPublicKey(e), curve: feldmanGroup });
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /sealed to somebody else/);
});
