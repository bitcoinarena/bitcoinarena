// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY SIGNS, seat to seat (spec 5A.3B, kanban #972): one nonce pair per node for its several shares, a nonce used once, and what a filer gets is a BIP-340 signature of the key or a reason. tools/slash-flow-regtest.mjs is this through real seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { createCensusSigner, gatherCensusSignature } from '../src/census-sign.js';
import { censusKeyWork } from '../src/census-key-work.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { lagrangeOf } from '../../arena-protocol/src/census-dkg.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const toScalar = (b) => BigInt(`0x${toHex(b)}`) % N;
const secret = (n) => taggedHash('ARENA/test/CensusSign', Uint8Array.of(n));
// a polynomial of degree 3 under an even key: threshold 4, x 1..6
function dealt() {
  let a0 = toScalar(secret(1));
  if (secp256k1.getPublicKey(secret(1), true)[0] === 3) a0 = N - a0;
  const co = [a0, toScalar(secret(2)), toScalar(secret(3)), toScalar(secret(4))];
  const share = (x) => co.reduce((sum, c, i) => (sum + c * BigInt(x) ** BigInt(i)) % N, 0n);
  return { publicKey: schnorr.getPublicKey(secret(1)), share };
}
const { publicKey, share } = dealt();
const digest = taggedHash('ARENA/test/CensusSign', Uint8Array.of(99));
const holder = (n, xs, over = {}) => {
  const key = schnorr.getPublicKey(secret(10 + n));
  const signer = createCensusSigner({ key, work: censusKeyWork, held: () => ({ shares: new Map(xs.map((x) => [x, share(x)])) }), check: async () => ({ ok: true, digest, publicKey }), ...over });
  return { url: `http://h${n}`, signer };
};
const wire = (holders) => async (url, init) => {
  const h = holders.find((x) => url.startsWith(x.url));
  const body = JSON.parse(init.body);
  const answer = url.endsWith('/commit') ? await h.signer.takeCommit(body) : await h.signer.takeShare(body);
  return { json: async () => answer };
};

test('the coefficients are the polynomial\'s: a node of two shares signs with one nonce pair', async () => {
  const hs = [holder(1, [1, 2]), holder(2, [3]), holder(3, [4])];
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: wire(hs) });
  assert.ok(got.ok, got.why);
  assert.ok(schnorr.verify(got.signature, digest, publicKey), 'a BIP-340 signature of the key');
  assert.equal(got.signers.length, 3);
  assert.equal(got.shares, 4);
  const l = lagrangeOf([1, 2, 3, 4], [1, 2, 3, 4]);
  assert.equal(toHex(schnorr.getPublicKey(Uint8Array.from(Buffer.from(([1, 2, 3, 4].reduce((a, x) => (a + l.get(x) * share(x)) % N, 0n)).toString(16).padStart(64, '0'), 'hex')))), toHex(publicKey));
});

test('more shares than the threshold sign too, and this node\'s own signer takes part with no fetch', async () => {
  const own = holder(1, [1, 2, 5]), hs = [holder(2, [3, 4, 6])];
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), own: own.signer, fetchFn: wire(hs) });
  assert.ok(got.ok, got.why);
  assert.equal(got.shares, 6);
});

test('a nonce is used once: a session ends at its share, whatever comes of it', async () => {
  const h = holder(1, [1]);
  const c = await h.signer.takeCommit({});
  const list = [{ id: 1, node: c.node, xs: c.xs, hiding: c.hiding, binding: c.binding }];
  assert.equal((await h.signer.takeShare({ session: c.session, signers: [{ ...list[0], hiding: c.binding }] })).why, 'that list does not carry this node\'s commitment');
  assert.equal(h.signer.sessions(), 0);
  assert.equal((await h.signer.takeShare({ session: c.session, signers: list })).why, 'no such session here', 'the same session again, with the right list');
});

test('a holder that refuses is named; short of the threshold nothing is asked of the others', async () => {
  let asked = 0;
  const refuses = holder(2, [3, 4], { check: async () => ({ ok: false, why: 'it does not replay' }) });
  const hs = [holder(1, [1, 2]), refuses];
  const wired = wire(hs);
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: async (u, i) => { if (u.endsWith('/share')) asked += 1; return wired(u, i); } });
  assert.deepEqual([got.ok, got.why, asked], [false, '2 of the 4 shares of that key answered', 0]);
  assert.deepEqual(got.refused, [{ who: 'http://h2', why: 'it does not replay' }]);
});

test('a holder with no shares of the key commits nothing; a bad share never leaves as a signature', async () => {
  assert.match((await holder(1, [1], { held: () => null }).signer.takeCommit({})).why, /holds no shares/);
  const hs = [holder(1, [1, 2]), holder(2, [3, 4])];
  const wired = wire(hs);
  const lies = async (u, i) => { const r = await wired(u, i); if (!u.endsWith('/share') || !u.includes('h2')) return r; const a = await r.json(); return { json: async () => ({ ...a, z: (BigInt(`0x${a.z}`) + 1n).toString(16).padStart(64, '0') }) }; };
  const got = await gatherCensusSignature({ request: {}, digest, publicKey, threshold: 4, urls: hs.map((h) => h.url), fetchFn: lies });
  assert.equal(got.ok, false);
  assert.match(got.why, /do not add up/);
});
