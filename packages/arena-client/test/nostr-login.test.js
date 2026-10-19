// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LOGIN WITH NOSTR (kanban #277): the game seed of a Nostr account, against the game's own relay (arena-node nostr-relay.js).
//   - an nsec: first login derives the seed and publishes it encrypted (NIP-78 + NIP-44); a second login - another device -
//     reads the same seed back; the event's content is not the seed in clear;
//   - a signer (NIP-07 shaped, and a NIP-46 bunker answering over the relay): a random seed, the same one on the next login;
//   - an nsec user whose account already has a seed (made by a signer) gets THAT seed, not the derived one;
//   - a seed event that does not decrypt is left alone, an error; no relay answering makes no seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { localSigner, signerFromNsec, newAccount, extensionSigner, bunkerSigner, seedFor, derivedSeed, SEED_KIND, SEED_D } from '../nostr/nostr-login.js';

const hex = (b) => Buffer.from(b).toString('hex');

// A MINIMAL NIP-46 REMOTE SIGNER ("bunker") holding `secret`, answering requests sent to `bunkerSk`'s key over `url`
function fakeBunker(url, secret, bunkerSk = generateSecretKey()) {
  const pool = new SimplePool();
  const bpk = getPublicKey(bunkerSk);
  const sub = pool.subscribeMany([url], { kinds: [24133], '#p': [bpk] }, {
    onevent: async (ev) => {
      const ck = nip44.getConversationKey(bunkerSk, ev.pubkey);
      const req = JSON.parse(nip44.decrypt(ev.content, ck));
      const ckUser = (peer) => nip44.getConversationKey(secret, peer);
      let result;
      if (req.method === 'connect') result = 'ack';
      else if (req.method === 'get_public_key') result = getPublicKey(secret);
      else if (req.method === 'sign_event') result = JSON.stringify(finalizeEvent(JSON.parse(req.params[0]), secret));
      else if (req.method === 'nip44_encrypt') result = nip44.encrypt(req.params[1], ckUser(req.params[0]));
      else if (req.method === 'nip44_decrypt') result = nip44.decrypt(req.params[1], ckUser(req.params[0]));
      else if (req.method === 'ping') result = 'pong';
      const reply = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', ev.pubkey]],
        content: nip44.encrypt(JSON.stringify({ id: req.id, result }), ck) }, bunkerSk);
      await Promise.allSettled(pool.publish([url], reply));
    },
  });
  return { link: `bunker://${bpk}?relay=${encodeURIComponent(url)}`, close: () => { sub.close(); pool.close([url]); } };
}

test('an nsec: the seed is derived, published encrypted, and the same on the next device; a new account has an nsec to keep', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  try {
    const acct = newAccount();
    assert.match(acct.nsec, /^nsec1/);
    const first = await seedFor(acct.signer, { pool, relays: [url] });
    assert.deepEqual([first.created, first.from], [true, 'derived']);
    assert.equal(hex(first.seed), hex(derivedSeed(acct.signer.secret)));
    const ev = r.events().find((e) => e.kind === SEED_KIND);
    assert.deepEqual(ev.tags, [['d', SEED_D]]);
    assert.ok(!ev.content.includes(hex(first.seed)), 'the event does not carry the seed in clear');
    // another device: the nsec pasted
    const again = await seedFor(signerFromNsec(acct.nsec), { pool, relays: [url] });
    assert.deepEqual([again.created, again.from, hex(again.seed)], [false, 'relays', hex(first.seed)]);
    assert.throws(() => signerFromNsec(acct.npub), /public key/);
  } finally { pool.close([url]); await r.close(); }
});

test('a signer (NIP-07 and a NIP-46 bunker over the relay): a random seed, the same at the next login; an nsec user then gets that seed', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  const secret = generateSecretKey();
  const bunker = fakeBunker(url, secret);
  try {
    // NIP-07 shaped extension holding `secret`
    const ext = { getPublicKey: async () => getPublicKey(secret), signEvent: async (t) => finalizeEvent(t, secret),
      nip44: { encrypt: async (p, t) => nip44.encrypt(t, nip44.getConversationKey(secret, p)), decrypt: async (p, t) => nip44.decrypt(t, nip44.getConversationKey(secret, p)) } };
    const s1 = await seedFor(await extensionSigner(ext), { pool, relays: [url] });
    assert.deepEqual([s1.created, s1.from], [true, 'random']);
    assert.notEqual(hex(s1.seed), hex(derivedSeed(secret)));
    // the bunker, the same account: the same seed, read back through NIP-46 decryption
    const b = await bunkerSigner(bunker.link, { pool });
    assert.equal(b.pubkey, getPublicKey(secret));
    const s2 = await seedFor(b, { pool, relays: [url] });
    assert.deepEqual([s2.created, hex(s2.seed)], [false, hex(s1.seed)]);
    await b.close();
    // and the nsec of that account: the seed on the relays, not the derived one
    const s3 = await seedFor(localSigner(secret), { pool, relays: [url] });
    assert.deepEqual([s3.created, hex(s3.seed)], [false, hex(s1.seed)]);
    assert.equal(r.events().filter((e) => e.kind === SEED_KIND).length, 1, 'one seed event, never a second');
    await assert.rejects(extensionSigner({ getPublicKey: async () => 'x' }), /NIP-44/);
  } finally { bunker.close(); pool.close([url]); await r.close(); }
});

test('a seed event that does not decrypt is left alone; no relay answering makes no seed', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  try {
    const s = localSigner(generateSecretKey());
    const bad = await s.signEvent({ kind: SEED_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['d', SEED_D]], content: 'not-nip44' });
    await Promise.allSettled(pool.publish([url], bad));
    await assert.rejects(seedFor(s, { pool, relays: [url] }), /did not decrypt.*left as it is/);
    assert.equal(r.events().filter((e) => e.kind === SEED_KIND).length, 1, 'not overwritten');
    await assert.rejects(seedFor(localSigner(generateSecretKey()), { pool, relays: ['ws://127.0.0.1:1'], maxWait: 800 }), /no Nostr relay answered/);
  } finally { pool.close([url]); await r.close(); }
});

test('a new account (fresh): its seed is made without asking the relays for one, and is the seed a later login reads', async () => {
  // kanban #381: a key made a moment ago has no seed event; the ask waited for every relay's answer first
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  const asked = [];
  const querySync = pool.querySync.bind(pool);
  pool.querySync = (...a) => { asked.push(a[1]); return querySync(...a); };
  try {
    const acct = newAccount();
    const made = await seedFor(acct.signer, { pool, relays: [url], fresh: true });
    assert.deepEqual([made.created, made.from], [true, 'derived']);
    assert.equal(asked.length, 0, 'no relay was asked for a seed event');
    const again = await seedFor(signerFromNsec(acct.nsec), { pool, relays: [url] });
    assert.deepEqual([again.created, again.from, hex(again.seed)], [false, 'relays', hex(made.seed)]);
    assert.equal(asked.length, 1, 'a later login asks');
  } finally { pool.close([url]); await r.close(); }
});
