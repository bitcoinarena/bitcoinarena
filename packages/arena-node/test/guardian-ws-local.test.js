// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeGuardianSockets } from '../tools/guardian-ws-local.mjs';

test('a public guardian endpoint opens its local one; others are untouched', () => {
  const seen = [];
  const before = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { seen.push(url); } };
  try {
    assert.equal(routeGuardianSockets('wss://g.example/guardian-1=ws://127.0.0.1:32221/,wss://g.example/guardian-1/=ws://127.0.0.1:32221/'), 1);
    new globalThis.WebSocket('wss://g.example/guardian-1/');
    new globalThis.WebSocket('wss://g.example/guardian-1');
    new globalThis.WebSocket('wss://other.example/guardian-1/');
    assert.deepEqual(seen, ['ws://127.0.0.1:32221/', 'ws://127.0.0.1:32221/', 'wss://other.example/guardian-1/']);
  } finally { globalThis.WebSocket = before; }
});

test('unset, nothing is wrapped', () => {
  const before = globalThis.WebSocket;
  assert.equal(routeGuardianSockets(''), 0);
  assert.equal(globalThis.WebSocket, before);
});

// kanban #3893 (measured 2026-11-27 20:40Z on the old Mac): the bot's overrides name each endpoint twice, with and without a trailing
// slash, and the later pair won - wss://tn4.../fed2-N/guardian-next/ - which the fed2 seats' guardian path answers 400 (only the exact
// path upgrades). All seven guardians of 4dc88be7 failed, so its wallet could neither join anew ("Failed to download client config")
// nor claim a paid top-up ("no claim in 180 s"). A target with a path opens without the trailing slash; a bare host:port keeps its own.
test('#3893: a guardian path target opens without its trailing slash, whichever pair comes last', () => {
  const seen = [];
  const before = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { seen.push(url); } };
  try {
    routeGuardianSockets('wss://b.example/fed2-1/guardian-next=wss://tn4.example/fed2-1/guardian-next,wss://b.example/fed2-1/guardian-next/=wss://tn4.example/fed2-1/guardian-next/,'
      + 'wss://b.example/fed2-2/guardian-next=ws://127.0.0.1:11231/');
    new globalThis.WebSocket('wss://b.example/fed2-1/guardian-next');
    new globalThis.WebSocket('wss://b.example/fed2-1/guardian-next/');
    new globalThis.WebSocket('wss://b.example/fed2-2/guardian-next/');
    assert.deepEqual(seen, ['wss://tn4.example/fed2-1/guardian-next', 'wss://tn4.example/fed2-1/guardian-next', 'ws://127.0.0.1:11231/']);
  } finally { globalThis.WebSocket = before; }
});
