// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1156 MEASURE: what an outsider's POST /reserve-payout/record does to seven guardian seats (the test world of
// reserve-payout-fixture.js). Run with the module to measure, e.g. the source before the fix:
//   node packages/arena-node/tools/measure-1156.mjs [path/to/reserve-payout.js]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { world, invoiceOf, rand, METADATA, PROPOSAL, FED } from '../test/reserve-payout-fixture.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const mod = await import(pathToFileURL(resolve(process.argv[2] || new URL('../src/reserve-payout.js', import.meta.url).pathname)).href);
const { createReservePayouts, PAYOUT, planIdOf } = mod;
const say = (k, v) => console.log(`#1156 ${k.padEnd(52)} ${v}`);
console.log(`#1156 module ${process.argv[2] || 'src/reserve-payout.js'}`);

// 1. AN OUTSIDER'S SHORT for the passed proposal, posted to every seat; then the coordinator's pass
{
  const w = world({ create: createReservePayouts });
  const said = [];
  for (const s of w.seats) said.push((await s.api.learn({ proposal: PROPOSAL, state: PAYOUT.SHORT, why: 'forged', federation: FED })).ok);
  say('outsider SHORT kept by seats', `${said.filter(Boolean).length} of 7`);
  const out = await w.seats[0].api.round({ height: 500 });
  say('coordinator pass at the decision height', out.length ? out.map((x) => x.state || x.why).join(',') : 'nothing done (skipped as SHORT)');
  say('gateway payments for the passed proposal', w.fed.payments.length);
}
// 2. AN OUTSIDER'S PAID with its own invoice and preimage, built from public data
{
  const ref = world({ create: createReservePayouts });
  await ref.seats[0].api.round({ height: 500 });
  const pub = ref.seats[0].api.stateOf(PROPOSAL).plan;
  const w = world({ create: createReservePayouts });
  const pre = rand(32);
  const plan = { ...pub, invoice: invoiceOf(70000000n, sha256(pre), METADATA), paymentHash: toHex(sha256(pre)) };
  const kept = [];
  for (const s of w.seats) kept.push((await s.api.learn({ proposal: PROPOSAL, planId: planIdOf(plan), federation: FED, state: PAYOUT.PAID, plan, txid: 'ee'.repeat(32), preimage: toHex(pre) })).ok);
  say('outsider PAID (own invoice) kept by seats', `${kept.filter(Boolean).length} of 7`);
  say('reserve outputs marked spent on seat 3', w.seats[3].api.spent().size);
  const out = await w.seats[0].api.round({ height: 500 });
  say('coordinator pass after it', out.length ? out.map((x) => x.state || x.why).join(',') : 'nothing done (skipped as PAID)');
  say('gateway payments for the passed proposal', w.fed.payments.length);
}
