// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// WF1489 a44 refute 78 (kanban #1774, SM-C5): THE RECEIVE LEG "WRITTEN AHEAD" OF A MOVE IS NOT CHECKED BEFORE THE PAYMENT.
// moveLegAhead -> pendingAdd swallows a refused write (QuotaExceededError on a full browser store, kanban #803) and swapForRound /
// migrateFromDraining pay out of X all the same. A tab closed between that payment and the claim in Y then leaves Y named nowhere:
// the exact state #1774 was made to end. A write-ahead that did not land must stop the payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movePlayerWallet, migrateFromDraining, ledgerFederations, pendingDeposits } from '../src/page-lock.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';
const AMT = new Map();
function bolt11For(amountMsat, n = 0) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000 + n;
  const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, new Uint8Array(32).fill(0x10 + (n % 200)));
  field(23, new Uint8Array(32).fill(0x78));
  for (let i = 0; i < 104; i++) words.push(0);
  const inv = bech32Encode(`lnbcrt${amount}`, words); AMT.set(inv, BigInt(amountMsat)); return inv;
}
let SEQ = 0;

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
// a browser store that is full: the pending entry (a small write) is refused, everything already there stays readable
const fullStore = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null,
  setItem: (k, v) => { if (k.startsWith('arena.deposit.pending.')) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
  removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
const wallets = () => {
  const x = { balance: 500000n, paid: 0, feeRule: async () => JSON.stringify({ fee_base_msat: 1000, fee_ppm: 0 }),
    balanceMsat: async () => String(x.balance), withdrawableMsat: async () => String(x.balance > 5000n ? x.balance - 5000n : 0n),
    withdraw: async (invoice) => { const msat = AMT.get(invoice); x.balance -= msat + 1000n; x.paid++; return JSON.stringify({ state: 'Success', invoice_msat: String(msat) }); } };
  const ctl = { wait: null };
  const y = { balance: 0n, feeRule: async () => JSON.stringify({ fee_base_msat: 0, fee_ppm: 0 }), balanceMsat: async () => String(y.balance),
    receive: async (msat) => JSON.stringify({ invoice: bolt11For(BigInt(msat), ++SEQ), operation: 'op-move-1' }),
    awaitReceive: () => new Promise((ok) => { ctl.wait = ok; }) };
  return { x, y, ctl };
};
const tick = () => new Promise((r) => setTimeout(r, 2));

for (const door of ['movePlayerWallet', 'migrateFromDraining']) {
  test(`wf1489-a44-refute-78-s1-1 (${door}): a refused write-ahead must not be followed by a payment out of X`, async () => {
    const { x, y, ctl } = wallets();
    const storage = fullStore();
    if (door === 'movePlayerWallet') {
      const LockClient = { join: async (i) => (i === 'inviteA' ? x : y), lockAllowanceMsat: () => '0', federationIdOf: (i) => (i === 'inviteA' ? A : B) };
      movePlayerWallet({ from: { federation: A, invite: 'inviteA' }, to: { federation: B, invite: 'inviteB' }, seed: new Uint8Array(32).fill(7), LockClient, storage }).catch(() => {});
    } else {
      migrateFromDraining({ from: x, to: y, record: { status: 'CRITICAL', successorId: fromHex(B) }, toFederationId: fromHex(B), fromFederationId: fromHex(A), storage, phrase16: '07'.repeat(8) }).catch(() => {});
    }
    for (let i = 0; i < 80 && !ctl.wait && !x.paid; i++) await tick();
    for (let i = 0; i < 10; i++) await tick();
    // THE TAB IS GONE HERE
    const named = ledgerFederations(storage).includes(B) || pendingDeposits(storage, fromHex(B)).length > 0;
    console.log('  FACTS refute-78-1:', JSON.stringify({ door, xPayments: x.paid, xPaidMsat: String(500000n - x.balance), yNamed: named }));
    assert.ok(named || x.paid === 0,
      `${door}: the receive leg was not written (store full) and X paid ${500000n - x.balance} msat anyway - Y is named nowhere a next page opens a wallet from`);
    if (ctl.wait) ctl.wait('Claimed');
  });
}
