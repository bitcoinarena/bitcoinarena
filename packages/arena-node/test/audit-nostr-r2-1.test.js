// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit nostr r2-1: THE RELAY-WIDE SUBSCRIPTION BUDGET OF #2839 IS FIRST COME, FIRST SERVED. nostr-relay.js charges each kept REQ its values
// and refuses any REQ past SUB_VALUES_TOTAL (400,000) relay-wide. Sockets are free and an idle socket is never dropped, so one stranger opens
// 100 sockets, keeps 20 REQs of 200 values on each (4,000, the per-socket bound) and holds the whole total. From then on EVERY other REQ -
// a player's seed read at Nostr login (seedFor/askEach takes CLOSED as "did not answer" and refuses the login), a NWC answer subscription,
// a NIP-46 signer's subscription - is CLOSED 'blocked: too many subscription values', for as long as the stranger keeps the sockets open.
// Safe: a stranger's idle subscriptions cannot refuse an honest client's small REQ (its seed query is answered with EOSE).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const open = (url) => new Promise((r, j) => { const ws = new WebSocket(url); ws.once('open', () => r(ws)); ws.once('error', j); });
const ask = (ws, msg, done) => new Promise((r) => { const got = []; const on = (m) => { const a = JSON.parse(String(m)); got.push(a); if (done(a)) { ws.off('message', on); r(got); } }; ws.on('message', on); ws.send(JSON.stringify(msg)); });

test('audit nostr r2-1: a stranger\'s idle subscriptions do not lock every other client out of REQ', async () => {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const socks = [];
  try {
    let n = 0, held = 0;
    for (let s = 0; s < 100; s++) {
      const ws = await open(url); socks.push(ws);
      const answers = [];
      for (let i = 0; i < 20; i++) {
        const vals = Array.from({ length: 199 }, () => (n++).toString(36));
        answers.push(ask(ws, ['REQ', `s${i}`, { '#p': vals }], (a) => a[1] === `s${i}` && (a[0] === 'EOSE' || a[0] === 'CLOSED')));
      }
      for (const g of await Promise.all(answers)) if (g.at(-1)[0] === 'EOSE') held++;
    }
    console.log(`  FACTS: the stranger keeps ${held} subscriptions open on 100 idle sockets`);
    const player = await open(url); socks.push(player);
    const pk = 'ab'.repeat(32);
    const got = await ask(player, ['REQ', 'seed', { kinds: [30078], authors: [pk], '#d': ['bitcoin-arena/seed'] }], (a) => a[1] === 'seed' && (a[0] === 'EOSE' || a[0] === 'CLOSED'));
    console.log(`  FACTS: the player's seed query is answered ${JSON.stringify(got.at(-1))}`);
    assert.equal(got.at(-1)[0], 'EOSE', `a player's Nostr-login seed query was refused because a stranger holds the relay-wide subscription budget: ${JSON.stringify(got.at(-1))}`);
  } finally {
    for (const w of socks) w.terminate();
    await relay.close();
  }
});

