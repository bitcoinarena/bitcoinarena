// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r11 nostr-1 (kanban #1489): THE ZAP ADDRESS DIALS ONLY PUBLIC RELAYS. A zap request's `relays` tag is the payer's own
// word; once the 1-sat zap is paid, the receipt is sent (tools/zap-address.mjs publish -> sendToRelay -> new WebSocket(url)) to
// every URL it names. A loopback, private or link-local host there makes the zap server open WebSocket upgrades (a GET with a
// chosen path) into its own machine and network - the internal-host guard every other outbound fetch got (#1511, #1919, #2236)
// is missing on this door. Safe: such a request is refused at the callback, or those relays are never handed to publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveZapAddresses, signNostr } from '../src/zap-address.js';
import { zapRequestTemplate } from '../../arena-protocol/src/zap.js';
import { curve, keyPair, fakeLightning } from './wf1489-r11-nostr-zapfix.js';

const INTERNAL = /^wss?:\/\/(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost\b|\[::1\]|0\.0\.0\.0)/i;

test('a paid zap never makes the zap server dial loopback / private / link-local relays', async () => {
  const ln = fakeLightning();
  const server = keyPair();
  const published = [];
  const z = await serveZapAddresses({ port: 0, publicHost: 'zap.example', names: ['bob'], secret: server.secret, curve, invoice: ln.invoice,
    lookup: ln.lookup, publish: async (e, relays) => published.push(relays), watchMs: 30 });
  try {
    const attacker = keyPair(), anyone = keyPair();
    const relays = ['ws://127.0.0.1:8080/v1/send', 'ws://169.254.169.254/latest/meta-data', 'ws://10.0.0.5:18789/', 'ws://localhost:9351/json/new'];
    const request = signNostr(zapRequestTemplate({ recipient: anyone.pubkey, amountMsat: 1000n, relays }), { secret: attacker.secret, curve });
    const said = await (await fetch(`http://127.0.0.1:${z.port}/lnurlp/bob/cb?amount=1000&nostr=${encodeURIComponent(JSON.stringify(request))}`)).json();
    if (!said.pr) return;   // refused at the callback: safe
    ln.payByRequest(said.pr); // the attacker pays 1 sat
    for (let i = 0; i < 100 && !published.length; i++) await new Promise((r) => setTimeout(r, 20));
    const dialed = published.flat().filter((u) => INTERNAL.test(u));
    console.log('relays handed to publish:', JSON.stringify(published));
    assert.deepEqual(dialed, [], `the receipt is sent to internal hosts: ${dialed.join(', ')}`);
  } finally { await z.close(); }
});

// kanban #2454: the relay rule the callback applies
test('#2454 only wss:// relays on a public name and the default port are kept', async () => {
  const { publicRelayUrl } = await import('../src/zap-address.js');
  for (const u of ['wss://relay.damus.io', 'wss://nos.lol/', 'wss://relay.example:443/x']) assert.equal(publicRelayUrl(u), true, u);
  for (const u of ['ws://relay.damus.io', 'wss://127.0.0.1', 'wss://localhost/', 'wss://10.0.0.5:18789/', 'wss://[::1]/', 'wss://box.local/',
    'wss://seat.internal/', 'wss://beelink.tail1234.ts.net/', 'wss://relay.example:8080/', 'wss://2130706433/', 'wss://a:b@relay.example/', 'nonsense'])
    assert.equal(publicRelayUrl(u), false, u);
});
