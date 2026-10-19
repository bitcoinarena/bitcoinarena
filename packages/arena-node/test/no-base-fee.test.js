// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE DOES NOT SIT A ROUND AGAINST A FEDERATION THAT CHARGES A BASE FEE (§22A, FEDERATION.md item 4).
//
// The spec's own words: "The 2% stays. Fedimint's own base fees are 0: the federation runs with
// `disable_base_fees`. Lightning `min_htlc` / routing is not a federation fee." And 2026-09-15 07:44
// says the same thing as a ruling.
//
// WHY IT MATTERS ON THE NODE AND NOT ONLY IN THE PAGE. A base fee comes out of EVERY input and output of the
// round's locks - the players' own pool - so it is not a cost of playing, it is a deduction from a stake
// somebody has already committed, for nothing the round asked for. The 2% node fee is inclusive and is paid
// to the round's sitting seats for work they did; a base fee is money the operator did not earn. The client
// already refuses to lock against such a federation (`page-lock.js`); until now nothing on the node did, so a
// signer node would have taken entries into a round whose stakes were being shaved on the way in and out.
//
// THE LAST TEST IS THE ONE THAT MATTERS: delete the call from `server.js` and it goes red. A green suite must
// not be able to hide a guard nobody calls - the fault this project found once already with
// `gatewaysAreIndependent`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationTakesNoBaseFee } from '../src/stake-lock-signer-node.js';
import { readFileSync } from 'node:fs';

const ppm = (base) => ({ ppm: 0n, baseMsat: base });

test('a federation with disable_base_fees is accepted', () => {
  const r = federationTakesNoBaseFee({ fees: ppm(0n) });
  assert.equal(r.ok, true, r.why);
  assert.match(r.why, /charges no base fee/);
});

test('a federation that charges a base fee is refused, and the refusal names the amount', () => {
  const r = federationTakesNoBaseFee({ fees: ppm(1000n) });
  assert.equal(r.ok, false, 'a base fee of 1000 msat was accepted');
  assert.equal(r.baseMsat, 1000n);
  assert.match(r.why, /1000 msat on every input and output/);
  assert.match(r.why, /disable_base_fees/);
  assert.match(r.why, /players' own pool/);
});

test('one millisatoshi is still a base fee', () => {
  // There is no threshold in the rule. Zero is zero.
  assert.equal(federationTakesNoBaseFee({ fees: ppm(1n) }).ok, false);
});

test('a per-million rate is not a base fee, so it is not refused here', () => {
  // §22A names the base fee. `min_htlc` and routing are explicitly NOT federation fees, and a ppm rate is
  // sized by the amount rather than taken off every input and output; the fee-lock gate already reasons
  // about whether a lock still pays under it.
  assert.equal(federationTakesNoBaseFee({ fees: { ppm: 10000n, baseMsat: 0n } }).ok, true);
});

test('AN UNKNOWN RULE IS NOT A BASE FEE, and is not turned into a refusal', () => {
  // The client's own case: "no fee rule known: no lock". A port that answers nothing must not become an
  // accusation - the round simply mints no fee lock, as before.
  for (const nothing of [null, undefined, {}, { ppm: 0n }, { baseMsat: 5 }, 'none']) {
    const r = federationTakesNoBaseFee({ fees: nothing });
    assert.equal(r.ok, true, `an unknown fee rule ${String(nothing && nothing.baseMsat)} was read as a base fee`);
  }
});

test('THE CALL SITE ITSELF: delete it from server.js and this goes red', () => {
  // The predicate is worth nothing if no door asks it. This reads the server and insists the entry path -
  // the one place a stake is taken into a round - both imports it and calls it, and refuses on the answer.
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*federationTakesNoBaseFee[^}]*\} from '\.\/stake-lock-signer-node\.js'/,
    'server.js no longer imports the guard');
  assert.match(src, /federationTakesNoBaseFee\(\{\s*fees:/,
    'server.js no longer calls the guard - a round would be sat against a federation that charges a base fee');
  assert.match(src, /if \(!noBase\.ok\) return text\(res, 409,/,
    'server.js reads the guard but no longer refuses on it');

  // and it is asked on the ENTRY path, where a player's money is committed
  const entryDoor = src.indexOf("url.pathname === '/entry'");
  const call = src.indexOf('federationTakesNoBaseFee({ fees:', entryDoor);   // from the entry door: POST /round's own call is earlier
  const entered = src.indexOf('round.enter(contract)');
  assert.ok(entryDoor > 0 && call > entryDoor, 'the guard is not on the POST /entry path');
  assert.ok(call < entered, 'the guard is asked after the entry is already taken');
});
