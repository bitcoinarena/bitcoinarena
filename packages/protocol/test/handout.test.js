// ONE STAKE PREIMAGE DEALT TO A COMMITTEE - handout.js on its own (kanban #145; plan comment 175, Go 2026-10-05).
// Until now handout.js ran only inside blwp-node's integration tests (41.7% of its lines from protocol's own suite). Here:
// a fixed deal pinned by id, the encoding and what the id binds, every refusal of acceptHandout and openMyShare by name,
// and the round trip to the preimage through any five shares. The curve is the daemons' (blwp-node/src/curve.js).
//
// Measured before this file, on handout.js as it stood: dealHandout with an ephemeral public key that is not the point of
// the ephemeral secret returned ok, acceptHandout took it, and no signer node could open its share - a stake whose preimage
// could never be released; and openMyShare on a handout with no shares list threw "Cannot read properties of undefined".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dealHandout, acceptHandout, openMyShare, encodeHandout, decodeHandout, handoutId, NO_SHARES, COMMITMENT_BYTES } from '../src/handout.js';
import { reconstruct } from '../src/shares.js';
import * as curve from '../../blwp-node/src/curve.js';

const KEYS = Array.from({ length: 7 }, (_, i) => new Uint8Array(32).fill(i + 11));   // signer nodes 1..7: 0x0b.. to 0x11..
const PUBS = KEYS.map((k) => curve.pointX(k));
const EPH = new Uint8Array(32).fill(0x05);
const PREIMAGE = new Uint8Array(32).fill(0x09);
const ROUND = new Uint8Array(32).fill(0x21), PLAYER = new Uint8Array(32).fill(0x31);
const ID = 'a6dde894b5878803524f0c656ec5f7e56a6288bf9f22c6d6e4f78c4a30d09ac9';
const hex = (b) => Buffer.from(b).toString('hex');
const deal = (o = {}) => dealHandout({ preimage: PREIMAGE, signerNodes: PUBS, roundId: ROUND, playerPubkey: PLAYER,
  ephemeralSecret: EPH, ephemeralPubkey: curve.pointX(EPH), needed: 5, coefficients: [11n, 22n, 33n, 44n], curve, ...o });
const opener = (i) => ({ pubkey: PUBS[i], secret: KEYS[i], curve });

// THE FIRST CHECK (plan 175): a dealer key pair that does not match is refused when dealt, never handed out.
test('dealHandout refuses an ephemeral public key that is not the point of the ephemeral secret, naming it', async () => {
  const wrong = curve.pointX(new Uint8Array(32).fill(0x06));
  const got = await deal({ ephemeralPubkey: wrong });
  assert.equal(got.ok, false, 'a handout no signer node can open was dealt');
  assert.match(got.why, new RegExp(hex(wrong).slice(0, 16)), 'the refusal does not name the key');
  assert.equal(got.handout, undefined);
});

test('the fixed deal: its handoutId is pinned and equal on a second deal, and is the tagged hash of its bytes', async () => {
  const a = await deal(), b = await deal();
  assert.equal(a.ok, true);
  assert.equal(hex(a.id), ID);
  assert.equal(hex(b.id), ID, 'a second deal of the same inputs has another id');
  const t = createHash('sha256').update('BLWP/v1/VssHandout').digest();
  assert.equal(createHash('sha256').update(Buffer.concat([t, t, encodeHandout(a.handout)])).digest('hex'), ID);
  assert.equal(a.handout.needed, 5);
  assert.equal(a.handout.commitments.length, 5);
  assert.ok(a.handout.commitments.every((c) => c.length === COMMITMENT_BYTES));
  assert.deepEqual(a.handout.shares.map((s) => s.signerNode), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(a.handout.shares.map((s) => hex(s.signerNodePubkey)), PUBS.map(hex));
  assert.equal(hex(NO_SHARES), '00'.repeat(32));
});

test('encode/decode keeps the id; one commitment byte, one sealed byte, the threshold or the round changes it', async () => {
  const { handout } = await deal();
  const back = decodeHandout(encodeHandout(handout));
  assert.equal(hex(handoutId(back)), ID);
  assert.deepEqual(back, handout);
  const flip = (b, at) => { const c = Uint8Array.from(b); c[at] ^= 1; return c; };
  const changed = [
    { ...handout, commitments: handout.commitments.map((c, i) => (i === 2 ? flip(c, 10) : c)) },
    { ...handout, shares: handout.shares.map((s, i) => (i === 3 ? { ...s, sealed: flip(s.sealed, 5) } : s)) },
    { ...handout, needed: 4 },
    { ...handout, roundId: flip(handout.roundId, 0) },
  ];
  for (const h of changed) assert.notEqual(hex(handoutId(h)), ID);
  const bytes = encodeHandout(handout);
  assert.throws(() => decodeHandout(Uint8Array.from([...bytes, 0])), /trailing bytes/);
  assert.throws(() => decodeHandout(flip(bytes, 0)), /not a VssHandout/);
  assert.throws(() => decodeHandout(flip(bytes, 2)), /protocol version/);
  assert.throws(() => encodeHandout({ ...handout, shares: [...handout.shares].reverse() }), 'shuffled shares were encoded');
});

test('acceptHandout takes the fixed deal and refuses each malformed one by name', async () => {
  const { handout: h } = await deal();
  assert.deepEqual(acceptHandout(h), { ok: true, why: '7 sealed shares, threshold 5' });
  const no = (x, why) => assert.deepEqual(acceptHandout(x), { ok: false, why });
  no(undefined, 'a handout of no shares is not a handout');
  no({ ...h, shares: [] }, 'a handout of no shares is not a handout');
  no({ ...h, commitments: [] }, 'a handout that publishes no polynomial cannot be checked');
  no({ ...h, needed: 4 }, 'a threshold of 4 is a polynomial of 4 coefficients, and this handout publishes 5');
  no({ ...h, shares: h.shares.slice(0, 4) }, '4 shares cannot carry a threshold of 5');
  no({ ...h, shares: h.shares.map((s, i) => (i === 0 ? { ...s, signerNode: 0 } : s)) }, 'a share of signer node zero is a share of the secret itself');
  no({ ...h, shares: h.shares.map((s, i) => (i === 1 ? { ...s, signerNode: 1 } : s)) }, 'two shares for signer node 1 are one share');
  no({ ...h, shares: h.shares.map((s, i) => (i === 2 ? { ...s, signerNodePubkey: s.signerNodePubkey.subarray(0, 31) } : s)) }, 'signer node 3 is not addressed to a key');
  no({ ...h, shares: h.shares.map((s, i) => (i === 3 ? { ...s, sealed: s.sealed.subarray(0, 47) } : s)) }, 'signer node 4\'s envelope is not a sealed share');
  no({ ...h, shares: h.shares.map((s, i) => (i === 4 ? { ...s, signerNodePubkey: PUBS[0] } : s)) }, 'two signer nodes of that handout are one key, so one of them cannot open its share');
});

test('each of the 7 signer nodes opens its own share, and any 5 of them rebuild the preimage', async () => {
  const { handout } = await deal();
  const shares = [];
  for (let i = 0; i < 7; i++) {
    const got = await openMyShare(handout, opener(i));
    assert.equal(got.ok, true, `signer node ${i + 1}: ${got.why}`);
    assert.equal(got.signerNode, i + 1);
    shares.push(got.share);
  }
  const stakeCommitment = createHash('sha256').update(PREIMAGE).digest();
  for (const five of [[0, 1, 2, 3, 4], [2, 3, 4, 5, 6], [0, 2, 4, 5, 6], [6, 5, 1, 3, 0]])
    assert.equal(hex(reconstruct(five.map((i) => shares[i]), { stakeCommitment })), hex(PREIMAGE));
  assert.throws(() => reconstruct(shares.slice(0, 4)), /4 shares cannot reconstruct anything/);
});

test('openMyShare refuses by name: a node not dealt to, a 31-byte key, a wrong secret, a share moved, no shares list', async () => {
  const { handout } = await deal();
  const stranger = new Uint8Array(32).fill(0x44);
  assert.deepEqual(await openMyShare(handout, { pubkey: curve.pointX(stranger), secret: stranger, curve }),
    { ok: false, why: 'this node is not one of the signer nodes that handout was dealt to' });
  assert.deepEqual(await openMyShare(handout, { ...opener(0), pubkey: PUBS[0].subarray(0, 31) }),
    { ok: false, why: 'a signer node opens a share with its own 32-byte key, and that is not one' });
  assert.deepEqual(await openMyShare(handout, { ...opener(0), secret: KEYS[1] }),
    { ok: false, why: 'signer node 1\'s share does not open under this key: it was sealed to somebody else' });
  // signer node 2's envelope moved into signer node 1's slot (node 1's key, node 1's number)
  const moved = { ...handout, shares: handout.shares.map((s, i) => (i === 0 ? { ...s, sealed: handout.shares[1].sealed } : s)) };
  const got = await openMyShare(moved, opener(0));
  assert.equal(got.ok, false);
  assert.match(got.why, /does not open under this key/);
  // a share that opens but lies off the published polynomial
  const offPoly = { ...handout, commitments: handout.commitments.map((c, i) => (i === 1 ? handout.commitments[2] : c)) };
  assert.deepEqual(await openMyShare(offPoly, opener(0)),
    { ok: false, why: 'signer node 1 was handed a share that is not on the polynomial the dealer published' });
  // no shares list at all: refused by name, not a TypeError
  const none = await openMyShare({ ...handout, shares: undefined }, opener(0));
  assert.equal(none.ok, false);
  assert.match(none.why, /no shares/);
  assert.deepEqual(await openMyShare(undefined, opener(0)), none);
});

test('dealHandout refuses an empty committee', async () => {
  assert.deepEqual(await deal({ signerNodes: [] }), { ok: false, why: 'a handout is dealt to a committee, and that is an empty one' });
  assert.deepEqual(await deal({ signerNodes: undefined }), { ok: false, why: 'a handout is dealt to a committee, and that is an empty one' });
});
