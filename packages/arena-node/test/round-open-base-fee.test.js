// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAYING ROUND DOES NOT OPEN ON A FEDERATION THAT CHARGES A BASE FEE (FEDERATION.md item 4; §22A: "Fedimint's own base
// fees are 0: the federation runs with disable_base_fees"; RULED 2026-09-25: "POST /round must refuse a paying round
// whose federation charges a base fee, the same rule entry already enforces. Do not open it, do not store it, do not list
// it.").
//
// MEASURED before this test (2026-09-25): `/entry` refused a stake into such a round (federationTakesNoBaseFee, 409), but
// `POST /round` only counted the federation's gateways and never asked its fee rule - so the node opened, stored and listed
// a paying round that then refused every entry.
//
// Each case: the lock fixture's port, two distinct live gateways naming the round's federation; only the fee rule changes.
// The round is moved to the present (entry close ahead) so `GET /rounds` would list it if it were stored.
import { testNow } from './test-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32, presentDay } from './window-fixture.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

// A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25: every paying-round test gets a bonded chain view): the one
// daemon and a placeholder key, keyless, so the claim key is claimKeyFor's.
async function opened(feeRule, { noFees = false } = {}) {
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  if (noFees) delete port.fees; else port.feeRule = feeRule;
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: port, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']);
    const drafted = presentDay(base, testNow() + 300000);                 // entry closes ~74 s from now
    const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    const rid = roundId(c);
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });
    const why = (await r.text()).trim();
    const stored = d.round.get(rid);
    const listing = await (await fetch(`http://127.0.0.1:${d.port}/rounds`)).text();
    return { status: r.status, why, stored: !!stored, listed: listing.toLowerCase().includes(toHex(rid)) };
  } finally { await d.close(); }
}

test('1. a federation charging a base fee of 1000 msat: POST /round is 409, and the body names the base fee and that amount', async () => {
  const got = await opened({ ppm: 0n, baseMsat: 1000n });
  console.log('  FACTS (base fee 1000):', JSON.stringify(got));
  assert.equal(got.status, 409, got.why);
  assert.match(got.why, /charges a base fee of 1000 msat/);
});

test('2. that refused round is absent: not stored, not listed', async () => {
  const got = await opened({ ppm: 0n, baseMsat: 1000n });
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: false, listed: false });
});

test('3. a federation with no base fee opens the round, and it is listed', async () => {
  const got = await opened({ ppm: 0n, baseMsat: 0n });
  assert.equal(got.status, 201, got.why);
  assert.deepEqual({ stored: got.stored, listed: got.listed }, { stored: true, listed: true });
});

test('4. no fee rule known (the port has no fees) opens the round: an unknown rule is not a base fee', async () => {
  const got = await opened(null, { noFees: true });
  assert.equal(got.status, 201, got.why);
});

test('5. the POST /round handler calls federationTakesNoBaseFee before round.open(contract)', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("if (req.method === 'POST' && url.pathname === '/round')");
  const open = server.indexOf('round.open(contract)', start);
  const guard = server.indexOf('federationTakesNoBaseFee(', start);
  assert.ok(start >= 0 && open > start, 'no POST /round handler that opens a round');
  assert.ok(guard > start && guard < open, 'POST /round does not call federationTakesNoBaseFee before round.open(contract)');
});
