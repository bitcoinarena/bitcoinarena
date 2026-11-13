// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2162 (#1489 a44-refute-56-s1, refuting #1754), adapted to 1.9 by #2536: 1000 keyless GETs to /lnurlp/<name>/cb filled the plain
// tip cap (ZAP_TIPS_OPEN_MAX) and every honest tip was refused for the invoices' hour. 1.9 keeps tips per asker|name|amount, drops the
// oldest past ZAP_TIPS_KEPT (no refusal for a full map), hands a looped URL its open invoice again, and bounds what one asker (and all
// proxied askers together, ZAP_MINTS_ALL) mints per window. The same flood, every way it can be sent: from one address behind the proxy,
// from the host itself with a distinct amount each time (no mint bound at all), and the honest path after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, ZAP_TIPS_KEPT, ZAP_MINTS_PER_ASKER } from '../src/zap-address.js';
import { testInvoice } from './bolt11-fixture.js';

const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());
const curve = { pointX: (s) => schnorr.getPublicKey(s), signSchnorr: (m, s) => schnorr.sign(m, s), verify: (sig, m, k) => schnorr.verify(sig, m, k) };
const FLOOD = 1000;

async function stand({ failFirst = 0 } = {}) {
  const lnd = { minted: 0, fail: failFirst, paid: new Set(), open: [] };
  const z = await serveZapAddresses({ publicHost: 'zap.example', names: ['bob'], secret: schnorr.utils.randomSecretKey(), curve,
    invoice: async ({ amountMsat, descriptionHash }) => {
      if (lnd.fail > 0) { lnd.fail--; throw new Error('lnd down'); }
      lnd.minted++; const paymentHash = sha(randomBytes(32)); const h = Buffer.from(paymentHash).toString('hex'); lnd.open.push(h);
      return { request: testInvoice({ amountMsat, paymentHash, descriptionHash }), paymentHash: h };
    },
    lookup: async ({ paymentHash }) => ({ settled: lnd.paid.has(paymentHash) }), publish: async () => {}, watchMs: 3600000 });
  const tip = async (msat, ip = null, comment = null) => (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=${msat}${comment ? `&comment=${comment}` : ''}`,
    { headers: ip ? { 'cf-connecting-ip': ip } : {} })).json();
  return { z, tip, lnd };
}

test('#2162 (1.9): 1000 keyless GETs from one address behind the proxy do not lock out an honest tip', async () => {
  const w = await stand();
  try {
    let got = 0;
    for (let i = 0; i < FLOOD; i++) if ((await w.tip(1000 + i, '198.51.100.9')).pr) got++;
    const honest = await w.tip(21000, '203.0.113.7', 'thanks');
    console.log(`  FACTS: stranger invoiced ${got} of ${FLOOD} (bound ${ZAP_MINTS_PER_ASKER}), LND minted ${w.lnd.minted}`);
    assert.ok(honest.pr, `the honest tip was refused after ${FLOOD} keyless GETs: ${JSON.stringify(honest)}`);
  } finally { await w.z.close(); }
});

test('#2162 (1.9): 1000 keyless GETs of distinct amounts with no mint bound fill the tip map past ZAP_TIPS_KEPT, and an honest tip is still invoiced', async () => {
  const w = await stand();
  try {
    let got = 0;
    for (let i = 0; i < FLOOD; i++) if ((await w.tip(1000 + i)).pr) got++;
    const honest = await w.tip(21000, null, 'thanks');
    console.log(`  FACTS: invoiced ${got} of ${FLOOD} (tips kept ${ZAP_TIPS_KEPT}), honest ${honest.pr ? 'invoiced' : JSON.stringify(honest)}`);
    assert.equal(got, FLOOD);
    assert.ok(honest.pr, `the honest tip was refused: ${JSON.stringify(honest)}`);
    const again = await w.tip(21000, null, 'thanks');
    assert.equal(again.pr, honest.pr, 'the same tip asked again gets its open invoice again');
    w.lnd.paid.add(w.lnd.open[w.lnd.open.length - 1]);
    const after = await w.tip(21000, null, 'thanks');
    assert.ok(after.pr && after.pr !== honest.pr, 'a paid tip invoice is never handed out again');
  } finally { await w.z.close(); }
});

test('#2162 (1.9): honest tips at once all get invoices, and failed mints leave nothing held', async () => {
  const w = await stand();
  try {
    assert.ok((await w.tip(1000)).pr);
    const many = await Promise.all(Array.from({ length: 16 }, (_, i) => w.tip(2000 + i)));
    assert.equal(many.filter((j) => j.pr).length, 16);
    w.lnd.fail = 20; for (let i = 0; i < 20; i++) await w.tip(5000 + i);
    assert.ok((await w.tip(9000)).pr, 'minting slots leaked after failures');
  } finally { await w.z.close(); }
});
