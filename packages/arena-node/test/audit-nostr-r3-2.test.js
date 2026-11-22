// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r3 (third pass) #2: the relay's only EVENT bound is 60 messages per 10 s PER SOCKET, sockets are free and not
// counted per address ("behind the tunnel every player comes from the same local address"), and every EVENT is verified
// (eventRefusal: sha256 + BIP-340 verify, ~1.2 ms) before anything else - also an exact copy of a frame already refused a moment
// ago. So one stranger who opens a few hundred sockets and writes ONE prebuilt frame (a well-formed kind 0 with a correct id and
// a junk signature) 60 times on each makes the relay do seconds of signature checks on its one event loop for a few hundred KB
// of traffic that cost him nothing to make; every other client's REQ (Nostr login's seed read, NIP-46, NWC) waits behind them.
// SAFE: an honest REQ on a socket opened before the flood is still answered (EOSE) within 1.5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { eventId } from '../src/nostr-relay.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOCKETS = 150, PER_SOCKET = 60;

const startRelayProcess = (dbPath) => new Promise((resolve, reject) => {
  // the relay as the host runs it (tools/nostr-relay.mjs), in its own process so the attacker's sends do not count against it
  const child = spawn(process.execPath, [join(here, '../tools/nostr-relay.mjs'), '0', dbPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    for (const line of buf.split('\n')) { try { const j = JSON.parse(line); if (j.step === 'up') return resolve({ child, port: j.port }); } catch { /* not yet */ } }
  });
  child.on('exit', (code) => reject(new Error(`relay exited ${code}`)));
});
const open = (port) => new Promise((x, y) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.on('open', () => x(ws)); ws.on('error', y); });

test('a stranger\'s junk-signature EVENT frames over many free sockets do not hold an honest REQ for seconds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-nostr-r3-2-'));
  const { child, port } = await startRelayProcess(join(dir, 'relay.db'));
  const socks = [];
  try {
    const honest = await open(port);
    socks.push(honest);
    // the honest REQ works before the flood
    const reqTime = () => new Promise((x) => {
      const sid = `s${Math.random().toString(36).slice(2, 8)}`, t0 = performance.now();
      const h = (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'EOSE' && m[1] === sid) { honest.off('message', h); x(performance.now() - t0); } };
      honest.on('message', h);
      honest.send(JSON.stringify(['REQ', sid, { kinds: [0], authors: ['a'.repeat(64)], limit: 1 }]));
    });
    const calm = await reqTime();
    // ONE frame, made once: a kind 0 with a correct id and a junk signature
    const e = { pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: 'x' };
    e.id = eventId(e); e.sig = 'ab'.repeat(64);
    const frame = JSON.stringify(['EVENT', e]);
    const attackers = await Promise.all(Array.from({ length: SOCKETS }, () => open(port)));
    socks.push(...attackers);
    for (const ws of attackers) for (let i = 0; i < PER_SOCKET; i++) ws.send(frame);
    await new Promise((r) => setTimeout(r, 200));   // the frames reach the relay
    const busy = await reqTime();
    console.log(`honest REQ: ${calm.toFixed(0)} ms calm, ${busy.toFixed(0)} ms under ${SOCKETS} x ${PER_SOCKET} junk frames (${(frame.length * SOCKETS * PER_SOCKET / 1024).toFixed(0)} KB sent)`);
    assert.ok(busy < 1500, `the honest REQ waited ${busy.toFixed(0)} ms behind one stranger's ${SOCKETS * PER_SOCKET} re-sent junk-signature frames`);
  } finally {
    for (const s of socks) { try { s.terminate(); } catch { /* gone */ } }
    child.kill('SIGKILL');
  }
});
