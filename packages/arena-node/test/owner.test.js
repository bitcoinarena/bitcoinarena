// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S OWNER: the owner is a key from 24 words; the claim code binds the first one; every owner
// request is signed for this node, in time, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { createOwner, ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { phraseFromSeed, seedFromPhrase } from '../../arena-client/src/bip39.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const sign = (m, s) => schnorr.sign(m, s);
const pubkeyOf = (s) => schnorr.getPublicKey(s);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const memory = () => { const m = { owner: null, code: null }; return { m, store: { read: () => m.owner, write: (o) => { m.owner = o; }, writeCode: (c) => { m.code = c; } } }; };
const seedA = new Uint8Array(32).fill(7), seedB = new Uint8Array(32).fill(9);
const NODE = 'ab'.repeat(32);

test('the 24 words give back the same owner key', () => {
  const words = phraseFromSeed(seedA).words;
  assert.equal(words.length, 24);
  const back = seedFromPhrase(words.join(' '));
  assert.ok(back.ok);
  assert.equal(toHex(pubkeyOf(ownerSecretFromSeed(back.seed))), toHex(pubkeyOf(ownerSecretFromSeed(seedA))));
});

test('a node is claimed once, with its code, and then answers only its owner', () => {
  let now = 1_000_000;
  const { m, store } = memory();
  const o = createOwner({ store, verify, node: NODE, nowMs: () => now });
  assert.match(m.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'a node with no owner writes a claim code');
  const req = (seed, action, args = {}, atMs = now, node = NODE) => signOwnerRequest({ node, action, args, atMs, secret: ownerSecretFromSeed(seed), sign, pubkeyOf });

  assert.equal(o.authorize(req(seedA, 'login'), 'login').status, 409, 'no owner yet');
  assert.equal(o.claim(req(seedA, 'claim', { code: 'WRONG-CODE-0000' })).status, 403, 'a wrong code');
  assert.equal(o.claim(req(seedA, 'claim', { code: m.code }, now, 'cd'.repeat(32))).status, 401, 'signed for another node');
  assert.equal(o.claim(req(seedA, 'claim', { code: m.code }, now - 300000)).status, 401, 'too old');
  const code = m.code;
  assert.ok(o.claim(req(seedA, 'claim', { code: code.toLowerCase() })).ok, 'the code, as typed in any case');
  assert.equal(m.code, null, 'the code is gone once used');
  assert.equal(m.owner.pubkey, toHex(pubkeyOf(ownerSecretFromSeed(seedA))));
  assert.equal(o.claim(req(seedB, 'claim', { code })).status, 409, 'a second claim');

  now += 1000;
  const login = req(seedA, 'login');
  assert.ok(o.authorize(login, 'login').ok);
  assert.equal(o.authorize(login, 'login').status, 401, 'the same request twice');
  assert.equal(o.authorize(req(seedB, 'login'), 'login').status, 403, 'another key');
  assert.equal(o.authorize(req(seedA, 'claim'), 'login').status, 401, 'a request for another action');
  const forged = { ...req(seedA, 'login'), args: { extra: 1 } };
  assert.equal(o.authorize(forged, 'login').status, 401, 'arguments changed after signing');

  const again = createOwner({ store, verify, node: NODE, nowMs: () => now });
  assert.ok(again.state().claimed, 'the owner survives a restart');
});

test('an unclaimed node names its claim file\'s full path; once claimed it says none (kanban #550)', () => {
  const { m, store } = memory();
  const o = createOwner({ store: { ...store, codePath: '/home/op/.arena/node.db.owner-claim' }, verify, node: NODE, nowMs: () => 1_000_000 });
  assert.equal(o.state().claimFile, '/home/op/.arena/node.db.owner-claim');
  assert.ok(o.claim(signOwnerRequest({ node: NODE, action: 'claim', args: { code: m.code }, atMs: 1_000_000, secret: ownerSecretFromSeed(seedA), sign, pubkeyOf })).ok);
  assert.equal(o.state().claimFile, null, 'no path once the node has an owner');
  assert.equal(createOwner({ store: memory().store, verify, node: NODE }).state().claimFile, null, 'a store that names no path: none');
});

test('the owner doors on a running node', async () => {
  const { m, store } = memory();
  const node = await serve(openStore(), { plugins: HOSTED, port: 0, owner: { store } });
  try {
    const base = `http://127.0.0.1:${node.port}`;
    const page = await fetch(`${base}/Dashboard/owner`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Node Owner/);
    assert.equal((await fetch(`${base}/owner/client.js`)).status, 200);
    const s = await (await fetch(`${base}/owner`)).json();
    assert.equal(s.claimed, false);
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const req = (action, args) => signOwnerRequest({ node: s.node, action, args, secret: ownerSecretFromSeed(seedA), sign, pubkeyOf });
    assert.equal((await post('/owner/claim', req('claim', { code: 'nope' }))).status, 403);
    assert.equal((await post('/owner/claim', req('claim', { code: m.code }))).status, 200);
    const me = await post('/owner/login', req('login'));
    assert.equal(me.status, 200);
    const j = await me.json();
    assert.equal(j.node, s.node);
    assert.ok(j.games.length >= 1, 'the games this node hosts');
    assert.equal((await fetch(`${base}/owner`).then((r) => r.json())).owner, toHex(pubkeyOf(ownerSecretFromSeed(seedA))));
  } finally { await node.close(); }
});

test('without an owner store the node has no owner area', async () => {
  const node = await serve(openStore(), { plugins: HOSTED, port: 0 });
  try { assert.equal((await fetch(`http://127.0.0.1:${node.port}/owner`)).status, 404); } finally { await node.close(); }
});

// the check builds with arena-client's esbuild; a tree synced without node_modules (the test host's suite copy) has none
const ESBUILD = new URL('../../arena-client/node_modules/esbuild/lib/main.js', import.meta.url);
test('the owner page bundle is what its source builds', { skip: !existsSync(ESBUILD) && 'no esbuild in arena-client/node_modules: the bundle check needs the build tool' }, () => {
  execFileSync(process.execPath, [new URL('../tools/bundle-owner.mjs', import.meta.url).pathname, '--check']);
});

// ---- LOGIN WITH NOSTR: an extension or remote signer signs a kind 27235 event per owner request ----
import { createHash } from 'node:crypto';
import { signOwnerEvent, ownerEventTemplate, OWNER_EVENT_KIND } from '../src/owner.js';
const nostrSigner = (sk) => async (t) => {
  const pubkey = Buffer.from(schnorr.getPublicKey(sk)).toString('hex');
  const e = { ...t, pubkey };
  e.id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  e.sig = Buffer.from(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), sk)).toString('hex');
  return e;
};

test('Login with Nostr: a node is claimed and run with Nostr events - its node, action, arguments and time, signed by the owner\'s Nostr key', async () => {
  let rec = null, code = null, now = 1_800_000_000_000;
  const node = 'ab'.repeat(32);
  const o = createOwner({ store: { read: () => rec, write: (x) => { rec = x; }, writeCode: (c) => { code = c; } }, node, nowMs: () => now,
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } } });
  const sk = new Uint8Array(32).fill(5), other = new Uint8Array(32).fill(6);
  const npubHex = Buffer.from(schnorr.getPublicKey(sk)).toString('hex');
  const ev = (action, args, k = sk, more = {}) => signOwnerEvent({ node: more.node || node, action, args, atMs: more.atMs ?? now, signEvent: nostrSigner(k) });
  // the claim, as an event with the code
  const claim = await ev('claim', { code });
  assert.equal(claim.nostr.kind, OWNER_EVENT_KIND);
  let r = o.claim(claim);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.owner, npubHex, 'the owner is the Nostr key itself');
  assert.equal(rec.via, 'nostr');
  // an owner action: taken; the same event again, another node's, other arguments, an old one, another key: refused
  const set = await ev('settings', { autoUpdate: true, sources: [] });
  assert.equal(o.settings(set).ok, true);
  assert.match(o.settings(set).why, /already sent/);
  assert.match(o.settings(await ev('settings', { autoUpdate: true, sources: [] }, sk, { node: 'cd'.repeat(32) })).why, /another node/);
  const swapped = await ev('settings', { autoUpdate: false, sources: [] }); swapped.args = { autoUpdate: true, sources: ['https://evil.example'] };
  assert.match(o.settings(swapped).why, /other arguments/);
  assert.match(o.settings(await ev('settings', { autoUpdate: true, sources: [] }, sk, { atMs: now - 10 * 60000 })).why, /two minutes/);
  r = o.settings(await ev('settings', { autoUpdate: true, sources: [] }, other));
  assert.equal(r.status, 403);
  const forged = await ev('leave', {}); forged.nostr.sig = forged.nostr.sig.replace(/^./, (x) => (x === '0' ? '1' : '0'));
  assert.match(o.leave(forged).why, /signature/);
  assert.equal(o.leave(await ev('leave', {})).ok, true);
  // and the nsec itself signs the plain way: the same key, the same owner
  assert.equal(o.authorize(signOwnerRequest({ node, action: 'stay', args: {}, atMs: now, secret: sk, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) }), 'stay').ok, true);
  assert.deepEqual(ownerEventTemplate({ node, action: 'x', args: {}, atMs: 1000 }).tags.map((t) => t[0]), ['u', 'method', 'payload']);
});
