// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 r13-nostr-1: the number of #<letter> conditions in one REQ filter is not bounded. A "letter" is any one UTF-16 unit, so a
// filter may name thousands of distinct tag keys ("#一", "#丁", ...), each a list of values. filterRefusal checks each key's shape
// but not how many there are, and sqlFor runs one db.prepare + COUNT per condition (plus one SQL statement with an EXISTS per
// condition). One 128 KB REQ of ten such filters holds the relay's one event loop: every other client's REQ, EVENT, NIP-46 signing
// and NWC payment waits. Safe: a REQ with that many tag conditions is refused (CLOSED) at once, and a player asking 20 ms later is
// answered promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay } from '../src/nostr-relay.js';

const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

test('#1489 r13-nostr-1: one REQ naming thousands of distinct tag keys does not stall the relay for another client', async () => {
  const r = await startRelay({ port: 0, dbPath: ':memory:' });
  const attacker = await open(r.port), player = await open(r.port);
  try {
    // ten filters of 900 distinct one-character tag keys each (CJK code units: `"#一":["x"],` is 13 bytes) - under the 128 KB message cap
    const filters = [];
    for (let f = 0; f < 10; f++) {
      const o = {};
      for (let i = 0; i < 900; i++) o[`#${String.fromCharCode(0x4e00 + f * 900 + i)}`] = ['x'];
      filters.push(o);
    }
    const msg = JSON.stringify(['REQ', 'h', ...filters]);
    assert.ok(Buffer.byteLength(msg) < 128 * 1024, `the REQ fits the relay's message cap (${Buffer.byteLength(msg)} bytes)`);
    const t0 = performance.now();
    // ten such REQs from ONE socket, back to back (its budget is 60 per 10 s)
    for (let k = 1; k < 10; k++) attacker.send(JSON.stringify(['REQ', `h${k}`, ...filters]));
    const heavy = ask(attacker, ['REQ', 'h', ...filters], (m) => m[1] === 'h' && (m[0] === 'EOSE' || m[0] === 'CLOSED' || m[0] === 'NOTICE'));
    const answered = new Promise((x) => setTimeout(() => {
      const asked = performance.now() - t0;
      ask(player, ['REQ', 'mine', { kinds: [0], authors: ['f'.repeat(64)] }], (m) => m[0] === 'EOSE').then(() => x({ asked, at: performance.now() - t0 }));
    }, 20));
    const hv = await heavy;
    const tookMs = performance.now() - t0;
    const p = await answered;
    console.log(`the attacker's ten REQs took ${Math.round(tookMs)} ms (answered ${hv[hv.length - 1][0]}: ${String(hv[hv.length - 1][2] || '').slice(0, 80)}); the player meant to ask at 20 ms, asked at ${Math.round(p.asked)} ms, answered at ${Math.round(p.at)} ms`);
    // and a stranger has 60 of these per 10 s per socket, sockets free
    assert.ok(p.at < 150, `ten REQs of 9000 tag conditions from one stranger's socket held the relay's event loop: a player asking 20 ms later was answered after ${Math.round(p.at)} ms`);
  } finally { attacker.terminate(); player.terminate(); await r.close(); }
});
