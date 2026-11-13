// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2602 (#1489 Lightning audit, finding 1): THE PAYOUT GATEWAY SETS ITS OWN FEE, UNBOUNDED.
// Winnings, donation shares and reserve payouts go through lowestLiveGateway - the lowest Lightning key among the federation's live
// gateways - at that gateway's own send_fee_default and expiration_delta_default from its routing_info. Nothing bounded either: one
// gateway with the lowest key (a key is ground in seconds) that answers ppm 900,000 took 47 % of every payout (the winner's invoice is
// the payout less that fee; the gateway claims the contract by paying the smaller invoice), and a reserve payout's contract grew by the
// same fee on top. The stock LNv2 client refuses such a gateway (send fee over 100 sat + 15,000 ppm, expiration delta over 1440 blocks);
// the committee builds its contracts itself and asked nothing. Now a gateway over those limits is not picked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lowestLiveGateway, sendableInvoiceMsat, sendPlanStands } from '../../arena-protocol/src/winnings-send.js';
import { contractForInvoice } from '../src/reserve-payout.js';

const greedy = { url: 'https://greedy.example/gateway/', live: true, lightningPublicKey: '02' + '00'.repeat(32), modulePublicKey: '02' + '11'.repeat(32),
  sendFeeDefault: { baseMsat: 0n, ppm: 900000n }, expirationDeltaDefault: 144, expirationDeltaMinimum: 72 };
const slow = { url: 'https://slow.example/gateway/', live: true, lightningPublicKey: '02' + '01'.repeat(32), modulePublicKey: '02' + '22'.repeat(32),
  sendFeeDefault: { baseMsat: 1000n, ppm: 1000n }, expirationDeltaDefault: 100000, expirationDeltaMinimum: 72 };
const honest = { url: 'https://honest.example/gateway/', live: true, lightningPublicKey: '03' + 'ff'.repeat(32), modulePublicKey: '03' + '33'.repeat(32),
  sendFeeDefault: { baseMsat: 2000n, ppm: 3000n }, expirationDeltaDefault: 144, expirationDeltaMinimum: 72 };

test('#2602 a gateway charging over the LNv2 send limit is never the payout gateway', () => {
  const payout = 100_000_000n;   // 100,000 sat
  const gw = lowestLiveGateway([greedy, honest]);
  assert.ok(gw, 'the honest gateway is still there to pay through');
  const invoice = sendableInvoiceMsat(payout, gw.sendFeeDefault);
  // through the greedy one the winner's invoice was 52,631,578 msat: 47 % of the payout went to the gateway
  assert.equal(gw.url, honest.url, `the payout went through ${gw.url}, leaving the winner ${invoice} of ${payout} msat`);
  assert.ok(invoice > payout - 2_000_000n, 'the winner keeps the payout less at most 100 sat + 1.5 %');
  // a reserve payout of 100,000 sat would have funded a contract of 1,000,000 sat through it
  assert.ok(contractForInvoice(payout, gw.sendFeeDefault) < payout + 2_000_000n);
});

test('#2602 a gateway naming an expiration delta over 1440 blocks is never the payout gateway', () => {
  assert.equal(lowestLiveGateway([slow, honest]).url, honest.url);
  assert.equal(lowestLiveGateway([greedy, slow]), null, 'no gateway within the limits: none, and the payout waits');
});

test('#2602 a signer refuses a send plan through the over-limit gateway', () => {
  const plan = { invoice: 'lnbc1', paymentHash: '00'.repeat(32), gatewayUrl: greedy.url, gatewayPk: greedy.modulePublicKey, expiration: 1000n };
  const r = sendPlanStands({ plan, payoutMsat: 100_000_000n, gateways: [greedy, honest], height: 900, metadata: '[]', network: 'testnet4', payee: '02' + 'ab'.repeat(32), payeeOf: () => '02' + 'ab'.repeat(32) });
  assert.equal(r.ok, false);
  assert.match(r.why, /honest\.example/, 'refused because the payout gateway is the honest one, not the greedy one');
});

test('#2602 the honest path is unchanged: within the limits the lowest key is picked', () => {
  const low = { ...honest, url: 'https://low.example/gateway/', lightningPublicKey: '02' + '05'.repeat(32), sendFeeDefault: { baseMsat: 100000n, ppm: 15000n }, expirationDeltaDefault: 1440 };
  assert.equal(lowestLiveGateway([honest, low]).url, low.url);
  assert.equal(lowestLiveGateway([{ ...honest, sendFeeDefault: null }]).url, honest.url, 'a gateway that names no fee charges none');
});
