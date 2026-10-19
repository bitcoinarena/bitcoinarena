// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TWO GATEWAYS THAT CAN ACTUALLY RECEIVE (M3, RULED the owner 2026-09-20 11:09 named pick A, and 19:xx pick (i)).
//
// The numbers in `LIVE` are not invented and are not a fixture anybody typed: they are what the two testnet4
// LND nodes reported after a real invoice was paid each way over channel dce6199b..., recorded in TASKBOOK.
// The test exists to stop the predicate drifting away from the pair it was written against - a green suite is
// not a substitute for the paid invoice, it is the guard that keeps the rule honest afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatewaysAreIndependent, GATEWAY_MIN_INBOUND_SAT } from '../src/gateways.js';

const A = '0274e26122c7b8fc11f6caaee03f8b639965ffb83196eb1a9aa1a281906898d6b9';
const B = '025f17c2563260049cbae649699fdcbdcd3706d7c298d2d2d4ce7e49bf529c4cc4';

/** What the pair reported on 2026-09-20 after both payments settled. */
const LIVE = [
  { identityPubkey: A, rpc: '127.0.0.1:11009', syncedToChain: true,
    channels: [{ active: true, remoteBalanceSat: 116530n }] },
  { identityPubkey: B, rpc: '127.0.0.1:11010', syncedToChain: true,
    channels: [{ active: true, remoteBalanceSat: 80000n }] },
];

test('the measured testnet4 pair is two independent gateways with inbound on each', () => {
  const r = gatewaysAreIndependent({ gateways: LIVE });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.usable, 2);
});

test('the state the pair was FOUND in is refused: node B had no inbound at all', () => {
  // Before either payment: A held 196530 of inbound, B held none. One gateway, not two.
  const found = [
    { ...LIVE[0], channels: [{ active: true, remoteBalanceSat: 196530n }] },
    { ...LIVE[1], channels: [{ active: true, remoteBalanceSat: 0n }] },
  ];
  const r = gatewaysAreIndependent({ gateways: found });
  assert.equal(r.ok, false);
  assert.equal(r.usable, 1, 'only A could receive');
  assert.match(r.why, /1 of 2/);
});

test('a channel nobody is home for holds no reachable inbound', () => {
  // A's channel carried 196530 sat of inbound for four days while its only peer was down: active false.
  const dark = LIVE.map((g) => ({ ...g, channels: g.channels.map((c) => ({ ...c, active: false })) }));
  const r = gatewaysAreIndependent({ gateways: dark });
  assert.equal(r.ok, false);
  assert.equal(r.usable, 0, 'an inactive channel cannot be paid, whatever it holds');
});

test('two labels on one node are one gateway, which is the fake the ruling forbids', () => {
  const twoHats = [LIVE[0], { ...LIVE[1], identityPubkey: A }];
  const r = gatewaysAreIndependent({ gateways: twoHats });
  assert.equal(r.ok, false);
  assert.match(r.why, /that is one node/);
});

test('and so are two entries answering at one rpc address', () => {
  const oneRpc = [LIVE[0], { ...LIVE[1], rpc: LIVE[0].rpc }];
  const r = gatewaysAreIndependent({ gateways: oneRpc });
  assert.equal(r.ok, false);
  assert.match(r.why, /that is one node/);
});

test('the same host is NOT a disqualification - both of ours run on the test host', () => {
  // The ruling is explicit: "same host is fine". Nothing in the rule reads a host, and this pins that.
  const sameHost = LIVE.map((g) => ({ ...g, host: 'test-host' }));
  assert.equal(gatewaysAreIndependent({ gateways: sameHost }).ok, true);
});

test('a node that is up but not caught up cannot be paid', () => {
  const behind = [LIVE[0], { ...LIVE[1], syncedToChain: false }];
  const r = gatewaysAreIndependent({ gateways: behind });
  assert.equal(r.ok, false);
  assert.equal(r.usable, 1);
});

test('the shape is guarded before the counting', () => {
  assert.equal(gatewaysAreIndependent({ gateways: [] }).ok, false);
  assert.equal(gatewaysAreIndependent({ gateways: LIVE, need: 1 }).ok, false, 'a paying round needs two');
  assert.equal(gatewaysAreIndependent({ gateways: [{ identityPubkey: 'nope' }] }).ok, false);
  assert.equal(GATEWAY_MIN_INBOUND_SAT, 1n);
});

test('a bigger appetite than the pair can receive is refused rather than rounded down', () => {
  const r = gatewaysAreIndependent({ gateways: LIVE, minInboundSat: 200000n });
  assert.equal(r.ok, false, 'neither side holds 200000 of inbound');
  assert.equal(r.usable, 0);
});
