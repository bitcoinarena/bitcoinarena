// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-31 skeptic 2 (#1515, attacker: ONE SEAT the page reads, not the attestors' seats): the seats now refuse an
// Up/Down attestation observed at another moment than the round's window end (server.js holdOutcome, attested.js attestationTimely).
// The PAGE does not: btc-updown/page/market-page.js asks every seat GET /outcome, takes the answer holding its pick's row, and checks
// its attestation with checkMarketOutcome -> checkAttestation (attestationStands only: round, outcome, signatures). One lying seat
// that listed the round with a shifted close (so the honest attestors signed the shifted window - the #1515 attack) answers ATTESTED,
// final, with that attestation: the page shows the other window's outcome as VERIFIED and keeps it for good (market-page.js line 47:
// a final verified answer is never read again, on a reload either once kept), while every honest seat holds no outcome (VOID).
// Safe: the page believes an attestation of a period market only when it was observed at the round's own window end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketForRound, checkMarketOutcome } from '../src/market.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { UPDOWN, UPDOWN_PERIOD_MS } from '../../arena-node/test/plugins/updown/index.js';
import { attestWindow, combine, verifyEd25519Word } from '../../arena-attestor/src/attestor.js';

const P = UPDOWN_PERIOD_MS;
const CLOSE = 2000n * P;
const rid = new Uint8Array(32).fill(0x5a);

test('wf1489 v1-refute-31 s2-1: the page does not verify an Up/Down attestation of a window shifted past its round\'s close', async () => {
  const samples = [];
  for (let t = CLOSE - P - 120000n; t <= CLOSE + 600000n; t += 10000n) samples.push({ atMs: t, price: t < CLOSE + 120000n ? 100000n : 90000n });
  const [A, B] = UPDOWN.attestors;
  const real = attestWindow({ samples, roundId: rid, window: { startMs: CLOSE - P, endMs: CLOSE }, attestor: A });
  const fake = CLOSE + 300000n;
  const words = [A, B].map((a) => attestWindow({ samples, roundId: rid, window: { startMs: fake - P, endMs: fake }, attestor: a }));
  const att = combine(words, { attestors: UPDOWN.attestors.map((x) => toHex(x.pubkey)), threshold: 2 });
  assert.ok(att, 'the two attestors that read the lying listing signed the shifted window');
  const market = marketForRound({ gameId: UPDOWN.registration.gameId, entryCloseMs: CLOSE }, { manifestBytes: encodeManifest(UPDOWN.registration.manifest) });
  assert.ok(market, 'the page reads the market from its manifest');
  const verify = (s, d, k) => verifyEd25519Word(s, d, k);
  const honest = await checkMarketOutcome({ outcome: { attestation: toHex(real.ok && combine([real, attestWindow({ samples, roundId: rid, window: { startMs: CLOSE - P, endMs: CLOSE }, attestor: B })], { attestors: UPDOWN.attestors.map((x) => toHex(x.pubkey)), threshold: 2 }).bytes) },
    market, roundIdHex: toHex(rid), entryCloseMs: String(CLOSE), verify });
  const lie = await checkMarketOutcome({ outcome: { state: 'ATTESTED', final: true, attestation: toHex(att.bytes) }, market, roundIdHex: toHex(rid), entryCloseMs: String(CLOSE), verify });
  console.log('wf1489 v1-refute-31 s2-1:', JSON.stringify({ real: real.label, shifted: words[0].label, honest: { v: honest.verified, label: honest.label }, lie: { v: lie.verified, label: lie.label, why: lie.why } }));
  assert.equal(real.label, 'Up');
  assert.equal(words[0].label, 'Down');
  assert.equal(honest.verified, true, `the honest attestation must still verify: ${honest.why}`);
  assert.equal(lie.verified, false, `the page shows "${lie.label}" as verified: an attestation observed ${Number(fake - CLOSE) / 1000} s after the round's window ended (its own outcome: ${real.label})`);
});
