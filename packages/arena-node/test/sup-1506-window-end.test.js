// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 (attack, one seat): A PERIOD MARKET'S OUTCOME FOR ANOTHER WINDOW IS TAKEN AS ITS OWN. The attestor daemon
// (arena-attestor bin tick/roundsOfGame) takes a round's window from the FIRST seat's GET /rounds listing (`entryCloseMs`, unsigned, never
// checked against the round contract) and signs { round, outcome over [close - 15 min, close], observed_at = close }. A seat checks the
// attestation (attestationStands: signatures; attestationTimely: observed_at >= resolve time, now < deadline) but never that observed_at
// IS the round's window end. So one seat listing the round with entryCloseMs shifted up to ~9.5 min later (the 600 s deadline), chosen
// after watching the price, makes the honest attestors sign the outcome of a window of its choosing, and every seat settles on it.
// Adapted to 1.9 by #2536 (kanban #1506): the fix takes the round's window as `window` (attestationTimely, passed by server.js's outcome
// door as marketWindowOf's window); the card's test called it without one. The same shifted-window attestation, checked as the door checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPDOWN, UPDOWN_PERIOD_MS, UPDOWN_TERMS } from './plugins/updown/index.js';
import { attestWindow, verifyEd25519Word } from '../../arena-attestor/src/attestor.js';
import { attestationStands, attestationTimely, marketWindowOf } from '../../arena-protocol/src/attested.js';

const P = UPDOWN_PERIOD_MS;
const CLOSE = 100n * P;                       // the round's real window: [CLOSE - P, CLOSE]
const rid = new Uint8Array(32).fill(0x77);
const manifest = UPDOWN.registration.manifest;

test('#1506 (1.9) wf1489-2: a seat takes an Up/Down outcome only as observed at the round\'s own window end', () => {
  // THE PRICE: flat at $1000.00 through the real window (a tie: Up), falling to $900.00 from 2 minutes after the close
  const samples = [];
  for (let t = CLOSE - P - 120000n; t <= CLOSE + 600000n; t += 10000n) samples.push({ atMs: t, price: t < CLOSE + 120000n ? 100000n : 90000n });
  const [A, B] = UPDOWN.attestors;
  const real = attestWindow({ samples, roundId: rid, window: { startMs: CLOSE - P, endMs: CLOSE }, attestor: A });
  // ONE SEAT LISTS THE ROUND WITH entryCloseMs = CLOSE + 300 s: both attestors that read that listing sign THAT window
  const fake = CLOSE + 300000n;
  const words = [A, B].map((a) => attestWindow({ samples, roundId: rid, window: { startMs: fake - P, endMs: fake }, attestor: a }));
  const att = { ...words[0].body, signatures: words.map((w) => ({ key: Buffer.from(w.key, 'hex'), signature: Buffer.from(w.signature, 'hex') })) };
  const contract = { entryCloseMs: CLOSE };
  const stands = attestationStands(att, { manifest, roundIdBytes: rid, verify: verifyEd25519Word, round: contract });
  const window = marketWindowOf({ entryCloseMs: CLOSE }, manifest).window;
  // 1.9 checks observed_at against the round's own window end when the seat hands the window (server.js outcome door: grid.window)
  const timely = attestationTimely(att, { entryCloseMs: CLOSE, nowMs: fake + 20000n, terms: UPDOWN_TERMS, window });
  const facts = { real: real.label, signed: words[0].label, observedAt: String(att.observedAtMs), windowEnd: String(window && window.endMs), stands: stands.ok, timely: timely.ok, why: timely.why };
  console.log('  wf1489-2:', JSON.stringify(facts));
  assert.equal(real.label, 'Up');
  assert.equal(words[0].label, 'Down');
  assert.equal(stands.ok, true);
  // SAFE: an outcome observed at another moment than the round's window end is not the outcome of this round
  assert.equal(timely.ok, false, `a seat takes "${words[0].label}" observed at ${att.observedAtMs}, ${Number(att.observedAtMs - CLOSE) / 1000} s after the round's window ended (its own outcome: ${real.label})`);
});
