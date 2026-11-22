// kanban #1489 audit r1-find-attest, finding 2: A SEAT TAKES AN ATTESTATION OBSERVED AT ANY MOMENT AFTER THE RESOLUTION TIME.
// attestationTimely (the POST /outcome check) asks only observed_at >= resolveAt and now < deadline. For BTC Up or Down 15m
// (resolveAfterCloseMs 0, deadline 10 min) an attestation of the window ending 5 minutes after the round's close - another
// question than the one the round asked - is taken, so whoever steers when the attestors sign (finding 1: one seat's listing)
// picks the outcome. SAFE: a market with a resolution time takes only an outcome observed AT that time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationTimely } from '../src/attested.js';

test('an attestation of a window that ends 5 min after the round\'s resolution time is not this round\'s outcome', () => {
  const close = 1794648600000n;
  const terms = { resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n };
  const real = attestationTimely({ observedAtMs: close }, { entryCloseMs: close, nowMs: close + 360000n, terms });
  assert.equal(real.ok, true);
  const shifted = attestationTimely({ observedAtMs: close + 300000n }, { entryCloseMs: close, nowMs: close + 360000n, terms });
  assert.equal(shifted.ok, false, 'an outcome observed 5 min after the resolution time was taken as the round\'s');
});
