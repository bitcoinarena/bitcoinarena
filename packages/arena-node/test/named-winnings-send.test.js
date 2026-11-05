// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SENDS OF A PROTOCOL-27 SETTLEMENT (kanban #1044 B1, ruling #1134 2): the gateway's auth is the one S presigned in the settlement's batch, never
// a signature made after it; the send refunds to KeyAgg(S); a send to a qualifier that expires unpaid is not re-sent - its presigned refund (c) is
// submitted and the winnings land in the qualifier's own payout contract. A held donation share is not re-sent by a key signed later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x6e);
const PRE = b32(0x31);
const HASH = toHex(sha256(PRE));
const KEY = Uint8Array.from([0x02, ...b32(0x22)]);
const AUTH = new Uint8Array(64).fill(0xa1), REFUND = new Uint8Array(64).fill(0xc3);

function world({ pays = true, donation = false, held = false } = {}) {
  const marks = [];
  const row = { entryId: b32(0x11), roundId: RID, attempt: 0, address: 'w@x', invoice: held ? '' : 'lnbcrt-inv', paymentHash: held ? '' : HASH, invoiceMsat: 90n,
    payoutMsat: 100n, owedMsat: 100n, gatewayUrl: 'http://gw', gatewayPk: '03' + 'cd'.repeat(32), expiration: 500n, donation, state: 'PLANNED', txid: null };
  const round = { get: () => null, sendPlansOf: () => [row], sendAttemptsOf: () => [row], markSend: (x) => { marks.push(x); Object.assign(row, x); },
    putWinnings: () => {}, now: () => 0 };
  const calls = { send: [], refund: [] };
  const port = {
    send: async (a) => { calls.send.push(a); return pays ? { sent: true, preimage: PRE } : { sent: false, why: 'no route' }; },
    status: async () => ({ stored: { blocksLeft: 0 }, blockCount: 600 }),
    arenaSendRefund: async (a) => { calls.refund.push(a); return { txid: 'ref'.padEnd(64, '0'), message: 'ref'.padEnd(64, '0'), accepted: true }; },
  };
  const w = new WinningsSend({ round, port, peersFor: () => [], fetcher: async () => ({ ok: true }) });
  w.sign = async () => { throw new Error('a protocol-27 send is never signed after the settlement'); };
  const built = { ok: true, named: true, txid: 'aa'.repeat(32), claimPk: KEY,
    plan: { payouts: [{ pubkey: b32(5), msat: 100n, payoutPk: KEY, ...(held ? { kind: 'held', donation: { id: row.entryId } } : { kind: 'sent', sent: { paymentHash: HASH } }) }] },
    batch: { slots: [{ kind: 'claim' }, { kind: 'auth', outIdx: 0, paymentHash: HASH }, { kind: 'refund', outIdx: 0, txid: 'ref'.padEnd(64, '0'), qualifierPk: '02' + '05'.repeat(32) }],
      signatures: [new Uint8Array(64), AUTH, REFUND] } };
  return { w, built, calls, marks, row };
}

test('the gateway is asked with the auth S presigned in the batch, the send refunding to KeyAgg(S)', async () => {
  const { w, built, calls } = world();
  const out = await w.sendAll(RID, built);
  assert.equal(out[0].state, 'PAID', JSON.stringify(out));
  assert.equal(toHex(calls.send[0].auth), toHex(AUTH));
  assert.equal(toHex(calls.send[0].refundPk), toHex(KEY));
  assert.equal(toHex(calls.send[0].outpoint.txid), 'aa'.repeat(32));
});

test('a send to a qualifier that expires unpaid is not re-sent: its presigned refund (c) is submitted', async () => {
  const { w, built, calls, row } = world({ pays: false });
  const out = await w.sendAll(RID, built);
  assert.equal(out[0].state, 'REFUNDED', JSON.stringify(out));
  assert.equal(calls.refund.length, 1);
  assert.equal(toHex(calls.refund[0].signature), toHex(REFUND));
  assert.equal(toHex(calls.refund[0].refundPk), toHex(KEY));
  assert.equal(toHex(calls.refund[0].qualifierPk), '02' + '05'.repeat(32));
  assert.equal(row.state, 'REFUNDED');
  // the next sweep leaves it alone
  const again = await w.sendAll(RID, built);
  assert.equal(again[0].already, true);
  assert.equal(calls.refund.length, 1);
});

test('a held donation share of a protocol-27 settlement is not re-sent under a key signed later', async () => {
  const { w, built, calls } = world({ held: true, donation: true });
  const out = await w.sendAll(RID, built);
  assert.equal(out[0].held, true);
  assert.match(out[0].why, /protocol-27/);
  assert.equal(calls.send.length + calls.refund.length, 0);
});
