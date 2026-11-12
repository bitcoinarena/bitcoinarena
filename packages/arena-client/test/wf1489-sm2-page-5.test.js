// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM2 page-5: A MOVE (OR EVACUATION, OR A JOIN'S SWAP) CUT BETWEEN ITS PAYMENT AND ITS CLAIM LEAVES THE RECEIVING FEDERATION UNKNOWN TO
// THE BROWSER: THE PAID INVOICE IS NEVER CLAIMED.
//
// swapForRound keeps its states in memory only: the receiving wallet's invoice (to.receive), the paying wallet's payment (from.withdraw), then
// to.awaitReceive, and only after Claimed the history rows moved-out / moved-in. A deposit's invoice is written at once
// (arena.deposit.pending.<fed>.<op>, kanban #1179) so a reload resumes it and ledgerFederations names its federation; a move's invoice is
// written nowhere. A tab closed (or a phone that suspends it) after the payment left federation X and before the claim in Y: X's balance is
// down by the amount, and - Y having no history row and no pending entry - the next page never opens Y's wallet (ARENA_SUM_BALANCES and the
// resume open ledgerFederations + the lobby's), so the lock client's receive never runs, the money is shown nowhere, and once the incoming
// contract expires the gateway takes it back: paid from X, never received.
// The invariant: once a payment out of one wallet is made, the browser keeps what it is owed in the other until the receive ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movePlayerWallet, ledgerFederations, pendingDeposits } from '../src/page-lock.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const ledger = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };

test('wf1489-sm2-page-5: a Move whose tab closes after X paid and before Y claimed leaves Y named in this browser', async () => {
  const x = { balance: 500000n, feeRule: async () => JSON.stringify({ fee_base_msat: 1000, fee_ppm: 0 }),
    balanceMsat: async () => String(x.balance), withdrawableMsat: async () => String(x.balance - 5000n),
    withdraw: async (invoice) => { const msat = BigInt(invoice.split('-').pop()); x.balance -= msat + 1000n; return JSON.stringify({ state: 'Success', invoice_msat: String(msat) }); } };
  let claimWait = null;
  const y = { balance: 0n, feeRule: async () => JSON.stringify({ fee_base_msat: 0, fee_ppm: 0 }), balanceMsat: async () => String(y.balance),
    receive: async (msat) => JSON.stringify({ invoice: `lnbcrt-move-${msat}`, operation: 'op-move-1' }),
    // the gateway funded the incoming contract; the claim is still running when the tab goes
    awaitReceive: () => new Promise((ok) => { claimWait = ok; }) };
  const LockClient = { join: async (invite) => (invite === 'inviteA' ? x : y), lockAllowanceMsat: () => '0', federationIdOf: (i) => (i === 'inviteA' ? A : B) };
  const storage = ledger();
  // A fresh federation Y for this browser: no history row, no deposit there yet
  movePlayerWallet({ from: { federation: A, invite: 'inviteA' }, to: { federation: B, invite: 'inviteB' }, seed: new Uint8Array(32).fill(7), LockClient, storage }).catch(() => {});
  for (let i = 0; i < 50 && !claimWait; i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(claimWait, 'the move reached its claim');
  // THE TAB IS GONE HERE: what the next page reads of this browser's storage
  const held = ledgerFederations(storage);
  const owedInY = pendingDeposits(storage, fromHex(B));
  const facts = { xPaidMsat: String(500000n - x.balance), heldFederations: held.map((f) => f.slice(0, 8)), pendingInY: owedInY.length,
    keys: [...storage.m.keys()].map((k) => k.slice(0, 40)) };
  console.log('  FACTS page-5:', JSON.stringify(facts));
  assert.ok(held.includes(B) || owedInY.length > 0,
    `X paid ${facts.xPaidMsat} msat into Y's invoice and this browser names Y nowhere a next page opens a wallet from (ledgerFederations ${JSON.stringify(facts.heldFederations)}, no pending receive): the claim never runs again`);
  claimWait('Claimed');
});
