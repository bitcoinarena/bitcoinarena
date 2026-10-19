// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PEER THAT REFUSES THE ENTRY IS NOT ASKED AT EVERY BATCH (2026-10-16: "Lower the amount of concurrent
// connections and network load"). Measured on live UI 154: three fed2 peers answered the entry 400, and the client sent them every
// batch and the entry again after each "no such entry" - a refused POST /entry every 1-2 s for the whole round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, ENTRY_BACKOFF_MS, ENTRY_BACKOFF_MAX_MS } from '../src/client.js';

function fakeClient({ entryAnswer }) {
  const c = new Client({ base: 'https://me.example', core: null, sign: null, verify: null });
  let t = 1_000_000; c.now = () => t;
  c.peers = ['https://peer.example'];
  c.joinedEntry = {};
  const asked = { batches: 0, entries: 0 };
  c.sendPeer = async () => { asked.batches++; return 'error no such entry for this round'; };
  c.joinOn = async (base) => { asked.entries++; return entryAnswer(base); };
  c.published = [{ bytes: new Uint8Array(1), through: 1 }];
  return { c, asked, tick: (ms) => { t += ms; } };
}
const batch = async (c) => { c.published.push({ bytes: new Uint8Array(1), through: c.published.length + 1 }); c.pumpPeers(); await c.awaitPeers(); };

test('a refused entry is asked again only after its backoff, doubling to ENTRY_BACKOFF_MAX_MS', async () => {
  const { c, asked, tick } = fakeClient({ entryAnswer: () => ({ ok: false, why: 'that entry names shares this node has not accepted' }) });
  // a batch a second for 60 s: before, 60 entries and 60 batches went to this peer
  for (let s = 0; s < 60; s++) { await batch(c); tick(1000); }
  console.log(`  60 s of batches: ${asked.entries} entries, ${asked.batches} batch sends to the refusing peer`);
  assert.ok(asked.entries <= 6, `asked ${asked.entries} times`);         // 0, 2, 6, 14, 30 s (+ 62 s next)
  assert.ok(asked.batches <= 6);
  assert.match(c.peerFeed('https://peer.example').why, /the entry refused: that entry names shares/);
  assert.equal(c.peerFeed('https://peer.example').entryBackoffMs, 32000);
  assert.equal(ENTRY_BACKOFF_MS, 2000); assert.equal(ENTRY_BACKOFF_MAX_MS, 60000);
});

test('a node that only lost the entry takes it again at once, and is fed as before', async () => {
  let gave = 0;
  const { c, asked } = fakeClient({ entryAnswer: () => { gave++; return { ok: true, why: null }; } });
  await batch(c); await batch(c); await batch(c);
  assert.equal(gave, 3, 'given again after each "no such entry", no backoff');
  assert.equal(c.peerFeed('https://peer.example').entryBackoffUntil || 0, 0);
  assert.ok(asked.batches >= 3);
});
