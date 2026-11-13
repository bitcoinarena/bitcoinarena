// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 audit44 refute of #1679 (skeptic 2): SIGNED BOUNTY REPORTS LOST THEIR FIRST-REPORT RESERVE. d2a6d2ea3 gave signed reports their own day
// budget FEEDBACK_SIGNED_PER_DAY (1000) and refuses at it with no first-report reserve. A signed report costs a stranger nothing (any fresh Nostr key; one
// event may even be posted again and is counted again). Ten IPv4 /24s (twenty addresses: ten small VPSs, or a few dollars of proxies) post 50 signed
// reports each - 100 per /24, 1000 in all - and an honest player's first signed report of the day is refused. On 90d57151a the same twenty addresses
// left the honest first report taken (the shared count had the 1000 reserve); the bar for the bounty door fell from forty addresses to twenty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackDecide } from '../src/faucet.js';

test('#1489-a44-45-s2 twenty stranger addresses in ten /24s shut out an honest first SIGNED report', () => {
  const log = [], nowMs = Date.now();
  let took = 0;
  for (let n = 0; n < 10; n++) for (const host of [10, 20]) for (let i = 0; i < 50; i++) {
    const ip = `203.0.${n}.${host}`;
    const d = feedbackDecide({ text: `signed junk ${n}-${host}-${i}`, ip, signed: true, nowMs }, log);
    if (d.ok) { log.push({ ip, atMs: nowMs, signed: true }); took++; }
  }
  const honest = feedbackDecide({ text: 'The deposit screen stays on "waiting" after the payment went through.', ip: '198.51.100.7', signed: true, nowMs }, log);
  console.log('  MEASURED:', JSON.stringify({ strangerSignedTaken: took, strangerAddresses: 20, strangerNets24: 10, honest: { ok: honest.ok, why: honest.why } }));
  assert.equal(honest.ok, true, `an honest address's first signed report of the day is taken (got: ${honest.why})`);
});
