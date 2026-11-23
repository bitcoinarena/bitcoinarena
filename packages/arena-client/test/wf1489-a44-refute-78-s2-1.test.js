// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// WF1489 a44 refute 78, skeptic 2 (kanban #1774 / #2183, SM-C5): THE HONEST PATH IN A FULL BROWSER.
// #2183 stops a Move / evacuation when the receive leg's write is refused. But the leg is written with a raw setItem (pendingAdd), never
// through putRoomy, so the page's storage-full relief (onStorageFull -> ARENA_TIDY_STORAGE(800000), the #803 path every wallet write takes)
// is never asked to make room: a browser where one tidy frees room now refuses every Move and every evacuation out of a CRITICAL federation.
// And migrateFromDraining answers that stop as { moved: 0n, chunks: 0 } - the shape the page's ARENA_EVACUATE reads as "found empty"
// (evacuatedEmpty.add(fid)): the federation is not tried again for the rest of the page, the notes stay in the CRITICAL federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movePlayerWallet, migrateFromDraining, onStorageFull, putRoomy } from '../src/page-lock.js';
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
// a FULL browser store whose room the page's tidy frees: every write is refused until the relief (onStorageFull) has run once
const fullUntilTidied = () => { const s = { tidied: 0, full: true, m: new Map() };
  Object.assign(s, { getItem: (k) => s.m.get(k) ?? null,
    setItem: (k, v) => { if (s.full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } s.m.set(k, String(v)); },
    removeItem: (k) => s.m.delete(k), key: (i) => [...s.m.keys()][i] ?? null });
  Object.defineProperty(s, 'length', { get: () => s.m.size });
  return s; };
const wallets = () => {
  const x = { balance: 500000n, paid: 0, feeRule: async () => JSON.stringify({ fee_base_msat: 1000, fee_ppm: 0 }),
    balanceMsat: async () => String(x.balance), withdrawableMsat: async () => String(x.balance > 5000n ? x.balance - 5000n : 0n),
    withdraw: async (invoice) => { const msat = AMT.get(invoice); x.balance -= msat + 1000n; x.paid++; return JSON.stringify({ state: 'Success', invoice_msat: String(msat) }); } };
  const y = { balance: 0n, feeRule: async () => JSON.stringify({ fee_base_msat: 0, fee_ppm: 0 }), balanceMsat: async () => String(y.balance),
    receive: async (msat) => JSON.stringify({ invoice: bolt11For(BigInt(msat), ++SEQ), operation: `op-move-${SEQ}` }),
    awaitReceive: async () => { y.balance += 1n; return 'Claimed'; } };
  return { x, y };
};

test('wf1489-a44-refute-78-s2-1: the relief a wallet write gets (putRoomy) makes room here - a Move must not stop "storage full" without asking for it', async () => {
  const storage = fullUntilTidied();
  onStorageFull(() => { storage.tidied++; storage.full = false; });
  try {
    // the relief works for any wallet write: the same store takes a putRoomy write after one tidy
    // (checked on a copy so the store under test stays full)
    const probe = fullUntilTidied(); onStorageFull(() => { probe.full = false; }); putRoomy(probe, 'arena.walletdb.x', '1'); assert.equal(probe.getItem('arena.walletdb.x'), '1');
    onStorageFull(() => { storage.tidied++; storage.full = false; });
    const { x, y } = wallets();
    const LockClient = { join: async (i) => (i === 'inviteA' ? x : y), lockAllowanceMsat: () => '0', federationIdOf: (i) => (i === 'inviteA' ? A : B) };
    const r = await movePlayerWallet({ from: { federation: A, invite: 'inviteA' }, to: { federation: B, invite: 'inviteB' }, seed: new Uint8Array(32).fill(7), LockClient, storage });
    console.log('  FACTS refute-78-s2-1 move:', JSON.stringify({ state: r.state, why: r.why, tidied: storage.tidied, xPayments: x.paid }));
    assert.ok(storage.tidied > 0 || r.state !== 'stopped',
      `the Move stopped (${r.why}) and the page's storage relief was never asked (tidied ${storage.tidied}) - one tidy would have kept the leg`);
  } finally { onStorageFull(null); }
});

test('wf1489-a44-refute-78-s2-1: an evacuation stopped for storage must not look like an empty federation to the page (ARENA_EVACUATE evacuatedEmpty)', async () => {
  const storage = fullUntilTidied();   // no relief registered: the leg is refused for good this time
  const { x, y } = wallets();
  const r = await migrateFromDraining({ from: x, to: y, record: { status: 'CRITICAL', successorId: fromHex(B) }, toFederationId: fromHex(B), fromFederationId: fromHex(A), storage, phrase16: '07'.repeat(8) });
  // the page's own predicate (src/arena-ui/index.html ARENA_EVACUATE): moved 0 in 0 chunks -> evacuatedEmpty.add(fid), never tried again this page
  const pageCallsItEmpty = String(r.moved) === '0' && Number(r.chunks) === 0;
  console.log('  FACTS refute-78-s2-1 evacuate:', JSON.stringify({ state: r.state, why: r.why, moved: String(r.moved), chunks: r.chunks, xBalance: String(x.balance), pageCallsItEmpty }));
  assert.ok(!(pageCallsItEmpty && BigInt(await x.withdrawableMsat()) > 10000n),
    `the evacuation stopped (${r.why}) with ${await x.withdrawableMsat()} msat still in the CRITICAL federation, and its answer reads as "found empty" to the page - not tried again`);
});
