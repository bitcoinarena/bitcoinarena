// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r1 client-12 (kanban #1489; the reserve-key twin of #1896): fetchReserveKey counts node URLs, not nodes, and stops at the first key
// five URLs name. The nodes it asks are a lobby link's node= list (join: named.nodes) or a game's nodes (the shop: shop.game.nodes, from
// that same list - fetchGames counts a node by the key it says it has, unsigned). A stranger's link naming five extra paths of one server
// that answer /reserves fast with the stranger's own key makes the page pay the reserves' share (an item's 20 %, a pre-27 entry's 2 %) to
// that key, while all seven of the round's real signer nodes name the federation's reserve key.
// Safe behaviour: with the seven real seats naming K, the page never takes the stranger's key (it takes K, or refuses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReserveKey } from '../src/reserves-page.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';

const FED = new Uint8Array(32).fill(0x33);
const K = toHex(pointKey(0x02, 0xc3)), EVIL = toHex(pointKey(0x03, 0xe7));
const honest = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://tn4.bitcoin-arena.io/guardian-${i}`);
const evil = [1, 2, 3, 4, 5].map((i) => `https://evil.example/s${i}`);
const fetcher = async (url) => {
  const isEvil = url.startsWith('https://evil.example/');
  if (!isEvil) await new Promise((r) => setTimeout(r, 40));          // the real seats answer in 40 ms, the stranger's paths at once
  return new Response(JSON.stringify({ federations: [{ federationId: toHex(FED), key: isEvil ? EVIL : K }] }), { status: 200 });
};

test('wf1489-r1-client-12: five extra URLs of one stranger do not set the reserve key the seven real seats name', async () => {
  const got = await fetchReserveKey({ federationId: FED, nodes: [...honest, ...evil], fetcher });
  console.log('  FACTS reserve key', got.ok ? toHex(got.key).slice(0, 16) : got.why, got.ok ? `agreeing ${got.agreeing} of ${got.asked}` : '');
  assert.ok(!(got.ok && toHex(got.key) === EVIL), `the page took the stranger's reserve key ${EVIL.slice(0, 16)} - the reserves' share would be paid to it`);
});
