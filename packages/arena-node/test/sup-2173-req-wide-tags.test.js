// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 5 (nostr): #1543 made a REQ an indexed SQL read, but every EVENT is still matched in JS against EVERY
// filter of EVERY subscription of EVERY socket (fs.some(matches) in the fan-out), and matches() runs e.tags.some(... vals.includes)
// - tags x values per filter. A stranger opens a few free sockets, each with 20 subscriptions of 10 filters naming 500 tag values
// that never match, then sends one 60 KB event with ~2000 tags: each EVENT costs sockets x 200 x 2000 x 500 string compares,
// synchronously, on the relay's one event loop (NIP-46 signing, NWC payments, logins wait). 60 such events per 10 s per socket.
// Safe: one EVENT does not hold the relay's event loop for seconds; another client's REQ is answered promptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const sign = (k, e0) => { const e = { pubkey: k.pub, created_at: Math.floor(Date.now() / 1000), ...e0 }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; };
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

// a44-refute-61-s1 #1 (kanban #1752 variant: the second copy of the same logic). #1752 compiled the FAN-OUT's filters into Sets, but
// stored() - every REQ - still runs matches(), e.tags.some(t => t[0] === k[1] && vals.includes(t[1])): tags x values per row. The SQL
// returns only rows with SOME matching #a tag, but matches() walks the event's tags in order, so a stranger puts the one matching tag
// LAST behind ~2000 that do not match: each row costs ~2000 x 500 compares, up to 500 rows per filter, 10 filters per REQ.
// Safe: one REQ against strangers' events does not hold the relay's event loop for seconds.
// Adapted to 1.9 by #2536: 1.9 refuses an event indexing more than MAX_TAG_ROWS (100) DISTINCT single-letter pairs (#1704), so the 1999
// distinct non-matching tags are refused at the door. The same walk with what the door takes: (a) 1999 copies of ONE non-matching #a value
// (one indexed pair), the match last; (b) 99 distinct non-matching #a values, the match last.
test('#2173 (1.9) (a) one non-matching value 1999 times: a REQ over strangers\' wide-tag events does not stall the relay', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    const vals = Array.from({ length: 500 }, (_, i) => `v${String(i).padStart(18, '0')}`);
    const tags = [...Array.from({ length: 1999 }, () => ['a', `v${String(999999).padStart(18, '0')}`]), ['a', vals[0]]];
    // 200 events from 4 free sockets (50 each, inside the 60-per-10-s budget), each under its own fresh key
    for (let s = 0; s < 4; s++) {
      const ws = await open(r.port); socks.push(ws);
      for (let i = 0; i < 50; i++) {
        const e = sign(key(), { kind: 8, tags, content: `${s}.${i}` });
        const got = await ask(ws, ['EVENT', e], (m) => m[0] === 'OK');
        assert.equal(got.at(-1)[2], true, String(got.at(-1)[3]));
      }
    }
    const attacker = await open(r.port); socks.push(attacker);
    const honest = await open(r.port); socks.push(honest);
    const t0 = Date.now();
    attacker.send(JSON.stringify(['REQ', 'x', ...Array(10).fill({ kinds: [8], '#a': vals })]));
    await new Promise((x) => setTimeout(x, 5));
    await ask(honest, ['REQ', 'h', { kinds: [0], limit: 1 }], (m) => m[0] === 'EOSE');
    const ms = Date.now() - t0;
    console.log('  MEASURED (a) one non-matching value 1999 times: honest REQ waited', ms, 'ms');
    assert.ok(ms < 1000, `an honest REQ waited ${ms} ms behind one stranger's REQ`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
test('#2173 (1.9) (b) 99 distinct non-matching values: a REQ over strangers\' wide-tag events does not stall the relay', async () => {
  const r = await startRelay({ port: 0 });
  const socks = [];
  try {
    const vals = Array.from({ length: 500 }, (_, i) => `v${String(i).padStart(18, '0')}`);
    const tags = [...Array.from({ length: 99 }, (_, i) => ['a', `v${String(i + 1000).padStart(18, '0')}`]), ['a', vals[0]]];
    // 200 events from 4 free sockets (50 each, inside the 60-per-10-s budget), each under its own fresh key
    for (let s = 0; s < 4; s++) {
      const ws = await open(r.port); socks.push(ws);
      for (let i = 0; i < 50; i++) {
        const e = sign(key(), { kind: 8, tags, content: `${s}.${i}` });
        const got = await ask(ws, ['EVENT', e], (m) => m[0] === 'OK');
        assert.equal(got.at(-1)[2], true, String(got.at(-1)[3]));
      }
    }
    const attacker = await open(r.port); socks.push(attacker);
    const honest = await open(r.port); socks.push(honest);
    const t0 = Date.now();
    attacker.send(JSON.stringify(['REQ', 'x', ...Array(10).fill({ kinds: [8], '#a': vals })]));
    await new Promise((x) => setTimeout(x, 5));
    await ask(honest, ['REQ', 'h', { kinds: [0], limit: 1 }], (m) => m[0] === 'EOSE');
    const ms = Date.now() - t0;
    console.log('  MEASURED (b) 99 distinct non-matching values: honest REQ waited', ms, 'ms');
    assert.ok(ms < 1000, `an honest REQ waited ${ms} ms behind one stranger's REQ`);
  } finally { for (const s of socks) s.terminate(); await r.close(); }
});
