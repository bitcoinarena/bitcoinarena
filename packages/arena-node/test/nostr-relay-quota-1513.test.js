// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1513: the relay's quotas - one author's oldest go past its quota (its newest stay), a full relay refuses, REQs still answer by filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, i, at, kind = 8) => {
  const e = { pubkey: k.pub, created_at: at, kind, tags: [['p', k.pub], ['n', String(i)]], content: 'x' };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

test('#1513: an author past its quota loses its own oldest, others keep theirs; a full relay refuses', async () => {
  const r = await startRelay({ port: 0, limits: { authorEvents: 5, totalEvents: 12 } });
  const ws = await open(r.port);
  try {
    const a = key(), b = key(), c = key();
    const t0 = 1_700_000_000;
    for (let i = 0; i < 3; i++) assert.equal((await ask(ws, ['EVENT', ev(b, i, t0 + i)], (m) => m[0] === 'OK'))[0][2], true);
    for (let i = 0; i < 8; i++) assert.equal((await ask(ws, ['EVENT', ev(a, i, t0 + 100 + i)], (m) => m[0] === 'OK'))[0][2], true);
    const kept = (k) => r.events().filter((e) => e.pubkey === k.pub);
    assert.equal(kept(a).length, 5);
    assert.deepEqual(kept(a).map((e) => e.tags[1][1]).sort(), ['3', '4', '5', '6', '7']);   // the newest five
    assert.equal(kept(b).length, 3);
    // an event older than all five kept is not kept
    const old = await ask(ws, ['EVENT', ev(a, 99, t0 + 1)], (m) => m[0] === 'OK');
    assert.equal(old[0][2], false);
    assert.equal(kept(a).length, 5);
    // 8 kept; 4 more from c fill the relay to 12, the 13th is refused
    for (let i = 0; i < 4; i++) assert.equal((await ask(ws, ['EVENT', ev(c, i, t0 + 200 + i)], (m) => m[0] === 'OK'))[0][2], true);
    const full = await ask(ws, ['EVENT', ev(c, 9, t0 + 300)], (m) => m[0] === 'OK');
    assert.equal(full[0][2], false);
    assert.match(full[0][3], /relay is full/);
    // REQs by author, kind, since/until, #p
    const req = async (f) => (await ask(ws, ['REQ', 's' + Math.random(), f], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT').map((m) => m[2]);
    assert.equal((await req({ authors: [b.pub] })).length, 3);
    assert.equal((await req({ kinds: [8], since: t0 + 200 })).length, 4);
    assert.equal((await req({ kinds: [8], until: t0 + 2, limit: 2 })).length, 2);
    assert.equal((await req({ '#p': [a.pub] })).length, 5);
    assert.equal((await req({ ids: [kept(a)[0].id] })).length, 1);
    assert.equal((await req({ authors: [] })).length, 0);
  } finally { ws.terminate(); await r.close(); }
});
