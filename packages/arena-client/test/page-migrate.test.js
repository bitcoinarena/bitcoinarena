// THE NOTES FOLLOW THE SUCCESSOR (§23A.6 step 3, kanban #325): a wallet in a DRAINING federation moves everything it can
// send to the successor named by the verified record - in chunks, each a stock send paying the successor's receive invoice,
// no press; nothing moves on an OPEN record, a record naming no successor, or a wallet that is not the successor's; a failed
// chunk is tried again and then the move stops with the notes where they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateFromDraining, MIGRATE_DUST_MSAT } from '../src/page-lock.js';
import { bech32Encode, convertBits } from '../../arena-protocol/src/bech32.js';

/** A BOLT11 invoice for tests: the real encoding, an all-zero signature (as page-lock.test.js); `n` makes each one new. */
function bolt11For(amountMsat, n = 0) {
  const amount = amountMsat % 100n === 0n ? `${amountMsat / 100n}n` : `${amountMsat * 10n}p`;
  const ts = 1788700000 + n;
  const words = [];
  for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / 32 ** i) % 32);
  const field = (type, bytes) => { const w = convertBits([...bytes], 8, 5, true); words.push(type, w.length >> 5, w.length & 31, ...w); };
  field(1, new Uint8Array(32).fill(0x77));
  field(23, new Uint8Array(32).fill(0x78));
  for (let i = 0; i < 104; i++) words.push(0);
  return bech32Encode(`lnbcrt${amount}`, words);
}

const OLD = 'aa'.repeat(32), NEW = 'bb'.repeat(32);
function wallets(balanceMsat, { sendFails = 0, receiveEnds = 'Claimed' } = {}) {
  let bal = BigInt(balanceMsat), got = 0n, fails = sendFails, n = 0;
  const pending = new Map();
  const from = {
    withdrawableMsat: async () => String(bal > 2000n ? bal - 2000n : 0n),      // the send's fee kept back
    withdraw: async (invoice) => {
      const amount = pending.get(invoice);
      if (fails > 0) { fails--; return JSON.stringify({ state: 'Refunded', invoice_msat: String(amount) }); }
      bal -= amount + 2000n; got += amount;
      return JSON.stringify({ state: 'Success', invoice_msat: String(amount) });
    },
  };
  const to = {
    receive: async (msat) => { ++n; const invoice = bolt11For(BigInt(msat), n); pending.set(invoice, BigInt(msat)); return JSON.stringify({ invoice, operation: 'op' + n }); },
    awaitReceive: async () => receiveEnds,
  };
  return { from, to, left: () => bal, got: () => got };
}

test('a DRAINING record naming the successor: everything sendable moves, in chunks, no press', async () => {
  const w = wallets(1000000n);
  const states = [];
  const out = await migrateFromDraining({ from: w.from, to: w.to, record: { status: 'DRAINING', successorId: NEW }, toFederationId: NEW,
    chunkMsat: 400000n, onState: (s) => states.push(s.state) });
  assert.equal(out.state, 'moved');
  assert.equal(out.chunks, 3);
  assert.equal(out.moved, w.got());
  assert.ok(w.left() <= MIGRATE_DUST_MSAT + 2000n, 'only dust and fees stay behind');
  assert.deepEqual([...new Set(states)], ['moving', 'moved']);
});

test('nothing moves on an OPEN record, on one naming no successor, or into a wallet that is not the successor', async () => {
  for (const [record, to, why] of [[{ status: 'OPEN', successorId: NEW }, NEW, 'not draining'], [{ status: 'DRAINING', successorId: '00'.repeat(32) }, NEW, 'no successor named'],
    [{ status: 'DRAINING', successorId: NEW }, OLD, 'that wallet is not in the successor'], [null, NEW, 'not draining']]) {
    const w = wallets(1000000n);
    const out = await migrateFromDraining({ from: w.from, to: w.to, record, toFederationId: to });
    assert.equal(out.state, why); assert.equal(w.got(), 0n);
  }
});

test('a refunded send is tried again; past the retries the move stops and the notes stay in the old federation', async () => {
  const w = wallets(500000n, { sendFails: 1 });
  const out = await migrateFromDraining({ from: w.from, to: w.to, record: { status: 'DRAINING', successorId: NEW }, toFederationId: NEW });
  assert.equal(out.state, 'moved'); assert.equal(out.chunks, 1);
  const stuck = wallets(500000n, { sendFails: 99 });
  const said = await migrateFromDraining({ from: stuck.from, to: stuck.to, record: { status: 'DRAINING', successorId: NEW }, toFederationId: NEW, retries: 2 });
  assert.equal(said.state, 'stopped'); assert.match(said.why, /Refunded/); assert.equal(stuck.got(), 0n);
  assert.equal(stuck.left(), 500000n, 'nothing left the old wallet');
});

test('dust stays: a wallet holding no more than the dust line moves nothing', async () => {
  const w = wallets(MIGRATE_DUST_MSAT);
  const out = await migrateFromDraining({ from: w.from, to: w.to, record: { status: 'DRAINING', successorId: NEW }, toFederationId: NEW });
  assert.equal(out.moved, 0n); assert.equal(out.state, 'moved');
});
