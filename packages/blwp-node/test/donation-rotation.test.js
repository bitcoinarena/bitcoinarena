// THE ROTATION, ON THE REAL CURVE.
//
// `packages/protocol` carries no curve, so its own suite checks 27A.4's rules
// against a stub verifier: the injection, the ordering, the refusals. This is
// the same rotation done with real Ed25519 keys - the donation authority's
// scheme (ruled 2026-09-13: the keys genesis hashes into the network ids are
// Ed25519; this file used BIP-340 until then, with the same checks) - because
// "the recovery key revokes the authority" is a sentence about a signature,
// and a signature checked by a stub is a sentence nobody has spoken.
//
// 27A.4's own row is the test: the authority is stolen, the thief signs a set
// with a HIGHER serial pointing at their own LNURLs, and the cold key ends it.
// No fork, no census lost, nothing else touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import {
  donationSetBodyId, authorityRotationId, donationSetInForce, authorityAt,
} from '../../protocol/src/authority.js';
import { splitDonation, donationSetMatchesRound, donationSetId } from '../../protocol/src/donation.js';
import { toHex } from '../../protocol/src/hash.js';
import { networkAnchor } from '../../protocol/src/constants.js';

const NETWORK = networkAnchor('regtest');
const verify = (sig, digest, key) => {
  try { return ed25519.verify(sig, digest, key); } catch { return false; }
};

const keypair = (fill) => {
  const secret = new Uint8Array(32).fill(fill);
  return { secret, pubkey: ed25519.getPublicKey(secret) };
};

const AUTHORITY = keypair(0x11);
const RECOVERY = keypair(0x22);
const REPLACEMENT = keypair(0x33);

const OURS = [
  { lnurl: 'lnurl1devfund', shareBps: 7000 },
  { lnurl: 'lnurl1relays', shareBps: 3000 },
];
const THEIRS = [{ lnurl: 'lnurl1thief', shareBps: 10000 }];

const publish = (key, { serial, validFrom, recipients }) => {
  const body = { networkId: NETWORK, serial, validFrom, recipients };
  return { ...body, signature: ed25519.sign(donationSetBodyId(body), key.secret) };
};

const rotate = (key, { serial, newAuthority, validFrom }) => {
  const body = { networkId: NETWORK, serial, newAuthority, validFrom };
  return { ...body, signature: ed25519.sign(authorityRotationId(body), key.secret) };
};

test('a stolen authority is revoked by the cold key, and the theft ends at a height', () => {
  const honest = publish(AUTHORITY, { serial: 2n, validFrom: 100, recipients: OURS });
  const stolen = publish(AUTHORITY, { serial: 500n, validFrom: 120, recipients: THEIRS });

  const keys = { authority: AUTHORITY.pubkey, recovery: RECOVERY.pubkey };
  const at = (height, rotations = []) => donationSetInForce({
    networkId: NETWORK, ...keys, sets: [honest, stolen], rotations, height, verify,
  });

  // THE THEFT WORKS, and saying so is the point: the higher serial wins and
  // the thief is paid until somebody notices. A test that could not show the
  // damage could not show that the remedy removes it.
  const during = at(200);
  assert.equal(during.ok, true, during.why);
  assert.equal(during.serial, 500n);
  assert.deepEqual(during.recipients, THEIRS);

  // THE REMEDY. One object signed by a key that has done nothing until now.
  const rotation = rotate(RECOVERY, {
    serial: 1n, newAuthority: REPLACEMENT.pubkey, validFrom: 300,
  });

  const stillStolen = at(299, [rotation]);
  assert.equal(stillStolen.serial, 500n, 'a rotation applies from its own height, not on arrival');

  // AND A ROTATION BLANKS THE LIST, which is the reading 27A.4 forces and not
  // a strictness of taste: "from `valid_from`, sets signed by the old
  // authority are rejected". The honest set at serial 2 was signed by the same
  // key the thief stole, so it dies with it - and it has to. The alternative
  // is grandfathering everything published before the rotation, and the
  // thief's set was published before the rotation too.
  //
  // So the network pays NOBODY between the rotation and the new authority's
  // first publication. That is not the "both lost" row's freeze - that row is
  // about a set nobody can replace - it is the price of revocation, and the
  // one thing it cannot do is keep paying the thief.
  const after = at(300, [rotation]);
  assert.equal(after.ok, false, 'a set signed by the revoked key was still in force');
  assert.match(after.why, /none of the 2 sets offered/);
  assert.equal(after.refused.filter((r) => /is not/.test(r)).length, 2);
  assert.equal(after.rotated, true);
  assert.equal(toHex(after.authority), toHex(REPLACEMENT.pubkey));

  // THE NEW AUTHORITY REPUBLISHES, and the recipients are the network's again.
  // At its own serial, which is lower than the thief's 9000: ordering is by
  // serial only among sets the current key signed, so the old key cannot
  // outbid the new one by picking a big number.
  const next = publish(REPLACEMENT, { serial: 3n, validFrom: 300, recipients: OURS });
  const back = donationSetInForce({
    networkId: NETWORK, ...keys, sets: [honest, stolen, next], rotations: [rotation],
    height: 300, verify,
  });
  assert.equal(back.ok, true, back.why);
  assert.equal(back.serial, 3n);
  assert.deepEqual(back.recipients, OURS, 'donations went to the wrong people after a rotation');

  // AND THE OLD KEY CANNOT COME BACK by publishing higher.
  const desperate = publish(AUTHORITY, { serial: 9000n, validFrom: 301, recipients: THEIRS });
  const refused = donationSetInForce({
    networkId: NETWORK, ...keys, sets: [honest, stolen, next, desperate],
    rotations: [rotation], height: 400, verify,
  });
  assert.equal(refused.serial, 3n);
  assert.deepEqual(refused.recipients, OURS);
  assert.equal(refused.refused.filter((r) => /is not/.test(r)).length, 3);
});

test('the recovery key can only name an authority, and a real signature proves which key signed', () => {
  const keys = { networkId: NETWORK, authority: AUTHORITY.pubkey, recovery: RECOVERY.pubkey };

  // The authority signing its own rotation is the failure the two keys exist
  // to prevent, and on a real curve it is a valid signature by the wrong key -
  // not a malformed object. Only the check makes it a refusal.
  const selfServed = rotate(AUTHORITY, {
    serial: 1n, newAuthority: REPLACEMENT.pubkey, validFrom: 10,
  });
  assert.equal(
    verify(selfServed.signature, authorityRotationId(selfServed), AUTHORITY.pubkey), true,
    'the stolen key did sign it',
  );
  const at = authorityAt({ ...keys, rotations: [selfServed], height: 1000, verify });
  assert.equal(at.rotated, false);
  assert.equal(toHex(at.authority), toHex(AUTHORITY.pubkey));

  // And the recovery key cannot publish recipients either: it signs rotations,
  // and a set carrying its signature is a set signed by nobody the network
  // asked.
  const overreach = publish(RECOVERY, { serial: 9n, validFrom: 1, recipients: THEIRS });
  const answer = donationSetInForce({ ...keys, sets: [overreach], height: 1000, verify });
  assert.equal(answer.ok, false);
  assert.match(answer.refused.join(' '), /is not/);
});

test('the set in force is the set a round can name, and it still pays nobody here', () => {
  const set = publish(AUTHORITY, { serial: 1n, validFrom: 1, recipients: OURS });
  const answer = donationSetInForce({
    networkId: NETWORK, authority: AUTHORITY.pubkey, recovery: RECOVERY.pubkey,
    sets: [set], height: 10, verify,
  });
  assert.equal(answer.ok, true, answer.why);

  // 22A's binding is unchanged by any of this: the contract names the
  // RECIPIENTS' hash, which is a different id from the publication's, and a
  // round built on the set in force matches it.
  const contract = { donationSetId: donationSetId(answer.recipients) };
  assert.equal(donationSetMatchesRound(contract, answer.recipients).ok, true);
  assert.notEqual(toHex(donationSetId(answer.recipients)), toHex(donationSetBodyId(set)));

  // AND THE MONEY IS STILL ZERO. Nothing in this letter charges a donation:
  // an entry's `donationMsat` is 0n, and 22A's own rule is that the set is
  // then irrelevant to that entry.
  const split = splitDonation({ donationMsat: 0n, recipients: answer.recipients });
  assert.equal(split.owed, true);
  assert.deepEqual(split.shares.map((s) => s.amountMsat), [0n, 0n]);
});
