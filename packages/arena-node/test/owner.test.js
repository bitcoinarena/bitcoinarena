// THE NODE'S OWNER (kanban #276): the owner is a key from 24 words; the claim code binds the first one; every owner
// request is signed for this node, in time, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('the owner page bundle is what its source builds', () => {
  execFileSync(process.execPath, [new URL('../tools/bundle-owner.mjs', import.meta.url).pathname, '--check']);
});
