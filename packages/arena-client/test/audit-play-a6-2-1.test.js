// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT play r2-1: the final mark's catch-up (client.js #catchUpFinal) ends on ONE seat's unsigned word that the settlement is combined.
// The home seat answers GET /lock-settlement {"state":"ACCEPTED"} the moment the run finishes - minutes before any honest settlement
// could exist (the objection window has not even begun). The client stops re-offering its final mark, so the peer that was behind on the
// last inputs at finish (the normal case: the final mark goes only to peers whose feed answered every batch) never receipts it, the
// mark never reaches the committee's threshold, and the honest seats close on the previous carried mark - the run's last ticks dropped.
// SAFE: one seat's unsigned "combined" does not end the catch-up; the peer that takes the mark on its third offer receipts it.
// Same harness as final-catchup.test.js (2-of-2; seat A through send(), seat B through sendPeer(), /lock-settlement a stubbed fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client.js';
import { splitSigned, decodeCheckpoint, checkpointId } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = b32(0xa1), B = b32(0xb2);
const PEER = 'http://seat-b.example';
const receipt = (bytes, node) => joinSignedReceipt(encodeCheckpointReceipt({ checkpointId: checkpointId(decodeCheckpoint(splitSigned(bytes).body)), receivedAtMs: 1n, nodePubkey: node }), new Uint8Array(64));

test('one home seat\'s unsigned "ACCEPTED" at /lock-settlement, right at the run\'s end, does not stop the final mark reaching the peer that is behind', async () => {
  const c = new Client({ base: 'http://seat-a.example', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.nodes = [A, B];
  c.gameVerifySlots = 2;
  c.peers = [PEER];
  c.peerFeed(PEER).ticks = 1_000_000;
  c.where = { roundId: b32(0x31), entryId: b32(0x32) };
  let toB = 0;
  c.send = async (bytes) => receipt(bytes, A);                       // the home seat takes the mark (and keeps it to itself)
  // seat B is still taking the last inputs: it receipts the mark on its third offer, as an honest seat behind by a second does
  c.sendPeer = async (base, bytes) => (++toB < 3 ? 'error expected a tick after 994: that seat does not hold the inputs yet' : receipt(bytes, B));
  const real = globalThis.fetch;
  // THE HOME SEAT'S LIE: the settlement is "combined" already, unsigned, nothing else asked
  // (seat B, honest, holds no settlement yet: since kanban #3360 the client asks it too)
  globalThis.fetch = async (url) => (String(url).includes('/lock-settlement')
    ? new Response(String(url).startsWith(PEER) ? '{"state":"NONE"}' : '{"state":"ACCEPTED"}') : real(url));
  try {
    const sent = await c.mark('ab'.repeat(32), { roundId: b32(0x31), entryId: b32(0x32), tick: 1000, final: true });
    assert.equal(sent.live, false);
    const why = await Promise.race([c.catchingUp, new Promise((r) => setTimeout(() => r('timeout'), 6000))]);
    assert.equal(why, 'receipted', `the final mark's catch-up ended as '${why}' on the home seat's unsigned word, after ${c.finalRelinks} re-offer(s): seat B holds ${c.witnessed(sent.id) - 1} receipt of it`);
    assert.equal(c.witnessed(sent.id), 2);
  } finally { globalThis.fetch = real; c.close(); }
});
