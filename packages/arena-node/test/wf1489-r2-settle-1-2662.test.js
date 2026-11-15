// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2662 (feedback #057), kanban #1489 audit r2 (settlement/reserves): ONE SEAT'S /reserves LISTING NAMES WHICH ENTRY A RESERVE OUTPUT PAYS FOR.
// The peer pass (server.js reservePeerPass -> verifyPeerReserveRow) checks only that the federation holds the payout contract to the
// reserve key for the amount; the row's entryId and roundId are kept as the peer wrote them. stake-lock-signer-node.js then refuses any
// entry whose reserve (or donation) output "already pays for another entry" (donationOutputAt). So one seat that lists a player's fresh
// reserve outpoint under a made-up entry id makes every seat that reads it first refuse that player's real stake lock.
// SAFE: a row another seat listed never decides which entry an output pays for - the real entry's gifts still verify here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPeerReserveRow } from '../src/reserve-book.js';
import { verifyDonationOutputs, donationContractFields } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32 } from './window-fixture.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';

const RESERVE_KEY = Uint8Array.of(0x02, ...new Uint8Array(32).fill(0xc3));
const OUT = { txid: b32(0x08), outIdx: 5n };
const at = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const idOf = (f) => [f.paymentImage.kind, toHex(f.paymentImage.bytes), f.amountMsat, toHex(f.claimPk), toHex(f.refundPk), f.expiration].join('|');
const port = { held: new Map([[at(OUT), idOf(donationContractFields({ recipientPk: RESERVE_KEY, amountMsat: 2000n }))]]),
  async status(o) { const id = this.held.get(at(o)); return { blockCount: 156800, stored: id ? { contractId: id, blocksLeft: 0 } : null }; },
  async contractId(f) { return idOf(f); } };

test('a peer row naming a made-up entry for a real reserve output does not make this seat refuse the entry that paid it', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const REAL_ENTRY = b32(0xee), FORGED_ENTRY = b32(0x66);
    // the malicious seat's GET /reserves?all=1 lists the player's reserve output under an entry id it made up
    const forged = { outpoint: at(OUT), roundId: toHex(b32(0x01)), entryId: toHex(FORGED_ENTRY), amountMsat: '2000', image: null };
    const v = await verifyPeerReserveRow({ row: forged, port, reserveKey: RESERVE_KEY, federationId: b32(0xfe) });
    if (v.ok) s.d.round.putDonationOutputs([v.row]);
    // then the player's lock reaches this seat: its reserve output is checked as verifyEntryGifts checks it
    const r = await verifyDonationOutputs({ round: s.d.round, port, entryIdBytes: REAL_ENTRY, federationId: b32(0xfe),
      entry: { roundId: b32(0x01), donationMsat: 2000n, donationOutpoints: [OUT] },
      recipients: [{ recipientPk: RESERVE_KEY, shareBps: 10000, label: 'protocol reserves' }] });
    assert.equal(r.ok, true, `the real entry's reserve output is refused at this seat because one peer named another entry for it: ${r.why}`);
  } finally { await s.close(); }
});
