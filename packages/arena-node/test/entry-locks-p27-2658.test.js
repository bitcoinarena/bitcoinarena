// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2658: the headless entry (tools/entry-locks.mjs entrySplit - the house RPS bot's and tn4-rps-paid.mjs's) of a protocol-27+ game round
// is what the seats take (arena-protocol reserves.js giftsEntryExpected): the whole fee rate in the fee lock, no donation, no outputs beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySplit } from '../tools/entry-locks.mjs';
import { giftsEntryExpected } from '../../arena-protocol/src/reserves.js';
import { GIFTS_IN_FEE_LOCK_VERSION } from '../../arena-protocol/src/constants.js';
import { GAME_ID_V5 } from '../../rock-paper-scissors/plugin/rock-paper-scissors-v5.js';

const noFetch = async () => { throw new Error('a protocol-27 entry asks the seats for nothing'); };

test('a protocol-27+ RPS entry puts the developers\' and reserves\' parts in the fee lock, as the seats check it', async () => {
  for (const v of [GIFTS_IN_FEE_LOCK_VERSION, 28]) {
    const c = { protocolVersion: v, stakeMsat: 100000n, gameId: GAME_ID_V5, federationId: new Uint8Array(32).fill(7) };
    const s = await entrySplit({ c, roundHex: '00'.repeat(32), nodes: ['http://x'], fetcher: noFetch });
    assert.equal(s.donationMsat, 0n);
    assert.deepEqual(s.shares, []);
    assert.equal(s.reserveKey, null);
    const seat = giftsEntryExpected({ entry: { stakeMsat: c.stakeMsat, feeMsat: s.feeMsat, donationMsat: s.donationMsat, donationOutpoints: [], reserveOutpoint: null } });
    assert.equal(seat.ok, true, seat.why);
    assert.equal(s.netMsat + s.feeMsat, c.stakeMsat);
  }
});
