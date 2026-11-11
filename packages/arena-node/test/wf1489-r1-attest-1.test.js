// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-attest-2: THE UP/DOWN MARKET'S OUTCOME IS THE WINDOW'S, AND ONLY THE WINDOW'S. Its terms: "Signed at the window's end
// (observed_at = the window's end)". The fixed-key attestor daemon learns a round's entry close from the FIRST seat that answers
// GET /rounds (arena-attestor.mjs roundsOfGame) and signs once per round over the window that close names; a seat's POST /outcome takes
// any observed_at from the resolution time to the deadline (attestationTimely). So one seat listing a real round with its close moved
// 5 minutes later makes the attestors sign the outcome of ANOTHER 15 minutes - chosen by that seat after it saw the price - and every
// seat holds it. Safe: a period market's attestation is taken only when observed_at is its round's window end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS, UPDOWN_ATTESTOR_KEYS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { attestWindow, combine } from '../../arena-attestor/src/attestor.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const P = UPDOWN_PERIOD_MS;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const ATTESTORS = UPDOWN.attestors.map((a) => toHex(a.pubkey));

test('wf1489 r1-attest-2: an Up/Down attestation over a window shifted past the round\'s close is refused', async () => {
  const w = await lockRound({ n: 2, stakeMsat: 10_000n, round: ROUND, alignCloseMs: Number(P), stakeExpiryFor: (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks,
    endMs: testNow() + 1800000, serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  try {
    const close = w.c.entryCloseMs;
    // THE LIE: the round listed as closing 5 minutes later; its "window" is [close - 10 min, close + 5 min]
    const shift = 300000n;
    const window = { startMs: close - P + shift, endMs: close + shift };
    // the price: flat over the real window (a tie is Up), then falling in the 5 minutes after the close - the shifted window is Down
    const samples = [{ atMs: close - P - 60000n, price: 8300000n }, { atMs: close - 60000n, price: 8300000n }, { atMs: close + 60000n, price: 8200000n }];
    const real = attestWindow({ samples, roundId: w.rid, window: { startMs: close - P, endMs: close }, attestor: UPDOWN_ATTESTOR_KEYS.A });
    const words = ['A', 'B'].map((l) => attestWindow({ samples, roundId: w.rid, window, attestor: UPDOWN_ATTESTOR_KEYS[l] }));
    const att = combine(words, { attestors: ATTESTORS, threshold: 2 });
    assert.ok(att, 'two attestors signed the shifted window');
    skipTo(Number(close + shift) + 11000);   // the daemon signs a sample period after the (shifted) window's end, inside the 10 min deadline
    const r = await fetch(`http://127.0.0.1:${w.a.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: att.bytes });
    const text = (await r.text()).slice(0, 200);
    console.log('wf1489 r1-attest-2:', JSON.stringify({ realWindow: real.label, shiftedWindow: words[0].label, observedAt: String(window.endMs), close: String(close), status: r.status, text }));
    assert.equal(real.label, 'Up');
    assert.equal(words[0].label, 'Down');
    assert.ok(r.status >= 400, `the seat held an outcome observed ${shift} ms after the round's window ended: ${r.status} ${text}`);
  } finally { await w.close(); }
});
