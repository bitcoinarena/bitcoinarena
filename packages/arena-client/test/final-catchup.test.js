// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FINAL MARK, RE-OFFERED UNTIL EVERY SIGNER NODE HOLDS IT - client.js #catchUpFinal (kanban #147, surface 4 part 2,
// plan comment 210, Go 2026-10-05), driven through the public mark(..., { final: true }) only. A 2-of-2 committee: seat A's
// answers come through send(), seat B's through sendPeer(), both scripted on the instance (the public doors the client
// talks through); /lock-settlement, the "combined" question, is a stubbed fetch. No socket and no seat is reached.
// Re-offers are once a second (FINAL_RELINK_EVERY_MS), so each case takes a few seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '../src/client.js';
import { splitSigned, decodeCheckpoint, checkpointId } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const A = b32(0xa1), B = b32(0xb2);
const PEER = 'http://seat-b.example';
const idOf = (bytes) => hex(checkpointId(decodeCheckpoint(splitSigned(bytes).body)));
const receipt = (bytes, node) => joinSignedReceipt(encodeCheckpointReceipt({ checkpointId: checkpointId(decodeCheckpoint(splitSigned(bytes).body)), receivedAtMs: 1n, nodePubkey: node }), new Uint8Array(64));

// `seatB(n, bytes)` answers seat B's n-th offer: a receipt, a refusal string, or a throw
function client(seatB, settlement = () => new Response('', { status: 404 })) {
  const c = new Client({ base: 'http://seat-a.example', core: {}, sign: async () => new Uint8Array(64), verify: () => true });
  c.nodes = [A, B];
  c.gameVerifySlots = 2;
  c.peers = [PEER];
  c.peerFeed(PEER).ticks = 1_000_000;            // seat B holds the run's inputs: offered at once, no feed first
  c.where = { roundId: b32(0x31), entryId: b32(0x32) };
  const offered = [];
  let toB = 0;
  c.send = async (bytes) => { offered.push(idOf(bytes)); return receipt(bytes, A); };
  c.sendPeer = async (base, bytes) => { offered.push(idOf(bytes)); return seatB(++toB, bytes); };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/lock-settlement') ? settlement() : real(url));
  return { c, offered, done: () => { globalThis.fetch = real; c.close(); } };
}
const final = (c) => c.mark('ab'.repeat(32), { roundId: b32(0x31), entryId: b32(0x32), tick: 1000, final: true });

test('the final mark is re-offered until the missing seat receipts it: "receipted", every offer the same mark', async () => {
  const { c, offered, done } = client((n, bytes) => (n < 3 ? 'refused: that seat does not hold the inputs yet' : receipt(bytes, B)));
  try {
    const sent = await final(c);
    assert.equal(sent.live, false, 'one of two receipts made the final mark live');
    assert.equal(await c.catchingUp, 'receipted');
    assert.equal(c.finalCatchUp, 'receipted');
    assert.equal(c.finalRelinks, 2, `${c.finalRelinks} re-offers for a seat that took it on its third`);
    assert.equal(c.witnessed(sent.id), 2);
    assert.equal(new Set(offered).size, 1, 'a second mark was offered');
    assert.equal(offered[0], hex(sent.id));
  } finally { done(); }
});

test('it stops as "combined" once the settlement is submitted, and offers nothing after', async () => {
  let asked = 0;
  const { c, offered, done } = client(() => 'refused: not yet', () => (++asked >= 2 ? new Response('{"state":"SUBMITTING"}') : new Response('{"state":"OPEN"}')));
  try {
    await final(c);
    assert.equal(await c.catchingUp, 'combined');
    const before = offered.length;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(offered.length, before, 'the mark was offered after the settlement was combined');
    assert.equal(c.finalRelinks, 1);
  } finally { done(); }
  const accepted = client(() => 'refused: not yet', () => new Response('{"state":"ACCEPTED"}'));
  try { await final(accepted.c); assert.equal(await accepted.c.catchingUp, 'combined'); } finally { accepted.done(); }
});

test('it stops as "left" when the page closes; a failed re-offer records why and carries on', async () => {
  // the first re-offer goes at once (seat B's 2nd answer: a throw), the next a second later (its 3rd: a refusal)
  const { c, done } = client((n) => { if (n === 2) throw new Error('the socket to seat B broke'); return 'refused: not yet'; },
    () => { throw new Error('seat A is down'); });
  try {
    await final(c);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.finalRelinkWhy, 'the socket to seat B broke', 'a re-offer that threw was not recorded by its message');
    assert.equal(c.finalRelinks, 1);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(c.finalRelinks, 2, 'the catch-up stopped at the throw');
    assert.equal(c.finalRelinkWhy, 'http://seat-b.example: refused: not yet');
    c.close();
    assert.equal(await c.catchingUp, 'left');
    assert.equal(c.finalCatchUp, 'left');
  } finally { done(); }
});

test('a second ask while one catch-up runs returns the same catch-up', async () => {
  const { c, done } = client((n, bytes) => (n < 2 ? 'refused: not yet' : receipt(bytes, B)));
  try {
    await final(c);
    const first = c.catchingUp;
    await final(c).catch(() => {});
    assert.equal(c.catchingUp === first || c.catchingUp === null, true);
    assert.equal(await first, 'receipted');
  } finally { done(); }
});
