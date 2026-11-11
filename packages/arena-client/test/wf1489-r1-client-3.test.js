// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r1 client-3: ONE SEAT OF SEVEN CANNOT REFUSE EVERY PAID JOIN BY ITS DONATION-SET ANSWER.
// fetchDonationSet takes the round's donation set only when EVERY answering seat serves it, byte for byte: one seat answering a 4xx
// ("its own word") or other bytes fails the read, and the page refuses every join of a round that pays the reserves
// (index.html: "the round's nodes could not be read just now"), or every join outright when the 4xx text says "donation set in force".
// The set is signed by the network's donation authority and named by the round's donationSetId, so one dissenting seat adds nothing
// a check here does not already decide. Safe: six seats serving the signed set the round names outvote one that does not.
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
const OTHER = signed({ networkId: NET, serial: 1n, validFrom: 11, recipients: rec(2) });
const pins = { first: { [toHex(NET)]: 1n }, alone: {} };
const NODES = Array.from({ length: 7 }, (_, i) => `http://seat${i}`);
const round = { networkId: NET, donationSetId: donationSetId(SET.recipients), censusHeight: 1000, gameId: NEXTBLOCK_GAME_ID, id: new Uint8Array(32).fill(9) };
const bytesOf = (s) => new Uint8Array([...encodeDonationSetBody(s), ...s.signature]);
const fetcherWith = (bad) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: [] }), { status: 200 });
  if (u.pathname === '/game-donation-set') return new Response(encodeDonationSet(NEXTBLOCK.donationSet), { status: 200 });
  if (u.host === 'seat6') return bad();
  return new Response(bytesOf(SET), { status: 200 });
};

test('one seat answering 404 does not take the round\'s signed donation set away from the six that serve it', async () => {
  const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(() => new Response('this seat holds no donation set in force', { status: 404 })) });
  assert.equal(ds.ok, true, `one seat of seven refused the round's donation set for every player: ${ds.why}`);
});

test('one seat serving another signed set does not take the round\'s donation set away from the six that serve it', async () => {
  const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(() => new Response(bytesOf(OTHER), { status: 200 })) });
  assert.equal(ds.ok, true, `one seat of seven refused the round's donation set for every player: ${ds.why}`);
});

test('control: seven seats serving the set - it stands', async () => {
  const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(() => new Response(bytesOf(SET), { status: 200 })) });
  assert.equal(ds.ok, true, ds.why);
});
