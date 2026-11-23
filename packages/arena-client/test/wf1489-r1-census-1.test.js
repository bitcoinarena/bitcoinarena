// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1 census-2 (P4/P8): ONE seat of the round's 7-14 decides that no client may enter it. clientCommittee asks every
// seat for GET /seating and GET /committee; a seat that answers 64 bytes of junk as its "certificate" (it does not verify against
// anybody's key) or an unsigned /committee list naming other keys goes into `refused` / agrees:false, and settlementSignerNodesFrom
// then refuses the round outright - although the client holds a certificate it CHECKED itself (every seated node's signature),
// from the other seats. Neither answer is signed, so the lying seat proves nothing and risks nothing, and the page adds the round
// to ARENA_CLOSED_ROUNDS. Safe behaviour: an answer that carries no valid signature is named, never decides the round, while a
// checked certificate stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementSignerNodesFrom } from '../src/committee.js';

const k = (n) => new Uint8Array(32).fill(n);
const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(k);
const honestSeats = Array.from({ length: 6 }, (_, i) => ({ node: `https://g${i + 1}`, agrees: true, why: null }));
const derived = (over = {}) => ({ ok: true, committees: { game: SEVEN, settlement: SEVEN }, beacon: { height: 156663 },
  seating: { game: { seated: SEVEN, from: 'https://g1', refused: [] }, settlement: { seated: SEVEN, from: 'https://g1', refused: [] } },
  seats: honestSeats, censusRefused: [], ...over });

test('wf1489 r1 census-2: one seat handing a junk certificate does not refuse a round whose checked certificate stands', () => {
  const seating = { ...derived().seating, settlement: { seated: SEVEN, from: 'https://g1', refused: ["https://g7: seated node 0101010101010101's signature on that seating does not verify"] } };
  let got = null, err = null;
  try { got = settlementSignerNodesFrom(derived({ seating })); } catch (e) { err = e; }
  assert.equal(err, null, `one seat's unsigned junk refused the round for every client: ${err && err.message}`);
  assert.equal(got.signerNodes.length, 7);
});

test('wf1489 r1 census-2: one seat\'s unsigned /committee list does not refuse a round whose checked certificate stands', () => {
  const liar = { node: 'https://g7', agrees: false, why: 'names another settlement committee (66666666) than the one this client derived (01010101)' };
  let got = null, err = null;
  try { got = settlementSignerNodesFrom(derived({ seats: [...honestSeats, liar] })); } catch (e) { err = e; }
  assert.equal(err, null, `one seat's unsigned /committee answer refused the round for every client: ${err && err.message}`);
  assert.equal(got.signerNodes.length, 7);
});
