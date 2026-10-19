// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVNET'S PORTS (PLATFORM-RESEARCH item 15; tools/devnet-plan.mjs): one base, every port derived from it,
// all private and below 32768, none of the live stacks'; what listens read from either ss or lsof; the devnet's own running
// parts never counted as a clash against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devnetPorts, forbiddenWhy, parseListening, clashes, portsOfPart, NODE_COUNT } from '../tools/devnet-plan.mjs';

test('the default base: the chain, the control door, seven nodes and their guardians, all below 32768', () => {
  const p = devnetPorts();
  assert.equal(p.base, 24000);
  assert.equal(p.rpc, 24001);
  assert.equal(p.control, 24005);
  assert.deepEqual([p.zmqBlock, p.zmqTx], [24006, 24007]);
  assert.deepEqual(p.lnd.a, { rpc: 24010, p2p: 24011, rest: 24012 });
  assert.deepEqual(p.gateway.b, { api: 24040, iroh: 24041, metrics: 24042 });
  assert.deepEqual(p.nodes, [24100, 24110, 24120, 24130, 24140, 24150, 24160]);
  assert.deepEqual(p.guardians[0], { api: 25100, p2p: 26100, ui: 27100, metrics: 28100 });
  assert.equal(p.nodes.length, NODE_COUNT);
  const ports = p.all.map((x) => x.port);
  assert.equal(new Set(ports).size, ports.length, 'no port twice');
  assert.ok(ports.every((x) => x >= 1024 && x < 32768));
  assert.ok(ports.every((x) => forbiddenWhy(x) === null));
});

test('a base that lands on a live port, or past 32767, is refused by name', () => {
  assert.throws(() => devnetPorts(31121), /node 1 would be 31221, which testnet4 federation A seats holds/);
  assert.throws(() => devnetPorts(6100), /node 4 would be 6230, which testnet4 federation B seats holds/);
  assert.throws(() => devnetPorts(29000), /outside 1024 \.\. 32767/);
  assert.throws(() => devnetPorts(8079), /signal-cli/);
  assert.throws(() => devnetPorts('x'), /whole number/);
  assert.equal(forbiddenWhy(18789), 'OpenClaw');
  assert.equal(forbiddenWhy(33000), 'testnet4 guardians');
  assert.equal(forbiddenWhy(24100), null);
});

test('what listens: ss and lsof lines both read, the peer column never taken for a port', () => {
  const ss = [
    'LISTEN 0      4096       127.0.0.1:24101      0.0.0.0:*',
    'LISTEN 0      511                *:8080             *:*',
    'LISTEN 0      4096           [::1]:24001         [::]:*',
  ].join('\n');
  assert.deepEqual([...parseListening(ss)].sort(), [24001, 24101, 8080].sort());
  const lsof = [
    'COMMAND     PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node      74291 owner   20u  IPv4 0x1234567890      0t0  TCP 127.0.0.1:24221 (LISTEN)',
    'bitcoind   1234 owner   11u  IPv6 0x1234567891      0t0  TCP *:48343 (LISTEN)',
  ].join('\n');
  assert.deepEqual([...parseListening(lsof)].sort(), [24221, 48343].sort());
  assert.equal(parseListening('').size, 0);
});

test('a clash is a port of the plan that something else holds; a running part of the devnet is not one', () => {
  const p = devnetPorts(24000);
  const held = new Set([24001, 24110, 25110, 9999]);
  assert.deepEqual(clashes(p, held).map((x) => x.port).sort(), [24001, 24110, 25110]);
  const ours = new Set([...portsOfPart(p, 'bitcoind'), ...portsOfPart(p, 'node-2')]);
  assert.deepEqual(clashes(p, held, ours), []);
  assert.deepEqual(portsOfPart(p, 'node-2'), [24110, 25110, 26110, 27110, 28110]);
  assert.deepEqual(portsOfPart(p, 'runner'), [24005]);
  assert.deepEqual(portsOfPart(p, 'bitcoind'), [24001, 24002, 24006, 24007]);
  assert.deepEqual(portsOfPart(p, 'gateway-a'), [24030, 24031, 24032]);
  assert.deepEqual(portsOfPart(p, 'node-8'), []);
});
