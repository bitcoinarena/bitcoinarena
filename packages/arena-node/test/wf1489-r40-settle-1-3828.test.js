// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40-settle-1: A SEND PLAN'S INVOICE IS CHECKED BY WHO SIGNED IT, NOT BY WHETHER THE ADDRESS ISSUED IT.
// WinningsSend.check (the door POST /settle-sends) takes a seat's proposed send plan when its invoice has the amount, the address's
// LUD-06 description hash and the same payee node key as the invoice the address's callback answers this seat with (kanban #1154).
// A custodial or shared Lightning node (one node key for every account; NWC make_invoice and LNbits take any description_hash) signs
// invoices of EVERY account with that one key: a seat operator with an account on the donation recipient's node mints an invoice for
// his own account with the recipient's metadata hash and amount. Every seat's check passes, and the share is sent to him. From a seat of
// the round, a plan with a lower payment hash (ground by asking his node for invoices) even REPLACES the honest kept plan.
// kanban #3828 (RULED 2026-11-28): from DONATION_PROOF_VERSION a donation send needs the address's own LUD-21 verify proof for the plan's invoice,
// checked by every seat; unproven, the share is planned HELD; an older round as before.
// Safe: a send plan's invoice is one the address itself issued (e.g. LUD-21 verify for its payment hash); an invoice the address never
// handed out is refused, and never replaces a kept plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';
import { testInvoice } from './bolt11-fixture.js';
import { sha256, toHex } from '../../arena-protocol/src/hash.js';
import { sendableInvoiceMsat, DONATION_PROOF_VERSION } from '../../arena-protocol/src/winnings-send.js';

const GW = { url: 'http://gw-a.example/', live: true, lightningPublicKey: '02' + 'a1'.repeat(32), modulePublicKey: '02' + 'c3'.repeat(32),
  sendFeeDefault: { baseMsat: 0n, ppm: 0n }, expirationDeltaDefault: 144, expirationDeltaMinimum: 10 };
const HEIGHT = 1000;
const ADDRESS = 'devs@pay.example';
const METADATA = JSON.stringify([['text/plain', 'Donation to the developers'], ['text/identifier', ADDRESS]]);
const PAYOUT = 100000n;
const rid = new Uint8Array(32).fill(7);
const sendId = new Uint8Array(32).fill(9);

// `version`: the round's protocol version; `verify`: the address's callback answers a LUD-21 verify URL (on `verifyHost`) with each invoice
function setup({ version = DONATION_PROOF_VERSION, verify = true, verifyHost = 'pay.example' } = {}) {
  const answers = { verify };   // switched on later: the address starts offering LUD-21 verify
  const issued = [];   // payment hashes the address's callback handed out
  const invoices = new Map();   // hash -> the invoice it issued (what its verify URL answers)
  let n = 0;
  const lnurlFetch = async (url) => {
    if (url.includes('/.well-known/lnurlp/')) return new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://pay.example/cb/devs',
      metadata: METADATA, minSendable: 1000, maxSendable: 1e10 }));
    if (url.includes('/verify/')) {
      const h = url.split('/verify/')[1];
      return new Response(JSON.stringify(invoices.has(h) ? { status: 'OK', settled: false, preimage: null, pr: invoices.get(h) } : { status: 'ERROR', reason: 'Not found' }));
    }
    const amount = BigInt(new URL(url).searchParams.get('amount'));
    const hash = sha256(new TextEncoder().encode(`honest-${n++}`));
    issued.push(toHex(hash));
    const pr = testInvoice({ amountMsat: amount, paymentHash: hash, descriptionHash: sha256(new TextEncoder().encode(METADATA)) });
    invoices.set(toHex(hash), pr);
    return new Response(JSON.stringify({ pr, routes: [], ...(answers.verify ? { verify: `https://${verifyHost}/verify/${toHex(hash)}` } : {}) }));
  };
  const rows = [];
  const round = {
    get: () => null,
    lockSettlement: () => null,
    sendAttemptsOf: () => rows,
    sendPlansOf: () => rows,
    rowOf: () => null,
    putSendPlan: (r) => { const i = rows.findIndex((x) => toHex(x.entryId) === toHex(r.entryId) && x.attempt === r.attempt); if (i >= 0) rows.splice(i, 1); rows.push({ state: 'PLANNED', ...r }); },
    dropPlannedSends: () => { const k = rows.length; rows.length = 0; return k; },
  };
  const port = { gateways: async () => ({ gateways: [GW], height: HEIGHT }), fees: async () => ({ ppm: 0n, baseMsat: 0n }) };
  const w = new WinningsSend({ round, port, network: 'regtest', lnurlFetch, localHosts: ['pay.example', 'evil.example'], versionOf: () => version, peersFor: () => [], fetcher: async () => new Response('', { status: 500 }) });
  const base = { plan: { payouts: [{ kind: 'donation', donation: { id: sendId, lnurl: ADDRESS }, msat: PAYOUT, owedMsat: PAYOUT, pubkey: sendId }] }, entryOf: new Map() };
  return { w, base, issued, rows, invoices, answers };
}

const planWith = (paymentHash, extra = {}) => [{ entry: toHex(sendId), attempt: 0, address: ADDRESS,
  invoice: testInvoice({ amountMsat: sendableInvoiceMsat(PAYOUT, GW.sendFeeDefault), paymentHash, descriptionHash: sha256(new TextEncoder().encode(METADATA)) }),
  paymentHash: toHex(paymentHash), gatewayUrl: GW.url, gatewayPk: GW.modulePublicKey, expiration: String(HEIGHT + GW.expirationDeltaDefault), ...extra }];

test('r40-settle-1 / #3828 new version: a send plan whose invoice the address never issued (same shared node key) is refused, with or without a verify URL', async () => {
  const { w, base, issued } = setup();
  const attackerHash = new Uint8Array(32);   // lowest possible hash: also sorts below any honest plan
  const got = await w.check(rid, base, planWith(attackerHash), { from: '02' + '55'.repeat(32) });
  const withVerify = await w.check(rid, base, planWith(attackerHash, { verify: `https://pay.example/verify/${toHex(attackerHash)}` }), { from: '02' + '55'.repeat(32) });
  // a verify URL of an invoice the address did issue, under the attacker's plan: another `pr`
  const honest = await w.invoiceFor(ADDRESS, sendableInvoiceMsat(PAYOUT, GW.sendFeeDefault));
  const borrowed = await w.check(rid, base, planWith(attackerHash, { verify: `https://pay.example/verify/${honest.paymentHash}` }), { from: '02' + '55'.repeat(32) });
  const otherHost = await w.check(rid, base, planWith(attackerHash, { verify: `https://evil.example/verify/${toHex(attackerHash)}` }), { from: '02' + '55'.repeat(32) });
  console.log('  MEASURED #3828 fresh seat:', JSON.stringify({ none: got.why, withVerify: withVerify.why, borrowed: borrowed.why, otherHost: otherHost.why, planHashIssued: issued.includes(toHex(attackerHash)) }));
  for (const x of [got, withVerify, borrowed, otherHost]) assert.equal(x.ok, false, 'a seat kept a send plan paying an invoice the donation address never issued');
  assert.match(got.why, /does not answer here: devs@pay\.example .*LUD-21/);
  assert.match(borrowed.why, /another invoice/);
  assert.match(otherHost.why, /not on the address's own host/);
});

test('r40-settle-1 / #3828 new version: an honest proven plan is kept, and a lower unproven plan does not replace it', async () => {
  const { w, base, issued, rows } = setup();
  const honest = await w.invoiceFor(ADDRESS, sendableInvoiceMsat(PAYOUT, GW.sendFeeDefault), { proof: true });
  assert.ok(honest.ok, honest.why);
  assert.match(honest.verify, /^https:\/\/pay\.example\/verify\//);
  const first = await w.check(rid, base, [{ ...planWith(new Uint8Array(32).fill(1))[0], invoice: honest.invoice, paymentHash: honest.paymentHash, verify: honest.verify }], { from: '02' + '11'.repeat(32) });
  assert.ok(first.ok, `the honest plan is kept: ${first.why}`);
  const second = await w.check(rid, base, planWith(new Uint8Array(32)), { from: '02' + '55'.repeat(32) });
  console.log('  MEASURED #3828 replace:', JSON.stringify({ ok: second.ok, why: second.why || null, kept: rows.map((r) => r.paymentHash.slice(0, 16)), keptIssuedByAddress: rows.every((r) => issued.includes(r.paymentHash)) }));
  assert.equal(second.ok, false);
  assert.ok(rows.length === 1 && rows.every((r) => issued.includes(r.paymentHash)), 'the kept send plan pays an invoice the donation address issued');
  assert.equal(rows[0].verify, honest.verify, 'the kept row keeps its verify URL');
});

test('#3828 new version: an address without LUD-21 verify gets its donation share planned HELD; the proposer\'s proven plan carries its verify URL', async () => {
  const bare = setup({ verify: false });
  const p = await bare.w.propose(rid, bare.base);
  assert.equal(p.ok, true, p.why);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].invoice, '', 'held: no invoice');
  assert.match(p.rows[0].why, /held/);
  const good = setup();
  const q = await good.w.propose(rid, good.base);
  assert.equal(q.ok, true, q.why);
  assert.ok(q.rows[0].invoice && /\/verify\//.test(q.rows[0].verify), 'a proven plan names its verify URL');
  // and a seat checks the proposer's proven plan as it is handed (its JSON form)
  const peer = setup();
  peer.invoices.set(q.rows[0].paymentHash, q.rows[0].invoice);
  const { sendPlanToJson } = await import('../src/winnings-send.js');
  const took = await peer.w.check(rid, peer.base, q.rows.map(sendPlanToJson), { from: '02' + '11'.repeat(32) });
  assert.equal(took.ok, true, took.why);
});

test('#3828 old version: no proof is asked - the plan the address never issued is kept, as before', async () => {
  const { w, base } = setup({ version: DONATION_PROOF_VERSION - 1, verify: false });
  const got = await w.check(rid, base, planWith(new Uint8Array(32)), { from: '02' + '55'.repeat(32) });
  assert.equal(got.ok, true, got.why);
  const p = setup({ version: DONATION_PROOF_VERSION - 1, verify: false });
  const q = await p.w.propose(rid, p.base);
  assert.ok(q.ok && q.rows[0].invoice && !q.rows[0].verify, 'an old round plans the invoice without a verify URL');
  const { sendPlanToJson } = await import('../src/winnings-send.js');
  assert.equal('verify' in sendPlanToJson(q.rows[0]), false, 'and its plan JSON (and so its plan id) is as before');
});

test('#3828 new version: a held donation share is sent later by the re-send path once the address proves its invoice', async () => {
  const x = setup({ verify: false });
  const p = await x.w.propose(rid, x.base);
  assert.equal(p.rows[0].invoice, '');
  const still = await x.w.proposeResend(rid, x.rows[0], {});
  assert.equal(still.ok, false, 'no proven invoice yet: nothing re-sent');
  assert.match(still.why, /LUD-21/);
  x.answers.verify = true;
  const re = await x.w.proposeResend(rid, x.rows[0], {});
  const r1 = x.rows.find((r) => r.attempt === 1);
  console.log('  MEASURED #3828 held then proven:', JSON.stringify({ still: still.why.slice(0, 120), resend: re.ok ? 'ok' : re.why.slice(0, 160), attempt1: !!r1, verify: r1 && r1.verify }));
  assert.ok(r1 && r1.invoice && /\/verify\//.test(r1.verify), 'attempt 1 is planned on the proven invoice, with its verify URL');
});
