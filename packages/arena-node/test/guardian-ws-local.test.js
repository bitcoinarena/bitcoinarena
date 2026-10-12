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
