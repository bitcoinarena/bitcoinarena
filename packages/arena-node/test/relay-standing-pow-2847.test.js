// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2847 (finding wf1489-r25-nostr-1 1b; ruling 2026-11-16): under a fresh-key flood an author with standing is never evicted, room comes
// only from authors without standing, oldest-arrived first (never the newest: #2677 let the next stranger erase a newcomer's profile), else the
// write is refused; and an author the relay has never kept pays NIP-13 proof of work while the pool is over 90 % full.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId, powRequired, leadingZeroBits, STANDING_SEED_MS } from '../src/nostr-relay.js';
import { key, hex, publish, open, ask } from './_r22-common.mjs';

// an event mined to `bits` leading zero bits (NIP-13: a ['nonce', n, target] tag)
const mined = (k, { kind = 0, at, content = '{}', tags = [] }, bits) => {
  for (let n = 0; ; n++) {
    const e = { pubkey: k.pub, created_at: at, kind, tags: [...tags, ['nonce', String(n), String(bits)]], content };
    e.id = eventId(e);
    if (leadingZeroBits(e.id) >= bits) { e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; }
  }
};
const plain = (k, { kind = 0, at, content = '{}' }) => { const e = { pubkey: k.pub, created_at: at, kind, tags: [], content }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s)); return e; };
const kept = async (port, pub, socks) => { const ws = await open(port); socks.push(ws); return (await ask(ws, ['REQ', 's', { kinds: [0], authors: [pub] }], (m) => m[0] === 'EOSE')).filter((m) => m[0] === 'EVENT').length; };
const LIMITS = { totalEvents: 40, powBase: 8, powMax: 10 };

test('#2847: the difficulty: none to 90 %, 20 then +2 per 1 %, 28 at most', () => {
  assert.deepEqual([0.5, 0.9, 0.905, 0.91, 0.92, 0.935, 0.99, 1].map((f) => powRequired(f)), [0, 0, 20, 22, 24, 26, 28, 28]);
  assert.equal(leadingZeroBits('0000f' + 'f'.repeat(59)), 16);
  assert.equal(leadingZeroBits('01' + 'f'.repeat(62)), 7);
});

test('#2847: a newcomer to a full pool is asked for proof of work, admitted with it, and the next stranger does not erase it (oldest first)', async () => {
  const r = await startRelay({ port: 0, limits: LIMITS, pow: true });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    const spam = [];
    for (let i = 0; i < 40; i++) spam.push(mined(key(), { at: t0 + i }, 10));
    const oks = await publish(r.port, spam, socks);
    assert.ok(oks.every((m) => m[2] === true), JSON.stringify(oks.find((m) => m[2] !== true)));
    const player = key();
    const [no] = await publish(r.port, [plain(player, { at: t0 + 100, content: '{"name":"new player"}' })], socks);
    assert.deepEqual([no[2], no[3]], [false, 'pow: difficulty 10 required']);
    const [yes] = await publish(r.port, [mined(player, { at: t0 + 101, content: '{"name":"new player"}' }, 10)], socks);
    assert.equal(yes[2], true, yes[3]);
    // the stranger's next fresh key: room comes from the OLDEST author without standing, not the newcomer
    const [s1] = await publish(r.port, [mined(key(), { at: t0 + 102 }, 10)], socks);
    assert.equal(s1[2], true, s1[3]);
    assert.equal(await kept(r.port, player.pub, socks), 1, 'the new player\'s profile survives the next stranger write');
    assert.equal(await kept(r.port, spam[0].pubkey, socks), 0, 'the oldest stranger made the room');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});

test('#2847: an author with standing survives any number of stranger writes; with only standing authors left a stranger is refused', async () => {
  const player = key(), friend = key();
  const r = await startRelay({ port: 0, limits: LIMITS, pow: true, standing: () => [player.pub, friend.pub] });
  const socks = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    assert.equal((await publish(r.port, [plain(player, { at: t0, content: '{"name":"p"}' })], socks))[0][2], true);
    const strangers = [];
    for (let i = 0; i < 80; i++) strangers.push(mined(key(), { at: t0 + 1 + i }, 10));
    const oks = await publish(r.port, strangers, socks);
    assert.ok(oks.every((m) => m[2] === true), 'each stranger got in by evicting an older stranger');
    assert.equal(await kept(r.port, player.pub, socks), 1, 'a profile with standing is never evicted');
    // standing authors need no proof of work
    assert.equal((await publish(r.port, [plain(friend, { at: t0 + 200, content: '{"name":"f"}' })], socks))[0][2], true);
  } finally { for (const w of socks) w.terminate(); await r.close(); }
  // a pool of standing authors only: nobody to evict, refused
  const all = Array.from({ length: 5 }, () => key());
  const r2 = await startRelay({ port: 0, limits: { totalEvents: 5, powBase: 8, powMax: 10 }, pow: true, standing: () => all.map((k) => k.pub) });
  const socks2 = [];
  try {
    const t0 = Math.floor(Date.now() / 1000) - 1000;
    await publish(r2.port, all.map((k, i) => plain(k, { at: t0 + i })), socks2);
    const [x] = await publish(r2.port, [mined(key(), { at: t0 + 10 }, 10)], socks2);
    assert.deepEqual([x[2], x[3]], [false, 'blocked: the relay is full']);
  } finally { for (const w of socks2) w.terminate(); await r2.close(); }
});

test('#2847: a seed kept 7 days here gives its author standing (the relay\'s own clock, not the author\'s created_at)', async () => {
  let t = Date.now();
  const r = await startRelay({ port: 0, limits: { totalEvents: 3, powBase: 8, powMax: 10 }, pow: true, now: () => t });
  const socks = [];
  try {
    const at = Math.floor(t / 1000) - 10;
    const old = key();
    await publish(r.port, [plain(old, { kind: 30078, at, content: 'seed' })], socks);   // the seed pool is apart
    await publish(r.port, [plain(old, { at, content: '{"name":"old"}' })], socks);
    t += STANDING_SEED_MS + 1000;
    for (let i = 0; i < 6; i++) await publish(r.port, [mined(key(), { at: at + 1 + i }, 10)], socks);
    assert.equal(await kept(r.port, old.pub, socks), 1, 'its profile stays: its seed was kept 7 days');
  } finally { for (const w of socks) w.terminate(); await r.close(); }
});
