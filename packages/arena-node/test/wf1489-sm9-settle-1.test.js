// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-settle-1: A ROW MADE ACCEPTED ON ANOTHER TXID OF THE HISTORY KEEPS THE SHARES OF THE TXID THAT NEVER LANDED.
// #1249 made putLockSettlement(ACCEPTED) rewrite lock_settlement_moves to the landed txid's claims and payouts, and #1275 made keepMoves
// write nothing once the row is ACCEPTED on another txid. The winners' shares (lock_settlement_shares) are neither: they are what the
// last keepMoves wrote - this seat's own rebuild T1, kept while the row was still SUBMITTING - and the history keeps no shares to put
// back. Path: the other asker's T0 is handed here (take: moves + shares of T0, row SUBMITTING T0); this seat's own pass rebuilds T1
// (another table: an entry decided since), keepMoves(T1) writes T1's shares, submits, is refused because T0 landed, and recordSubmit
// makes the row ACCEPTED on T0. The moves are T0's again; the shares stay T1's. lateMessage splits every late loser's stake by these
// shares, so this seat builds another late settlement than the seats that kept T0's shares: it refuses their commit (another txid) or,
// as the asker, never reaches the threshold, and the late stake goes back to its loser at expiry.
// Safe: once the row is ACCEPTED on a txid, the shares kept are that txid's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as curve from '../src/curve.js';
import { LockSettlement, SUBMITTING, ACCEPTED } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x61);
const T0 = 'a0'.repeat(32), T1 = 'b1'.repeat(32);
const LOCK = `${toHex(b32(0x42))}:0`;
const outpoint = (s) => { const [t, i] = s.split(':'); return { txid: fromHex(t), outIdx: BigInt(i) }; };
const W1 = b32(0x21), W2 = b32(0x22);
// T0 (landed) pays W1 and W2 half each; T1 (this seat's later rebuild) pays W1 alone
const SHARES_T0 = [{ pubkey: W1, msat: 50000n }, { pubkey: W2, msat: 50000n }];
const SHARES_T1 = [{ pubkey: W1, msat: 100000n }];
const built = (txid, shares) => ({ ok: true, txid, message: fromHex(txid), claims: [{ outpoint: outpoint(LOCK) }], plan: { payouts: [{}, {}], claims: [], stakeShares: shares } });

test('wf1489 sm9-settle-1: a row made ACCEPTED on the landed txid of the history keeps that txid\'s winners\' shares', async () => {
  const round = new Round(openStore(':memory:'));
  // T0 landed: its claimed lock is gone and its payouts are stored; T1 was never in
  const port = { status: async (o) => { const at = `${toHex(o.txid)}:${String(o.outIdx)}`; if (at === LOCK) return { stored: null }; if (at.startsWith(T0)) return { stored: { blocksLeft: 100 } }; return { stored: null }; } };
  const ls = new LockSettlement(round, { curve, port, dkg: { signerNodeFor: () => ({ ok: false, why: 'unused' }) }, stakeSecrets: { open: async () => ({ ok: false }) } });
  ls.confirmSoon = () => {};
  // 1. the other asker's T0 handed here (what take() keeps: the moves and shares of T0, the row SUBMITTING on it)
  ls.keepMoves(RID, built(T0, SHARES_T0));
  round.putLockSettlement({ roundId: RID, txid: T0, message: fromHex(T0), signature: new Uint8Array(64).fill(7), state: SUBMITTING, why: 'signed by the signer nodes; submitted by the signer node that combined it' });
  round.putSettlementTxid({ roundId: RID, txid: T0, message: fromHex(T0), signature: new Uint8Array(64).fill(7) });
  // 2. this seat's own pass: its rebuild T1, the intent on disk (keepMoves, then the row), the submit refused - T0 spent the lock
  ls.keepMoves(RID, built(T1, SHARES_T1));
  round.putLockSettlement({ roundId: RID, txid: T1, message: fromHex(T1), signature: new Uint8Array(64).fill(8), state: SUBMITTING, why: 'about to submit' });
  round.putSettlementTxid({ roundId: RID, txid: T1, message: fromHex(T1), signature: new Uint8Array(64).fill(8) });
  const state = await ls.recordSubmit(RID, built(T1, SHARES_T1), new Uint8Array(64).fill(8), { accepted: false, error: 'the lock is spent' }, 'claimed');
  const row = round.lockSettlement(RID);
  const moves = round.lockSettlementMoves(RID);
  const shares = round.lockSettlementShares(RID).map((x) => [toHex(x.pubkey).slice(0, 4), String(x.msat)]);
  console.log('  FACTS sm9-settle-1:', JSON.stringify({ state, row: [row.state, row.txid.slice(0, 4)], moves: moves.txid.slice(0, 4), shares }));
  assert.deepEqual([row.state, row.txid], [ACCEPTED, T0], 'the fixture: the row is ACCEPTED on the landed T0');
  assert.equal(moves.txid, T0, 'the fixture: #1249 put T0\'s moves back');
  assert.deepEqual(shares, SHARES_T0.map((x) => [toHex(x.pubkey).slice(0, 4), String(x.msat)]),
    'the winners\' shares kept are those of the transaction that landed (T0), not of this seat\'s rebuild T1 that never did');
});
