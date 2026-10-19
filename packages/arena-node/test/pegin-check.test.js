// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PEG-IN MISS OF 2026-09-28 CANNOT HAPPEN AGAIN (2026-09-29 12:25, PEGIN-WATCH-1225).
//
// The configs are the real ones (fixtures/pegin-configs.json): gateway B's stale client config for 337ae01a that
// derived tb1q05fn, its config after the rejoin, and the running federation's. The case that happened - a confirmed
// peg-in to the stale address, 0 msat, same federation id, other keys - is a mismatch at once, never "waiting", and
// it names both key prefixes and both addresses. A peg-in to the current config's address still waits for its credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { peginVerdict, configFacts } from '../src/pegin-check.js';

const F = JSON.parse(readFileSync(new URL('./fixtures/pegin-configs.json', import.meta.url)));

test('the fixtures are the miss: one federation id, other guardian keys, finality 2 against 100', () => {
  const stale = configFacts(F.staleGateway); const fed = configFacts(F.federation); const now = configFacts(F.currentGateway);
  assert.equal(stale.keys['0'].slice(0, 8), '0383be7e');
  assert.equal(fed.keys['0'].slice(0, 8), '027acbea');
  assert.deepEqual([stale.finality, fed.finality], [2, 100]);
  assert.deepEqual(now, fed, 'the rejoined gateway holds the running federation\'s config');
});

test('a confirmed peg-in to the stale address with 0 msat is a MISMATCH now, not waiting, and names both keys and both addresses', () => {
  // at 40 confirmations, as the watcher first saw 9d68228c - and the stale client itself did derive that address
  for (const derivedByGateway of [true, null, false]) {
    const v = peginVerdict({ federation: F.federation, gateway: F.staleGateway, address: F.staleAddress,
      currentAddress: F.currentAddress, derivedByGateway, confirmations: 40, balanceMsat: 0n, wantMsat: 10068942n });
    assert.equal(v.state, 'mismatch', `derivedByGateway ${derivedByGateway}: ${v.why}`);
    assert.match(v.why, /0383be7e/); assert.match(v.why, /027acbea/);
    assert.match(v.why, /02d3691c/); assert.match(v.why, /03d0720e/);
    assert.match(v.why, /finality 2 at the gateway, 100 at the federation/);
    assert.ok(v.why.includes(F.staleAddress) && v.why.includes(F.currentAddress), 'both addresses are named');
    assert.doesNotMatch(v.why, /confirmations/, 'no confirmation count is offered as progress');
  }
});

test('after the rejoin, the stale address is still a mismatch: the current gateway did not derive it', () => {
  const v = peginVerdict({ federation: F.federation, gateway: F.currentGateway, address: F.staleAddress,
    currentAddress: F.currentAddress, derivedByGateway: false, confirmations: 101, balanceMsat: 0n, wantMsat: 10068942n });
  assert.equal(v.state, 'mismatch');
  assert.match(v.why, /not derived by the gateway's current client/);
  assert.ok(v.why.includes(F.staleAddress) && v.why.includes(F.currentAddress));
});

test('a peg-in to the current config\'s address waits for its credit, and is credited once the balance is there', () => {
  const base = { federation: F.federation, gateway: F.currentGateway, address: F.currentAddress,
    currentAddress: F.currentAddress, derivedByGateway: true, wantMsat: 10068942n };
  const w = peginVerdict({ ...base, confirmations: 11, balanceMsat: 0n });
  assert.equal(w.state, 'waiting');
  assert.match(w.why, /11 of 100 confirmations/);
  assert.equal(peginVerdict({ ...base, confirmations: 101, balanceMsat: 150000000n }).state, 'credited');
  // the gateway not asked is not "waiting" either
  assert.equal(peginVerdict({ ...base, derivedByGateway: null, confirmations: 11, balanceMsat: 0n }).state, 'unchecked');
});
