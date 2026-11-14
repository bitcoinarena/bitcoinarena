// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-settle-2: A REFUSED ROW recover() FINDS LANDED IS NEVER INDEXED - ITS DONATION-KEY AND RESERVE OUTPUTS ARE LISTED NOWHERE HERE.
// Every other path that makes a row ACCEPTED on a landed txid indexes that settlement's donation-key payouts (indexRecovered): the submit
// whose refusal finds another txid in (#settleOnce after recordSubmit), the kept-SUBMITTING pass (own txid or one of the history). recover()'s
// REFUSED loop (kanban #1171) writes ACCEPTED with why "found in the federation after a REFUSED row" and indexes nothing, and the once-per-start
// backfill (backfillDonationKeys) visits only rows whose why starts "found in the federation after this signer node was inside it". Path: this
// seat's own submit of T1 was refused while the other asker's T0 was not yet in (REFUSED, every txid out); it restarts; recover() reads T0 in and
// makes the row ACCEPTED on it. Neither recover() nor the backfill ever indexes T0's outputs, so a walk-away's donation-key payouts (and a market's
// reserve payout) are listed by no GET /donations of this seat for good, and its donors never collect them through it.
// Safe: a row recover() makes ACCEPTED on a landed txid has that txid's outputs indexed (or the backfill tries it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as curve from '../src/curve.js';
import { LockSettlement, REFUSED, ACCEPTED } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x62);
const T0 = 'a0'.repeat(32), T1 = 'b1'.repeat(32);
const LOCK0 = `${toHex(b32(0x42))}:0`, LOCK1 = `${toHex(b32(0x43))}:0`;

test('wf1489 sm9-settle-2: a REFUSED row recover() makes ACCEPTED on the landed txid gets that settlement\'s outputs indexed', async () => {
  const round = new Round(openStore(':memory:'));
  // T0 landed: its claimed lock gone, its payouts stored; T1's lock still held, nothing of it stored
  const port = { status: async (o) => { const at = `${toHex(o.txid)}:${String(o.outIdx)}`;
    if (at === LOCK0) return { stored: null }; if (at === LOCK1) return { stored: { blocksLeft: 100 } };
    if (at.startsWith(T0)) return { stored: { blocksLeft: 100 } }; return { stored: null }; } };
  const ls = new LockSettlement(round, { curve, port, dkg: { signerNodeFor: () => ({ ok: false, why: 'unused' }) }, stakeSecrets: { open: async () => ({ ok: false }) } });
  ls.confirmSoon = () => {};
  const indexed = [];
  ls.indexRecovered = async (rid, txid, opts) => { indexed.push({ round: toHex(rid), txid, opts: opts || null }); return { indexed: 1 }; };
  // both txids in the history (T0 handed here, T1 this seat's own), the row REFUSED on T1 after every txid read out
  round.putSettlementTxid({ roundId: RID, txid: T0, message: fromHex(T0), signature: new Uint8Array(64).fill(7), claims: [LOCK0], payouts: 2 });
  round.putSettlementTxid({ roundId: RID, txid: T1, message: fromHex(T1), signature: new Uint8Array(64).fill(8), claims: [LOCK1], payouts: 2 });
  round.putLockSettlement({ roundId: RID, txid: T1, message: fromHex(T1), signature: new Uint8Array(64).fill(8), state: REFUSED, why: 'the guardians refused it: spent' });
  // the restart: recover(), then the once-per-start backfill
  const out = await ls.recover();
  const row = round.lockSettlement(RID);
  await ls.backfillDonationKeys({ paceMs: 0 });
  console.log('  FACTS sm9-settle-2:', JSON.stringify({ recovered: out.map((x) => x.state), row: [row.state, row.txid.slice(0, 4), row.why.slice(0, 48)], indexed }));
  assert.deepEqual([row.state, row.txid], [ACCEPTED, T0], 'the fixture: recover() made the row ACCEPTED on the landed T0');
  assert.ok(indexed.some((x) => x.txid === T0), 'the landed settlement\'s donation-key outputs are indexed (or tried) by recover() or the backfill');
});
