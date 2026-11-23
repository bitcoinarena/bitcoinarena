// kanban #3311: the card's test (audit nostr a5-2-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// AUDIT nostr round 2 (#1): the zap address's plain-tip callback spawns an UNBOUNDED number of concurrent
// `lncli lookupinvoice` children.
//
// serveZapAddresses bounds how many invoices are MINTED at once: `strangersMinting < ZAP_MINTING_MAX` (kanban #2302,
// "each an lncli addinvoice child"), and how many per asker per window (mayMint, kanban #1964/#1801). But the plain-tip
// path, once ONE invoice of (asker, name, amount) is open with more than half its life left, answers every further
// callback GET by first calling `lookup({ name, paymentHash })` - in the real node (tools/zap-address.mjs) an
// `lncli lookupinvoice` execFile child - and returning the kept invoice, WITHOUT ever consulting mayMint or
// strangersMinting. So a stranger mints one tip invoice (one mint, well inside the caps) and then fires any number of
// concurrent callback GETs for that same (name, amount): each spawns one lookup child, with no bound at all, for the
// first ~half of the invoice's hour. That is the very lncli-fork flood #2302 bounded for mints, left open on the lookup
// path.
//
// SAFE behaviour asserted here: the concurrent backend (lncli) calls a stranger can drive through the tip door are
// bounded like the mint path is (at most ZAP_MINTING_MAX in flight at once). On BASE the kept-tip branch runs one
// lookup per concurrent request with no cap, so the peak is the whole flood and this FAILS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serveZapAddresses, ZAP_MINTING_MAX } from '../src/zap-address.js';

const curve = {
  pointX: (s) => schnorr.getPublicKey(s),
  signSchnorr: (m, s) => schnorr.sign(m, s),
  verify: (sig, m, k) => schnorr.verify(sig, m, k),
};
const secret = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const STRANGER = '203.0.113.9';           // a public address the proxy in front reports: ownTool() is false
const NAME = 'alice';
const AMOUNT = 5000;                        // msat, inside the default 1000..100000000 sendable range
const FLOOD = 40;

test("a stranger's repeated tip-callback GETs do not spawn unbounded concurrent lncli lookups", async () => {
  let mints = 0, inFlight = 0, peakLookups = 0;
  const served = await serveZapAddresses({
    publicHost: 'tips.example.com', names: [NAME], secret, curve,
    // the mint: a plausible bolt11 and a fresh payment hash (not validated on the tip path)
    invoice: async ({ amountMsat }) => { mints++; return { request: `lnbc${amountMsat}n1pfake`, paymentHash: `${(mints).toString(16).padStart(2, '0')}`.repeat(32) }; },
    // the lookup: in the real node an `lncli lookupinvoice` child - here it counts how many run at once
    lookup: async () => { inFlight++; peakLookups = Math.max(peakLookups, inFlight); try { await delay(120); return { settled: false }; } finally { inFlight--; } },
  });
  const base = `http://127.0.0.1:${served.port}`;
  const get = (qs) => fetch(`${base}/.well-known/lnurlp/${NAME}/cb?${qs}`, { headers: { 'x-forwarded-for': STRANGER } });
  try {
    // 1) one tip invoice is minted (the only mint the stranger needs; well inside every mint cap)
    const first = await (await get(`amount=${AMOUNT}`)).json();
    assert.ok(first.pr, `the first tip call should mint an invoice, got ${JSON.stringify(first)}`);
    assert.equal(mints, 1);

    // 2) the stranger now fires a burst of callback GETs for the SAME (name, amount): each hits the kept-invoice branch
    const answers = await Promise.all(Array.from({ length: FLOOD }, () => get(`amount=${AMOUNT}`).then((r) => r.json())));
    assert.ok(answers.every((a) => a.pr), 'every burst call is answered with the kept invoice');
    assert.equal(mints, 1, 'no new invoice is minted - all answered from the kept one');

    // SAFE: the concurrent lncli calls a stranger can drive through this door are bounded, as the mint path is.
    assert.ok(peakLookups <= ZAP_MINTING_MAX,
      `the kept-tip branch ran ${peakLookups} concurrent lncli lookupinvoice children for one stranger's ${FLOOD} callback GETs `
      + `(mints bounded at ${ZAP_MINTING_MAX}, lookups unbounded): an lncli-fork flood past the #2302 bound`);
  } finally {
    await served.close();
  }
});
