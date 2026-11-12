// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-24 (#1620 original attack, kind 8): the r4-nostr-1 finding named "every node's round result (kind 30762)
// and badge award". #1620 lets only replaceable / parameterized events past the total; a node's badge award is kind 8 (regular),
// so strangers filling the total still lock it out, and nostr-badges publishes via publishPass, which keeps an OK false as final.
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

test('#1489 a44-refute-24-2: strangers filling the relay\'s total do not lock out a node\'s badge award (kind 8)', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 20 } });
  const socks = [];
  try {
    for (let k = 0; k < 4; k++) { const ws = await open(r.port); socks.push(ws); const s = key();
      for (let i = 0; i < 5; i++) assert.equal((await put(ws, ev(s, 8, [['p', s.pub], ['n', String(i)]])))[2], true); }
    const ws = await open(r.port); socks.push(ws);
    const node = key(), player = key();
    const award = ev(node, 8, [['a', `30009:${node.pub}:arena-week-1`], ['p', player.pub]], undefined, '');
    const a = await put(ws, award);
    assert.equal(a[2], true, `the node's badge award was refused: ${a[3]}`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
