// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm1 page-8 (state-machine audit, release 2026.1.9.30): TWO TABS' ZAP PASSES SHARE ONE "COLLECTING" LIST, AND THE LAST WRITER WINS.
// #2319 writes a refund's mark into arena.zaps.collecting (the browser's store, shared by every tab) BEFORE the refund is sent, so a refund
// the guardians accepted in a pass that never ended is booked by the next pass instead of being filed as spent. But collectZaps reads the
// whole list once, at the start of its pass, and writes its own in-memory copy back whole (keepCollecting). Two tabs (two phrases, each
// collecting its own identity key's zaps once a minute) whose passes overlap: tab A writes its mark and sends its refund; tab B, which
// read the list before A's mark, writes its own list over it. A's tab closes before its refund answered (the #2319 case); the reload's
// pass finds the contract spent, the mark is gone, and the zap is filed `spent` - never booked, the sats in the wallet named nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps, ZAPS_COLLECTING_KEY } from '../src/identity.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const F = 'fe'.repeat(32);
const donor = toHex(schnorr.getPublicKey(new Uint8Array(32).fill(0x77)));
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

test('sm1 page-8: a zap refund begun in tab A is booked after a reload although tab B collected at the same time', async () => {
  const keep = mem();                                   // localStorage: shared by both tabs
  const tabA = mem(); tabA.setItem('arena.player.seed', 'ab'.repeat(32));
  const tabB = mem(); tabB.setItem('arena.player.seed', 'cd'.repeat(32));
  const zapA = { outpoint: `${'1a'.repeat(32)}:0`, federationId: F, amountMsat: '21000', senderOnContract: true, playerKey: donor };
  const zapB = { outpoint: `${'2b'.repeat(32)}:0`, federationId: F, amountMsat: '5000', senderOnContract: true, playerKey: donor };
  const listing = (rows, ms = 0) => async () => { if (ms) await new Promise((r) => setTimeout(r, ms)); return new Response(JSON.stringify({ donations: rows }), { status: 200 }); };
  const fed = { storedA: true, walletA: 0n };
  // tab A: the guardians accept its refund, the tab is closed before the lock client answers
  const dyingA = { refund: async () => { fed.storedA = false; fed.walletA += 21000n; return new Promise(() => {}); } };
  const liveB = { refund: async () => JSON.stringify({ accepted: true }) };
  // both tabs' passes start in the same second (each runs once a minute); B's seat answers a little later than A's
  const passA = collectZaps({ storage: tabA, keep, curve, clients: new Map([[F, dyingA]]), seats: ['https://a.example'], fetcher: listing([zapA]) });
  void passA;
  const passB = collectZaps({ storage: tabB, keep, curve, clients: new Map([[F, liveB]]), seats: ['https://a.example'], fetcher: listing([zapB], 30) });
  await tick();
  const afterA = JSON.parse(keep.getItem(ZAPS_COLLECTING_KEY) || '[]');
  assert.equal(fed.storedA, false, 'the federation took tab A\'s refund');
  assert.ok(afterA.some((m) => m.startsWith(zapA.outpoint)), 'tab A wrote its mark before its refund');
  const gotB = await passB;
  assert.equal(gotB.collected.length, 1, 'tab B collected its own zap');
  const afterB = JSON.parse(keep.getItem(ZAPS_COLLECTING_KEY) || '[]');
  console.log(`  FACTS sm1-page-8: collecting after A's mark ${JSON.stringify(afterA.map((m) => m.slice(0, 8)))}, after B's pass ${JSON.stringify(afterB.map((m) => m.slice(0, 8)))}`);
  // tab A reloaded: the same phrase, the same browser store, a fresh wallet client over the same wallet
  const liveA = { refund: async () => (fed.storedA ? JSON.stringify({ accepted: true }) : JSON.stringify({ accepted: false, stored_before: null })) };
  const gotA = await collectZaps({ storage: tabA, keep, curve, clients: new Map([[F, liveA]]), seats: ['https://a.example'], fetcher: listing([zapA]) });
  console.log(`  FACTS sm1-page-8: wallet A holds ${fed.walletA} msat from its zap; the reload's pass says collected ${gotA.collected.length}, spent ${gotA.spent.length}`);
  // the page books a "Zap received" row only for `collected` (index.html collect(): recordReceived for got.collected)
  assert.equal(gotA.collected.length, 1, `tab A's 21000 msat zap, in its wallet, is booked once (filed as spent: collected ${gotA.collected.length}, spent ${gotA.spent.length})`);
});
