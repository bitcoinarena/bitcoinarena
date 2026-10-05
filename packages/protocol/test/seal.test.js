// ONE SHARE, SEALED TO ONE SIGNER NODE - seal.js on its own (kanban #145; plan comment 173, accepted 2026-10-05).
// Until now seal.js ran only inside blwp-node's integration tests (65.7% of its lines from protocol's own suite). Here: a
// fixed vector re-derived independently (ECDH x, the BIP-340 style tagged hash, AES-256-GCM from node:crypto), the round
// trip, and every refusal by name. The curve is the one the daemons inject (blwp-node/src/curve.js): protocol holds none.
//
// Measured before this file, on seal.js as it stood: an ephemeral key that is not a curve point made openShare THROW the
// curve's "invalid x" instead of refusing; and signer node 65537 sealed to the same bytes as signer node 1 under the same
// keys - the node number was folded to 16 bits, so two shares got one AES-GCM key and nonce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createCipheriv } from 'node:crypto';
import { sealShare, openShare, sealedName, VSS_SEALED_BYTES } from '../src/seal.js';
import { FIELD } from '../src/shares.js';
import * as curve from '../../blwp-node/src/curve.js';

const NODE = new Uint8Array(32).fill(0x03);         // the signer node's secret
const NODE2 = new Uint8Array(32).fill(0x07);
const DEALER = new Uint8Array(32).fill(0x05);       // the dealer's ephemeral secret
const NODE_PUB = curve.pointX(NODE), NODE2_PUB = curve.pointX(NODE2), DEALER_PUB = curve.pointX(DEALER);
const VECTOR = 'd2568b90f1c113947e887be1252cfff0c337054ae8d955e84e5c75e9107bb5771ffe1b560bfe2d0c85fc87d5fb1208ca';
const hex = (b) => Buffer.from(b).toString('hex');
const seal = (o = {}) => sealShare({ value: 42n, signerNode: 1, signerNodePubkey: NODE_PUB, ephemeralSecret: DEALER, curve, ...o });
const open = (sealed, o = {}) => openShare({ sealed, signerNode: 1, secret: NODE, ephemeralPubkey: DEALER_PUB, curve, ...o });

// THE SEAL REBUILT WITHOUT seal.js: x(dealer * node), key = H_tag(VssShareKey)(x || node u16), nonce = first 12 bytes of
// H_tag(VssShareNonce)(same), AES-256-GCM over the 32-byte big-endian value, tag appended.
const sha = (b) => createHash('sha256').update(b).digest();
const tagged = (tag, msg) => { const t = sha(Buffer.from(tag, 'utf8')); return sha(Buffer.concat([t, t, msg])); };
function independentSeal(value, signerNode, nodePub, dealerSecret) {
  const x = Buffer.from(curve.ecdhShared(dealerSecret, nodePub));
  const ctx = Buffer.concat([x, Buffer.from([(signerNode >> 8) & 0xff, signerNode & 0xff])]);
  const key = tagged('BLWP/v1/VssShareKey', ctx), nonce = tagged('BLWP/v1/VssShareNonce', ctx).subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(Buffer.from(value.toString(16).padStart(64, '0'), 'hex')), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

// THE FIRST CHECK (plan 173): a key that is not a point is refused by name, never thrown.
test('openShare refuses an ephemeral key that is not a curve point by name; it does not throw', async () => {
  const sealed = await seal();
  const got = await open(sealed, { ephemeralPubkey: new Uint8Array(32).fill(0xff) });
  assert.equal(got.ok, false);
  assert.match(got.why, /key/);
  assert.match(got.why, /ffffffffffffffff/, 'the refusal does not name the key');
});

test('the fixed vector: node 0x03.., dealer 0x05.., value 42, signer node 1 seals to these 48 bytes, every time', async () => {
  const a = await seal(), b = await seal();
  assert.equal(a.length, VSS_SEALED_BYTES);
  assert.equal(hex(a), VECTOR);
  assert.equal(hex(b), VECTOR, 'a second seal of the same inputs differs');
  assert.equal(hex(independentSeal(42n, 1, NODE_PUB, DEALER)), VECTOR, 'seal.js is not ECDH + tagged hash + AES-256-GCM');
  assert.equal(sealedName(a), VECTOR.slice(0, 16));
});

test('the round trip returns { signerNode, value }, for 0, 42 and the largest scalar', async () => {
  for (const value of [0n, 42n, FIELD - 1n]) {
    const got = await open(await seal({ value }));
    assert.deepEqual(got, { ok: true, share: { signerNode: 1, value } });
  }
  const seven = await open(await seal({ signerNode: 7, value: 9n }), { signerNode: 7 });
  assert.deepEqual(seven, { ok: true, share: { signerNode: 7, value: 9n } });
});

test('refused by name: the wrong node secret, the wrong signer node, node 2\'s envelope opened as node 1', async () => {
  const sealed = await seal();
  const wrongSecret = await open(sealed, { secret: NODE2 });
  assert.deepEqual(wrongSecret, { ok: false, why: 'signer node 1\'s share does not open under this key: it was sealed to somebody else' });
  const wrongNode = await open(sealed, { signerNode: 2 });
  assert.deepEqual(wrongNode, { ok: false, why: 'signer node 2\'s share does not open under this key: it was sealed to somebody else' });
  const two = await seal({ signerNode: 2, signerNodePubkey: NODE2_PUB });
  assert.equal((await open(two, { secret: NODE2, signerNode: 2 })).ok, true);
  const asOne = await open(two, { secret: NODE });
  assert.equal(asOne.ok, false);
  assert.match(asOne.why, /does not open under this key/);
});

test('refused by name: one flipped ciphertext byte, one flipped tag byte', async () => {
  const sealed = await seal();
  for (const at of [0, 31, 32, 47]) {          // 0..31 the ciphertext, 32..47 the GCM tag
    const bad = Uint8Array.from(sealed); bad[at] ^= 0x01;
    const got = await open(bad);
    assert.equal(got.ok, false, `byte ${at} flipped still opened`);
    assert.match(got.why, /does not open under this key/);
  }
});

test('refused by name: a sealed share of 47 bytes, 49 bytes, or nothing', async () => {
  const sealed = await seal();
  assert.deepEqual(await open(sealed.subarray(0, 47)), { ok: false, why: 'a sealed share is 48 bytes and that is 47' });
  assert.deepEqual(await open(Uint8Array.from([...sealed, 0])), { ok: false, why: 'a sealed share is 48 bytes and that is 49' });
  assert.deepEqual(await open(undefined), { ok: false, why: 'a sealed share is 48 bytes and that is nothing' });
  assert.deepEqual(await open(new Uint8Array(0)), { ok: false, why: 'a sealed share is 48 bytes and that is 0' });
});

test('refused by name: a value equal to the field order or below 0, and a 31-byte node key', async () => {
  for (const value of [FIELD, -1n, 42])
    await assert.rejects(seal({ value }), { message: 'that share is not a scalar of the group' });
  await assert.rejects(seal({ signerNodePubkey: NODE_PUB.subarray(0, 31) }),
    { message: 'a share is sealed to a signer node\'s 32-byte key, and that is not one' });
});

test('refused by name: signer nodes 0, 65536, 65537 and -1, sealing and opening', async () => {
  const sealed = await seal();
  for (const signerNode of [0, 65536, 65537, -1, 1.5]) {
    await assert.rejects(seal({ signerNode }), /signer node .* is not one of 1\.\.65535/, `sealed for signer node ${signerNode}`);
    const got = await open(sealed, { signerNode });
    assert.equal(got.ok, false, `opened as signer node ${signerNode}`);
    assert.match(got.why, /is not one of 1\.\.65535/);
  }
  assert.equal((await seal({ signerNode: 65535 })).length, 48, 'the top of the range is refused');
});

// THE NONCE-REUSE HOLE: under one dealer key and one node key, no two signer nodes share an AES-GCM key and nonce - so no two
// envelopes of different signer nodes are the same bytes for the same value.
test('different signer nodes never share a key and nonce under the same dealer key (65537 is not 1)', async () => {
  const one = hex(await seal({ value: 7n }));
  const seen = new Set([one]);
  for (const signerNode of [2, 3, 7, 256, 257, 65535]) {
    const s = hex(await seal({ value: 7n, signerNode }));
    assert.ok(!seen.has(s), `signer node ${signerNode} sealed to bytes another signer node already has`);
    seen.add(s);
  }
  let folded = null;
  try { folded = hex(await seal({ value: 7n, signerNode: 65537 })); } catch { /* refused: what is wanted */ }
  assert.notEqual(folded, one, 'signer node 65537 sealed to signer node 1\'s key and nonce');
});
