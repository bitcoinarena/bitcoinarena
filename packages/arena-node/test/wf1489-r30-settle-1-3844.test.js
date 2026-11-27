// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r30-settle-1: a reserve row another seat lists in GET /reserves?all=1 carries a roundId the peer chose. verifyPeerReserveRow
// checks only that the federation holds a payout contract to the reserve key for that amount, and keeps the row with the peer's roundId;
// reserveRowsOfNetwork (#1336, §27A.8.5) then decides by that roundId whether the row is this network's to pay. One seat relabels an
// ancestor network's reserve output (a round this seat reads as ANOTHER network, so it would be dropped) as a payout change (zero round id):
// the honest seat now counts and spends it as its own network's reserves. SAFE: a peer's word on the round never makes a row spendable that
// this seat's own records would not - a peer row whose round is not verified here is at most `unknown` (never picked as a coordinator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPeerReserveRow } from '../src/reserve-book.js';
import { reserveRowsOfNetwork } from '../src/reserve-payout.js';
import { donationContractFields } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';
const b32 = (n) => new Uint8Array(32).fill(n);

const RESERVE_KEY = Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xc3));
const FED = toHex(b32(0xfe));
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');
const federation = (held) => ({ held: new Map(Object.entries(held)),
  async status(o) { const id = this.held.get(at(o)); return { blockCount: 156800, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
  async contractId(f) { return idOf(f); } });

const OUR_NET = toHex(b32(0xa1)), ANCESTOR_NET = toHex(b32(0xa0));
const ANCESTOR_ROUND = toHex(b32(0x01));
const netOfRound = (rid) => (rid === ANCESTOR_ROUND ? ANCESTOR_NET : null);

test('r30-settle-1: one peer relabels an ancestor network\'s reserve output as payout change and the honest seat spends it', async () => {
  const outpoint = `${toHex(b32(0x10))}:4`;
  const port = federation({ [outpoint]: idOf(donationContractFields({ recipientPk: RESERVE_KEY, amountMsat: 5_000_000n })) });
  // what honest seats list: the row under the ancestor round it was paid in - dropped on the successor (#1336)
  const honest = { outpoint, roundId: ANCESTOR_ROUND, entryId: toHex(b32(0x20)), amountMsat: '5000000', image: null };
  const h = await verifyPeerReserveRow({ row: honest, port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
  assert.equal(h.ok, true, h.why);
  const keptHonest = reserveRowsOfNetwork([{ ...h.row, outpoint, roundId: toHex(h.row.roundId), federationId: FED }], OUR_NET, netOfRound);
  assert.equal(keptHonest.length, 0, 'control: the ancestor\'s row is not the successor\'s to pay');

  // the one lying seat lists the same outpoint first, as a payout's change (zero round id)
  const forged = { ...honest, roundId: '00'.repeat(32), entryId: '00'.repeat(32) };
  const v = await verifyPeerReserveRow({ row: forged, port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
  const spendable = v.ok
    ? reserveRowsOfNetwork([{ ...v.row, outpoint, roundId: toHex(v.row.roundId), federationId: FED }], OUR_NET, netOfRound).filter((r) => !r.unknown)
    : [];
  assert.equal(spendable.length, 0,
    `a round id one peer named (${forged.roundId.slice(0, 8)}…) made an ancestor network's ${honest.amountMsat} msat reserve output spendable on this network`);
});
