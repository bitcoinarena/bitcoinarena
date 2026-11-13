// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm10 page-1: A ZAP COLLECTED BY A PASS THAT DID NOT END IS NEVER BOOKED.
// collectZaps (identity.js) refunds each zap outpoint into the player wallet and notes it (arena.zaps.collected) only after the whole pass;
// the page writes the "Zap received" / "Referral" history row (recordReceived) only for what a pass returns as `collected`. A pass whose
// refund the guardians accepted but whose answer never reached the page (the tab closed, reloaded, the wasm call cut) leaves nothing
// written; the next page's pass finds the contract spent (stored_before null) and files it under `spent` - final, never `collected`. The
// sats are in the wallet and no record of this browser says where they came from: the history lies about the balance for good.
// Safe: a zap whose refund this page began and the federation then reads spent is booked once, as collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { collectZaps } from '../src/identity.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const curve = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const SEED = 'ab'.repeat(32), F = 'fe'.repeat(32), TXID = 'cd'.repeat(32);
const donor = schnorr.getPublicKey(new Uint8Array(32).fill(0x77));

test('sm10 page-1: a zap refunded by a pass the tab did not finish is booked by the next pass, not filed as spent', async () => {
  const session = mem(); session.setItem('arena.player.seed', SEED);
  const keep = mem();   // the browser's store: survives the tab
  const rows = [{ outpoint: `${TXID}:0`, federationId: F, amountMsat: '21000', senderOnContract: true, playerKey: toHex(donor) }];
  const fetcher = async () => new Response(JSON.stringify({ donations: rows }), { status: 200 });
  // THE FEDERATION: one contract; a refund it accepts spends it
  const fed = { stored: true, walletMsat: 0n };
  // page 1: the guardians accept the refund, the tab is closed before the lock client answers
  const dying = { refund: async () => { fed.stored = false; fed.walletMsat += 21000n; return new Promise(() => {}); } };
  const pass1 = collectZaps({ storage: session, keep, curve, clients: new Map([[F, dying]]), seats: ['https://a.example'], fetcher });
  void pass1;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(fed.stored, false, 'the federation took the refund');
  // page 2 (a reload): the same browser store, a fresh wallet client over the same wallet
  const live = { refund: async () => (fed.stored ? JSON.stringify({ accepted: true }) : JSON.stringify({ accepted: false, stored_before: null })) };
  const got = await collectZaps({ storage: session, keep, curve, clients: new Map([[F, live]]), seats: ['https://a.example'], fetcher });
  console.log(`  FACTS sm10-page-1: wallet holds ${fed.walletMsat} msat from the zap; the reload's pass says collected ${got.collected.length}, spent ${got.spent.length}, total ${got.totalMsat} msat`);
  // the page books a history row only for `collected` (index.html collect(): recordReceived for got.collected)
  assert.equal(got.collected.length, 1, `the 21000 msat zap in the wallet is booked once (it was filed as spent: collected ${got.collected.length}, spent ${got.spent.length})`);
});
