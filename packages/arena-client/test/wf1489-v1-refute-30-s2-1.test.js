// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute-30 skeptic 2 (kanban #1524, #625): ONE SEAT'S DISSENT STILL HOLDS EVERY JOIN FOR THE SLOWEST SEAT.
// #1524 made a dissenting seat (a 4xx, or other bytes) a `dissent` instead of a refusal, but firstMajority still treats it as a
// refusal "said as before": any non-late answer without bytes, or served bytes that differ, stops the QUORUM_GRACE_MS timer, so the
// read waits for every seat up to DONATION_ANSWER_MS (6 s). One seat answering 404 at once, beside one naturally stalled seat (the
// #625 case), makes every paid join wait 6 s - while its silence (5xx) costs 250 ms. A dissenting seat is counted more harshly than
// a late one.
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
  if (u.host === 'seat5') return new Promise(() => {});   // a seat that stalls (kanban #625), honest but slow
  if (u.host === 'seat6') return bad();                    // the one dissenting seat
  // the honest seats answer over a real network (50 ms); the dissenting seat answers at once
  return new Promise((r) => setTimeout(() => r(new Response(bytesOf(SET), { status: 200 })), 50));
};
const timed = async (bad) => { const t0 = Date.now(); const ds = await fetchDonationSet({ round, nodes: NODES, verifyEd25519, keys, plainPins: pins, fetcher: fetcherWith(bad) }); return { ds, ms: Date.now() - t0 }; };

test('control: one stalled seat and one silent seat (502) - the five serving seats answer in the grace', async () => {
  const { ds, ms } = await timed(() => new Response('bad gateway', { status: 502 }));
  assert.equal(ds.ok, true, ds.why);
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test('one seat answering 404 at once does not hold the join for the stalled seat', async () => {
  const { ds, ms } = await timed(() => new Response('this seat holds no donation set in force', { status: 404 }));
  assert.equal(ds.ok, true, ds.why);
  assert.ok(ms < 2000, `one seat's 404 held the donation read ${ms} ms (its 502 costs the grace only): every paid join waits for the slowest seat`);
});

test('one seat serving another signed set at once does not hold the join for the stalled seat', async () => {
  const { ds, ms } = await timed(() => new Response(bytesOf(OTHER), { status: 200 }));
  assert.equal(ds.ok, true, ds.why);
  assert.ok(ms < 2000, `one seat's other set held the donation read ${ms} ms: every paid join waits for the slowest seat`);
});
