// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE A NODE IS NOW, OFF CHAIN (kanban #562, 2026-10-21 "1 default, 2 for updates so no needed updates"): a node's signed
// address announcement - checked, the newest kept across a restart, preferred to the census endpoint, and pushed to the other seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement, checkAddressAnnouncement, endpointOf, ADDRESS_FUTURE_MS } from '../../arena-protocol/src/address-announcement.js';
import { createAddressBook, announceOwn, pullAnnouncements } from '../src/address-book.js';

const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const keyOf = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, hex: Buffer.from(schnorr.getPublicKey(secret)).toString('hex') }; };
const A = keyOf(3), B = keyOf(4);
const sign = (k) => (d) => schnorr.sign(d, k.secret);
const T0 = 1_800_000_000_000;

test('an announcement: signed by the node it names, dated, an http(s)/ws(s) endpoint', () => {
  const a = signAddressAnnouncement({ node: A.hex, endpoint: 'https://cottage-usually-pete-path.trycloudflare.com', atMs: T0 }, sign(A));
  assert.equal(checkAddressAnnouncement(a, { verify, nowMs: T0 }).ok, true);
  assert.match(checkAddressAnnouncement({ ...a, endpoint: 'https://evil.example' }, { verify, nowMs: T0 }).why, /signature/);
  assert.match(checkAddressAnnouncement({ ...a, node: B.hex }, { verify, nowMs: T0 }).why, /signature/, 'another node\'s key');
  const future = signAddressAnnouncement({ node: A.hex, endpoint: 'https://a.example', atMs: T0 + ADDRESS_FUTURE_MS + 1 }, sign(A));
  assert.match(checkAddressAnnouncement(future, { verify, nowMs: T0 }).why, /future/);
  assert.throws(() => signAddressAnnouncement({ node: A.hex, endpoint: 'ftp://a.example', atMs: T0 }, sign(A)), /http\(s\) or ws\(s\)/);
});

test('a census node is found at its newest announcement, else its census endpoint; an announcement older than its advertisement does not override it', () => {
  const entry = { pubkey: Buffer.from(A.hex, 'hex'), advert: { endpoint: 'https://keeps-ahead-employ-thomas.trycloudflare.com', timestamp: BigInt(T0 - 1000) } };
  assert.equal(endpointOf(entry, new Map()), 'https://keeps-ahead-employ-thomas.trycloudflare.com');
  const now = signAddressAnnouncement({ node: A.hex, endpoint: 'https://cottage-usually-pete-path.trycloudflare.com', atMs: T0 }, sign(A));
  assert.equal(endpointOf(entry, new Map([[A.hex, now]])), 'https://cottage-usually-pete-path.trycloudflare.com');
  const old = signAddressAnnouncement({ node: A.hex, endpoint: 'https://older.trycloudflare.com', atMs: T0 - 5000 }, sign(A));
  assert.equal(endpointOf(entry, new Map([[A.hex, old]])), 'https://keeps-ahead-employ-thomas.trycloudflare.com', 'the advertisement is newer');
});

test('the book keeps each node\'s newest, across a restart; its own is signed again only when its address changed', () => {
  const db = new DatabaseSync(':memory:');
  let clock = T0;
  const book = createAddressBook({ db, verify, nowMs: () => clock });
  const one = signAddressAnnouncement({ node: B.hex, endpoint: 'https://one.example', atMs: T0 - 2000 }, sign(B));
  const two = signAddressAnnouncement({ node: B.hex, endpoint: 'https://two.example', atMs: T0 - 1000 }, sign(B));
  assert.deepEqual(book.take(two), { ok: true, kept: true });
  assert.deepEqual(book.take(one), { ok: true, kept: false }, 'an older one is not kept');
  assert.equal(book.take({ ...two, endpoint: 'https://forged.example' }).ok, false);
  const mine = book.own({ node: A.hex, endpoint: 'https://cottage-usually-pete-path.trycloudflare.com', sign: sign(A) });
  clock += 60000;
  assert.equal(book.own({ node: A.hex, endpoint: 'https://cottage-usually-pete-path.trycloudflare.com', sign: sign(A) }).sig, mine.sig, 'the same address: the same announcement');
  const moved = book.own({ node: A.hex, endpoint: 'https://new-name.trycloudflare.com', sign: sign(A) });
  assert.equal(moved.atMs, clock);
  const again = createAddressBook({ db, verify, nowMs: () => clock });   // the seat restarted
  assert.deepEqual(again.list().map((a) => [a.node.slice(0, 4), a.endpoint]).sort(), [[A.hex.slice(0, 4), 'https://new-name.trycloudflare.com'], [B.hex.slice(0, 4), 'https://two.example']].sort());
});

test('a node pushes its announcement to every other census node at the address that node is found at - a stale census endpoint replaced by its announcement', async () => {
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0 });
  book.take(signAddressAnnouncement({ node: B.hex, endpoint: 'https://b-now.example/', atMs: T0 }, sign(B)));
  const entries = [{ pubkey: Buffer.from(A.hex, 'hex'), advert: { endpoint: 'https://a.example', timestamp: 0n } },
    { pubkey: Buffer.from(B.hex, 'hex'), advert: { endpoint: 'https://b-stale.example', timestamp: 0n } },
    { pubkey: Buffer.from(keyOf(5).hex, 'hex'), advert: { endpoint: 'wss://c.example/', timestamp: 0n } }];
  const posted = [];
  const a = book.own({ node: A.hex, endpoint: 'https://a-now.example', sign: sign(A) });
  const r = await announceOwn({ announcement: a, entries, book, ownKey: A.hex, post: async (u, body) => { posted.push([u, body.endpoint]); return true; } });
  assert.deepEqual(r, { roots: 2, took: 2 });
  assert.deepEqual(posted.map((p) => p[0]).sort(), ['https://b-now.example/address-announcement', 'https://c.example/address-announcement'], 'not itself; B where B is now; C at its census endpoint');
  assert.ok(posted.every((p) => p[1] === 'https://a-now.example'));
});

test('a seat takes an announcement at POST /address-announcement, lists it at GET /address-announcements, refuses a forged one, and keeps it across a restart', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'addr-seat-')), 'node.db');
  const a = signAddressAnnouncement({ node: B.hex, endpoint: 'https://events-paris-reminder-why.trycloudflare.com', atMs: Date.now() }, sign(B));
  let seat = await serve(openStore(file), { port: 0 });
  try {
    const post = (body) => fetch(`http://127.0.0.1:${seat.port}/address-announcement`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post(a)).status, 200);
    const forged = await post({ ...a, endpoint: 'https://evil.example' });
    assert.deepEqual([forged.status, (await forged.text()).trim()], [400, 'the signature is not the node\'s']);
    const list = await (await fetch(`http://127.0.0.1:${seat.port}/address-announcements`)).json();
    assert.deepEqual(list.announcements.map((x) => x.endpoint), ['https://events-paris-reminder-why.trycloudflare.com']);
    await seat.close();
    seat = await serve(openStore(file), { port: 0 });
    const after = await (await fetch(`http://127.0.0.1:${seat.port}/address-announcements`)).json();
    assert.deepEqual(after.announcements.map((x) => x.node), [B.hex], 'kept in the store');
  } finally { await seat.close(); }
});

// AND PULLED (kanban #577, 2026-10-26: inst577-1 missed the pushed announcements of two peers' new tunnels and relayed to their old ones)
test('a node a push missed takes the newer addresses from the seats it asks; a forged or older one is not taken', async () => {
  const C = keyOf(5);
  const db = new DatabaseSync(':memory:');
  const book = createAddressBook({ db, verify, nowMs: () => T0 });
  const entry = (k, endpoint) => ({ pubkey: Buffer.from(k.hex, 'hex'), advert: { endpoint, timestamp: BigInt(T0 - 100000) } });
  book.take(signAddressAnnouncement({ node: B.hex, endpoint: 'https://traditional-boats-directed-threaded.trycloudflare.com', atMs: T0 - 50000 }, sign(B)));
  const newB = signAddressAnnouncement({ node: B.hex, endpoint: 'https://columbus-merchant-wagner-the.trycloudflare.com', atMs: T0 - 1000 }, sign(B));
  const forged = { ...signAddressAnnouncement({ node: C.hex, endpoint: 'https://c.example', atMs: T0 - 1000 }, sign(C)), endpoint: 'https://evil.example' };
  const oldB = signAddressAnnouncement({ node: B.hex, endpoint: 'https://older.trycloudflare.com', atMs: T0 - 90000 }, sign(B));
  const asked = [];
  const get = async (u) => { asked.push(u); if (u.startsWith('https://down')) throw new Error('fetch failed'); return { announcements: [oldB, newB, forged] }; };
  const entries = [entry(A, 'https://me.example'), entry(B, 'https://traditional-boats-directed-threaded.trycloudflare.com'), entry(C, 'https://down.example')];
  const r = await pullAnnouncements({ entries, book, ownKey: A.hex, get });
  assert.deepEqual([r.asked, r.answered, r.kept], [2, 1, 1], 'its own seat not asked; one seat down');
  assert.equal(book.endpointOf(entries[1]), 'https://columbus-merchant-wagner-the.trycloudflare.com');
  assert.equal(book.map().get(C.hex), undefined, 'the forged one not taken');
  assert.ok(!asked.some((u) => u.startsWith('https://me.example')));
});
