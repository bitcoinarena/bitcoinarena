// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute-30 (kanban #1524) variant: an even committee. The all-agree path takes a set served by HALF the round's nodes
// (answers*2 < nodes refuses), the #1524 dissent path needs MORE than half. So on 4 nodes with one seat down (5xx = late), the two
// seats serving the signed set the round names are enough while the fourth seat is silent - and that fourth seat refuses every
// paid join by answering 404 instead. One seat's own word still takes the round's set away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fetchDonationSet } from '../src/donation-pay.js';
import { encodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { donationSetId, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID, NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';

const authSk = ed25519.utils.randomSecretKey();
const keys = { authority: ed25519.getPublicKey(authSk), recovery: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
const verifyEd25519 = (s, m, k) => ed25519.verify(s, m, k);
const NET = new Uint8Array(32).fill(5);
const rec = (n) => [{ recipientPk: new Uint8Array(33).fill(2).map((x, i) => (i === 0 ? 2 : (n * 7 + i) % 251)), shareBps: 10000, label: 'dev ' + n }];
const signed = (body) => { const s = { ...body }; s.signature = ed25519.sign(donationSetBodyId(s), authSk); return s; };
const SET = signed({ networkId: NET, serial: 1n, validFrom: 10, recipients: rec(1) });
const pins = { first: { [toHex(NET)]: 1n }, alone: {} };
const NODES = Array.from({ length: 4 }, (_, i) => `http://seat${i}`);
const round = { networkId: NET, donationSetId: donationSetId(SET.recipients), censusHeight: 1000, gameId: NEXTBLOCK_GAME_ID, id: new Uint8Array(32).fill(9) };
const bytesOf = (s) => new Uint8Array([...encodeDonationSetBody(s), ...s.signature]);
const fetcherWith = (bad) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
  if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
  if (u.host === 'seat2') return new Response('bad gateway', { status: 502 });   // a seat that is down
  if (u.host === 'seat3') return bad();
  return new Response(bytesOf(SET), { status: 200 });
};

test('control: 4 nodes, one down (502), one silent (502) - two seats serving the signed set are enough', async () => {
  const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(() => new Response('x', { status: 502 })) });
  assert.equal(ds.ok, true, ds.why);
});

test('4 nodes, one down (502): the fourth seat answering 404 does not take the set the other two serve away', async () => {
  const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(() => new Response('this seat holds no donation set in force', { status: 404 })) });
  assert.equal(ds.ok, true, `one seat's 404 refused the set the silent-seat path takes: ${ds.why}`);
});
