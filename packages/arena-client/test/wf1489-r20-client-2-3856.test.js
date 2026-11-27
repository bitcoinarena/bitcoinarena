// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r20 client-2 (bypass of #2652): fetchReserveKey still counts one vote per URL. The #2652 fix only refuses when TWO keys both
// reach `needed` (5) and stops the early finish; it never groups URLs into seats (seat-identity.js seatsOf, used by handToSeats/ownedItems
// since #3574) nor checks a key against a census. A lobby/join link (node= list, the link author's) that names two of the round's real
// seats plus five paths of ONE stranger box: the box's key gets 5 votes, the real reserve key 2 - no rival reaches 5, and the page pays the
// reserves' share (an item's reserves part in buyItem, a pre-27 entry's reserve output in index.html) to the stranger's key.
// Safe: five paths of one host are one vote; a key named only by one box is never the reserve key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReserveKey } from '../src/reserves-page.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';

const FED = new Uint8Array(32).fill(0x33);
const K = toHex(pointKey(0x02, 0xc3)), EVIL = toHex(pointKey(0x03, 0xe7));
const honest = [1, 2].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`);
const evil = [1, 2, 3, 4, 5].map((i) => `https://evil.example/s${i}`);
const fetcher = async (url) => {
  const isEvil = url.startsWith('https://evil.example/');
  return new Response(JSON.stringify({ federations: [{ federationId: toHex(FED), key: isEvil ? EVIL : K }] }), { status: 200 });
};

test('wf1489-r20-client-2: five paths of one stranger box are one vote, never the reserve key', async () => {
  const got = await fetchReserveKey({ federationId: FED, nodes: [...honest, ...evil], fetcher });
  console.log('  FACTS reserve key', got.ok ? toHex(got.key).slice(0, 16) : got.why, got.ok ? `agreeing ${got.agreeing} of ${got.asked}` : '');
  assert.ok(!(got.ok && toHex(got.key) === EVIL), `the page took the stranger's reserve key ${EVIL.slice(0, 16)} on 5 paths of one host - the reserves' share is paid to it`);
});

// kanban #3856, the honest side: the live seats sit behind one host (tn4.bitcoin-arena.io/guardian-N); each proves its own census key, so
// they are seven seats and still make the reserve key - while the five paths of the stranger's box, which prove nothing, stay one vote.
test('#3856: seven seats behind one host that prove census keys still make the reserve key; the box beside them is one vote', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { identityProofDigest, forgetProofs } = await import('../src/seat-identity.js');
  const { fromHex } = await import('../../arena-protocol/src/hash.js');
  forgetProofs();
  const seven = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`);
  const secrets = seven.map((_, i) => new Uint8Array(32).fill(0x51 + i));
  const census = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
  const f = async (url) => {
    if (url.includes('/identity?nonce=')) {
      const i = seven.findIndex((s) => url.startsWith(s + '/'));
      if (i < 0) return new Response('no', { status: 404 });
      const nonce = fromHex(new URL(url).searchParams.get('nonce'));
      return Response.json({ node: census[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
    }
    return fetcher(url);
  };
  const got = await fetchReserveKey({ federationId: FED, nodes: [...seven, ...evil], fetcher: f, keys: census, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
  console.log('  FACTS honest', got.ok ? `${toHex(got.key).slice(0, 16)} agreeing ${got.agreeing} of ${got.asked}` : got.why);
  assert.equal(got.ok, true, got.why); assert.equal(toHex(got.key), K); assert.equal(got.agreeing, 7); assert.equal(got.asked, 8);
});
