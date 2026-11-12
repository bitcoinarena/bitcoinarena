// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4-nostr-1: THE RELAY'S TOTAL QUOTA IS A STRANGER'S OFF SWITCH.
// The #1513 fix bounds each author (500 events, the author's own oldest go) and the whole store (200,000 events / 512 MB); past the
// total, EVERY new event is refused 'blocked: the relay is full' - whoever signed it. Keys are free and sockets are not limited, so a
// stranger writes 500 events under each of 400 fresh keys (kind 8 / 9735 need nothing else) and the relay then refuses a new player's
// game seed (kind 30078: the login fails "no relay took your game seed" where ours is the only relay up), every node's round result
// (kind 30762) and badge award - and publishPass (nostr-results.js) records an OK false as that relay's final refusal, never sent again.
// Safe: events of strangers cannot lock out every other author; a node's signed result is still taken by a relay a stranger filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, kind, tags, at = Math.floor(Date.now() / 1000), content = 'x') => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const put = (ws, e) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'OK' && a[1] === e.id) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(['EVENT', e])); });

test('#1489 r4-nostr-1: strangers filling the relay\'s total do not lock out a node\'s round result or a new player\'s seed', async () => {
  // the same rule at a small scale: 5 events an author, 20 in total (live: 500 and 200,000)
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 20 } });
  const socks = [];
  try {
    for (let k = 0; k < 4; k++) {                    // four fresh stranger keys, five events each, each on its own socket
      const ws = await open(r.port); socks.push(ws);
      const s = key();
      for (let i = 0; i < 5; i++) assert.equal((await put(ws, ev(s, 8, [['p', s.pub], ['n', String(i)]])))[2], true);
    }
    const ws = await open(r.port); socks.push(ws);
    const node = key(), player = key();
    const result = ev(node, 30762, [['d', `arena:result:${'ab'.repeat(32)}`], ['t', 'nextblock']], undefined, '{"v":1}');
    const seed = ev(player, 30078, [['d', 'bitcoin-arena/seed']], undefined, 'ciphertext');
    const a = await put(ws, result), b = await put(ws, seed);
    assert.equal(a[2], true, `the node's signed round result was refused: ${a[3]}`);
    assert.equal(b[2], true, `a new player's game seed was refused: ${b[3]}`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
