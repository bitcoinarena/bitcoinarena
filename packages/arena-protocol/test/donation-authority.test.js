// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 27A.4, MEASURED: which set, from when, and whose signature.
//
// The suite before this one tested a list of payees against its own shares.
// Everything here is about the four fields that decide WHOSE list it is - and
// the case the section itself calls the reason for two keys: the authority is
// stolen, the thief signs a higher serial pointing at their own LNURLs, and a
// rotation from the cold key ends it without a fork.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeDonationSetBody, decodeDonationSetBody, donationSetBodyId,
  encodeAuthorityRotation, decodeAuthorityRotation, authorityRotationId,
  authorityAt, donationSetInForce, donationSetSignedBy, rotationSignedBy,
  DONATION_SIGNATURE_BYTES,
} from '../src/authority.js';
import { donationKeysFor } from '../src/genesis.js';
import { networkAnchor } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (v) => new Uint8Array(32).fill(v);

// A STUB CURVE, because this package has none and must not - `census-resolve`
// signs the same way for the same reason. What is measured here is the rule,
// not the mathematics: that a signature reaches a verifier, that the right KEY
// is the one it is checked against, and that a refusal removes the object. The
// real BIP-340 does this one package over, where the dependency lives.
const signWith = (key, digest) => {
  const sig = new Uint8Array(DONATION_SIGNATURE_BYTES);
  sig.set(digest, 0);
  sig.set(key, 32);
  return sig;
};
const verify = (sig, digest, key) =>
  sig.length === DONATION_SIGNATURE_BYTES
  && digest.every((b, i) => b === sig[i])
  && key.every((b, i) => b === sig[32 + i]);

const NETWORK = b32(0x77);
const AUTHORITY = b32(0xa1);
const RECOVERY = b32(0xc0);
const THIEF = b32(0xbd);

const RECIPIENTS = [
  { lnurl: 'lnurl1one', shareBps: 6000 },
  { lnurl: 'lnurl1two', shareBps: 4000 },
];
const THEIRS = [{ lnurl: 'lnurl1thief', shareBps: 10000 }];

const setOf = ({ serial, validFrom = 100, recipients = RECIPIENTS, key = AUTHORITY,
  networkId = NETWORK }) => {
  const body = { networkId, serial, validFrom, recipients };
  return { ...body, signature: signWith(key, donationSetBodyId(body)) };
};

const rotationOf = ({ serial, newAuthority, validFrom = 200, key = RECOVERY,
  networkId = NETWORK }) => {
  const body = { networkId, serial, newAuthority, validFrom };
  return { ...body, signature: signWith(key, authorityRotationId(body)) };
};

const inForce = (opts) => donationSetInForce({
  networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY, verify, ...opts,
});

test('a donation set carries the four fields 27A.4 names, and survives the wire', () => {
  const body = { networkId: NETWORK, serial: 7n, validFrom: 900123, recipients: RECIPIENTS };
  const bytes = encodeDonationSetBody(body);
  const back = decodeDonationSetBody(bytes);

  assert.equal(toHex(back.networkId), toHex(NETWORK));
  assert.equal(back.serial, 7n);
  assert.equal(back.validFrom, 900123);
  assert.deepEqual(back.recipients, RECIPIENTS);
  assert.equal(toHex(donationSetBodyId(back)), toHex(donationSetBodyId(body)));

  // AND A DIFFERENT SERIAL IS A DIFFERENT OBJECT. Two publications of the same
  // payees at two serials must not share an id, or the ordering is not signed.
  assert.notEqual(
    toHex(donationSetBodyId({ ...body, serial: 8n })),
    toHex(donationSetBodyId(body)),
  );
  assert.notEqual(
    toHex(donationSetBodyId({ ...body, validFrom: 900124 })),
    toHex(donationSetBodyId(body)),
  );
});

test('a set that does not stand cannot be published, so no such signature exists', () => {
  assert.throws(
    () => encodeDonationSetBody({
      networkId: NETWORK, serial: 1n, validFrom: 1,
      recipients: [{ lnurl: 'lnurl1one', shareBps: 9999 }],
    }),
    /9999 basis points/,
  );

  // And the bytes inherit the set's own canonicality: a stranger's uppercase
  // spelling is refused on the way in, exactly as `decodeDonationSet` refuses
  // it, because a publication is not allowed a second encoding either.
  const good = encodeDonationSetBody({
    networkId: NETWORK, serial: 1n, validFrom: 1,
    recipients: [{ lnurl: 'lnurl1abc', shareBps: 10000 }],
  });
  const shouted = good.slice();
  for (let i = 0; i < shouted.length - 8; i++)
    if (shouted[i] === 0x6c && shouted[i + 1] === 0x6e && shouted[i + 2] === 0x75)
      { shouted[i] = 0x4c; break; }
  assert.throws(() => decodeDonationSetBody(shouted), /canonical|not stand/);
});

test('an unsigned set is not in force, which is the whole difference from a list', () => {
  const unsigned = { networkId: NETWORK, serial: 1n, validFrom: 1, recipients: RECIPIENTS };
  const one = inForce({ sets: [unsigned], height: 1000 });
  assert.equal(one.ok, false);
  assert.match(one.refused.join(' '), /signature is 64 bytes/);

  const forged = { ...unsigned, signature: signWith(THIEF, donationSetBodyId(unsigned)) };
  const two = inForce({ sets: [forged], height: 1000 });
  assert.equal(two.ok, false);
  assert.match(two.refused.join(' '), /is not .*'s/);

  const honest = setOf({ serial: 1n, validFrom: 1 });
  const three = inForce({ sets: [honest], height: 1000 });
  assert.equal(three.ok, true, three.why);
  assert.deepEqual(three.recipients, RECIPIENTS);
  assert.equal(donationSetSignedBy(honest, { authority: AUTHORITY, verify }).ok, true);
  assert.equal(donationSetSignedBy(honest, { authority: THIEF, verify }).ok, false);
});

test('the highest validly signed serial wins, and an older one published later changes nothing', () => {
  const first = setOf({ serial: 3n, validFrom: 10 });
  const second = setOf({ serial: 9n, validFrom: 20, recipients: [
    { lnurl: 'lnurl1new', shareBps: 10000 },
  ] });

  const now = inForce({ sets: [first, second], height: 1000 });
  assert.equal(now.serial, 9n);
  assert.deepEqual(now.recipients.map((r) => r.lnurl), ['lnurl1new']);

  // THE ROLLBACK, which is what publication on a chain anybody can append to
  // makes possible: an old set re-published after a new one. Order of arrival
  // is not order of authority.
  const rolled = inForce({ sets: [second, first, first], height: 1000 });
  assert.equal(rolled.serial, 9n);
  assert.deepEqual(rolled.recipients.map((r) => r.lnurl), ['lnurl1new']);
});

test('a set is for one network and applies from one height', () => {
  const foreign = setOf({ serial: 5n, validFrom: 1, networkId: b32(0x66) });
  const soon = setOf({ serial: 5n, validFrom: 900000 });

  const other = inForce({ sets: [foreign], height: 900000 });
  assert.equal(other.ok, false);
  assert.match(other.refused.join(' '), /another network/);

  const early = inForce({ sets: [soon], height: 899999 });
  assert.equal(early.ok, false);
  assert.match(early.refused.join(' '), /not in force at 899999/);

  const due = inForce({ sets: [soon], height: 900000 });
  assert.equal(due.ok, true, due.why);
  assert.equal(due.validFrom, 900000);
});

test('two different sets at one serial lose that serial and the older one stays in force', () => {
  const old = setOf({ serial: 4n, validFrom: 10 });
  const a = setOf({ serial: 5n, validFrom: 20 });
  const b = setOf({ serial: 5n, validFrom: 20, recipients: THEIRS });

  const answer = inForce({ sets: [old, a, b], height: 1000 });
  assert.equal(answer.ok, true, answer.why);
  assert.equal(answer.serial, 4n, 'a contested serial must not be picked by its bytes');
  assert.deepEqual(answer.recipients, RECIPIENTS);
  assert.match(answer.refused.join(' '), /serial 5 is unusable|serial 5, so that serial is unusable/);

  // And the answer does not depend on which order they were handed over.
  const swapped = inForce({ sets: [b, a, old], height: 1000 });
  assert.equal(swapped.serial, 4n);
});

test('the recovery key names a new authority, and from that height the old key is finished', () => {
  const NEW = b32(0x5e);
  const rotation = rotationOf({ serial: 1n, newAuthority: NEW, validFrom: 500 });

  const before = authorityAt({
    networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY,
    rotations: [rotation], height: 499, verify,
  });
  assert.equal(before.rotated, false);
  assert.equal(toHex(before.authority), toHex(AUTHORITY));

  const after = authorityAt({
    networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY,
    rotations: [rotation], height: 500, verify,
  });
  assert.equal(after.rotated, true);
  assert.equal(toHex(after.authority), toHex(NEW));

  // THE ROW THE SECTION IS WRITTEN FOR. The thief holds the old authority and
  // publishes a much higher serial pointing at their own address. Before the
  // rotation it wins; from `valid_from` it is refused WHATEVER SERIAL IT
  // CARRIES, and the new key's lower serial is what the network pays.
  const stolen = setOf({ serial: 99n, validFrom: 10, recipients: THEIRS });
  const honest = { ...setOf({ serial: 2n, validFrom: 500 }) };
  honest.signature = signWith(NEW, donationSetBodyId({
    networkId: NETWORK, serial: 2n, validFrom: 500, recipients: RECIPIENTS,
  }));

  const stolenWins = inForce({ sets: [stolen, honest], rotations: [rotation], height: 499 });
  assert.equal(stolenWins.serial, 99n, 'before the rotation the stolen key is the authority');
  assert.deepEqual(stolenWins.recipients, THEIRS);

  const revoked = inForce({ sets: [stolen, honest], rotations: [rotation], height: 500 });
  assert.equal(revoked.ok, true, revoked.why);
  assert.equal(revoked.serial, 2n);
  assert.deepEqual(revoked.recipients, RECIPIENTS);
  assert.match(revoked.refused.join(' '), /is not .*'s/);
  assert.equal(revoked.rotated, true);
});

test('the working key cannot rotate itself, and a rotation names no new recovery key', () => {
  const NEW = b32(0x5e);
  const selfServed = rotationOf({ serial: 1n, newAuthority: NEW, key: AUTHORITY });
  const at = authorityAt({
    networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY,
    rotations: [selfServed], height: 1000, verify,
  });
  assert.equal(at.rotated, false, 'the authority key rotated itself');
  assert.equal(rotationSignedBy(selfServed, { recovery: RECOVERY, verify }).ok, false);
  assert.equal(rotationSignedBy(selfServed, { recovery: AUTHORITY, verify }).ok, true,
    'the stub is checking the key and not the shape');

  // EXHAUSTIVELY: the object has four fields and none of them is a recovery
  // key. A rotation that could name one would let a single theft of the cold
  // key close the door behind itself.
  const decoded = decodeAuthorityRotation(encodeAuthorityRotation({
    networkId: NETWORK, serial: 1n, newAuthority: NEW, validFrom: 200,
  }));
  assert.deepEqual(Object.keys(decoded).sort(), ['networkId', 'newAuthority', 'serial', 'validFrom']);

  // And a rotation for another network is not this network's business.
  const foreign = rotationOf({ serial: 1n, newAuthority: NEW, networkId: b32(0x66) });
  const elsewhere = authorityAt({
    networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY,
    rotations: [foreign], height: 1000, verify,
  });
  assert.equal(elsewhere.rotated, false);
  assert.match(elsewhere.refused.join(' '), /another network/);
});

test('rotations are ordered by their own serial, separately from the sets', () => {
  const FIRST = b32(0x51);
  const SECOND = b32(0x52);
  const one = rotationOf({ serial: 1n, newAuthority: FIRST, validFrom: 100 });
  const two = rotationOf({ serial: 2n, newAuthority: SECOND, validFrom: 200 });

  const at = (height, rotations) => toHex(authorityAt({
    networkId: NETWORK, authority: AUTHORITY, recovery: RECOVERY,
    rotations, height, verify,
  }).authority);

  assert.equal(at(99, [one, two]), toHex(AUTHORITY));
  assert.equal(at(100, [one, two]), toHex(FIRST));
  assert.equal(at(200, [two, one]), toHex(SECOND));
  // The older rotation re-published after the newer one takes nothing back.
  assert.equal(at(200, [two, one, one]), toHex(SECOND));
});

test('a network with no published set pays nobody, and says which of the two it is', () => {
  const none = inForce({ sets: [], height: 1000 });
  assert.equal(none.ok, false);
  assert.match(none.why, /published no donation set/);
  assert.deepEqual(none.refused, []);

  const thrownAway = inForce({ sets: [setOf({ serial: 1n, networkId: b32(0x66) })], height: 1000 });
  assert.equal(thrownAway.ok, false);
  assert.match(thrownAway.why, /none of the 1 sets offered/);
  assert.equal(thrownAway.refused.length, 1);
});

test('the keys hashed into network_id are the keys these objects are checked against', () => {
  for (const network of ['regtest', 'testnet4']) {
    const keys = donationKeysFor(network);
    assert.equal(keys.authority.length, 32);
    assert.equal(keys.recovery.length, 32);
    assert.notEqual(toHex(keys.authority), toHex(keys.recovery));

    // The anchor exists for this network, which is what makes the pair the
    // one `computeNetworkId` hashed - genesis.test.js pins that equality.
    assert.equal(networkAnchor(network).length, 32);

    const set = setOf({ serial: 1n, validFrom: 1, networkId: networkAnchor(network) });
    set.signature = signWith(keys.authority, donationSetBodyId({
      networkId: networkAnchor(network), serial: 1n, validFrom: 1, recipients: RECIPIENTS,
    }));
    const answer = donationSetInForce({
      networkId: networkAnchor(network), ...keys, sets: [set], height: 10, verify,
    });
    assert.equal(answer.ok, true, answer.why);
  }
  assert.throws(() => donationKeysFor('mainnet'), /no donation authority has been generated/);
});

test('no money moves here: nothing in the donation code pays anybody', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['../src/authority.js', '../src/donation.js'];
  for (const f of files) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    const code = src.replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, '');
    for (const word of ['payInvoice', 'pay_invoice', 'lnbc', 'fetch(', 'WebSocket'])
      assert.equal(code.includes(word), false, `${f} reaches for ${word}`);
  }
});
