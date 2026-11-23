// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { amberRelay, amberUi, checkAmber } from '../tools/compat-amber.mjs';

test('loopback relay delivers genuine encrypted signer traffic and rejects forged events', async () => {
  const relay = await amberRelay();
  const ws = new WebSocket(relay.url);
  await new Promise((resolve) => ws.once('open', resolve));
  const next = () => new Promise((resolve) => ws.once('message', (m) => resolve(JSON.parse(m))));
  try {
    const eose = next();
    ws.send(JSON.stringify(['REQ', 'signer', { kinds: [24133], '#p': ['receiver'] }]));
    assert.deepEqual(await eose, ['EOSE', 'signer']);
    const event = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', 'receiver']], content: 'encrypted' }, generateSecretKey());
    const bad = next();
    ws.send(JSON.stringify(['EVENT', { ...event, content: 'tampered' }]));
    assert.equal((await bad)[2], false);
    const delivered = [];
    const received = new Promise((resolve) => ws.on('message', (m) => { delivered.push(JSON.parse(m)); if (delivered.length === 2) resolve(); }));
    ws.send(JSON.stringify(['EVENT', event]));
    await received;
    assert.deepEqual(delivered.find((m) => m[0] === 'EVENT'), ['EVENT', 'signer', JSON.parse(JSON.stringify(event))]);
    assert.equal(delivered.find((m) => m[0] === 'OK')[2], true);
  } finally { ws.terminate(); await relay.close(); }
});

test('Android UI labels decode XML and missing explicit emulator is refused before any Android command', async () => {
  const nodes = amberUi('<hierarchy><node text="Approve &amp; sign" bounds="[0,0][100,100]" class="android.widget.Button" /></hierarchy>');
  assert.equal(nodes[0].text, 'Approve & sign');
  await assert.rejects(checkAmber({ serial: 'physical-device' }), /dedicated emulator/);
});

test('released Amber APK: clean UI onboarding, pairing and real NIP-46 calls', {
  skip: !process.env.COMPAT_AMBER_INTEGRATION, timeout: 300000,
}, async () => {
  const out = await checkAmber();
  assert.match(out.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(out.checks, { connect: 'ok', get_public_key: 'ok', 'sign_event 27235': 'ok', 'sign_event 30078': 'ok', 'nip44 to self': 'ok' });
});
