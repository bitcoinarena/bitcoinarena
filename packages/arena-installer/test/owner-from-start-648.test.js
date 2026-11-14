// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER FROM THE FIRST STEP (kanban #648, the owner 2026-10-25: "this selection could then automatically, but with explanation on this
// step, replace the separate owner step of the installer"): the choice at POST /api/start binds the owner before the node's first start,
// as POST /api/owner did - new words at their seed step, restored words and a Nostr key at once - and the owner step is done. "Use another
// Nostr key as owner" (ownerNpub) keeps the npub path. A node run again keeps its owner file (#2099/#2227) and its owner unless another key
// is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizard } from '../src/wizard.js';
import { nodeState, nextStep } from '../src/state.js';
import { newSeed, newNsec, ownerKeyOf, seedOfNsec, npubOf, nostrPubkeyHex } from '../src/seed.js';

const RELEASE = resolve(fileURLToPath(import.meta.url), '../../../..');
const client = (port) => {
  let cookie = '';
  const go = (method, path, body) => new Promise((ok, no) => {
    const q = http.request({ host: '127.0.0.1', port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
      const set = r.headers['set-cookie']; if (set) cookie = set[0].split(';')[0];
      let t = ''; r.on('data', (d) => { t += d; }); r.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* html */ } ok({ status: r.statusCode, json }); });
    });
    q.on('error', no); if (body) q.write(JSON.stringify(body)); q.end();
  });
  return { get: (p) => go('GET', p), post: (p, b) => go('POST', p, b || {}) };
};
async function run(fn, { before } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'arena-648-'));
  if (before) before(home);
  const state = nodeState(home);
  const w = createWizard({ state, release: RELEASE, seatPort: 1 });
  const server = http.createServer((q, s) => w.handle(q, s));
  try {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const c = client(server.address().port);
    await c.get(`/?t=${w.token}`);
    await fn(c, state, home);
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
}
const ownerFile = (state) => JSON.parse(readFileSync(state.path('node.db.owner.json'), 'utf8'));
/** The seed step through its doors: the words shown, three asked back. */
async function confirmWords(c) {
  const shown = (await c.post('/api/seed/new')).json;
  const right = Object.fromEntries(shown.positions.map((p) => [p, shown.words[p - 1]]));
  return (await c.post('/api/seed/confirm', { answers: right })).json;
}
const other = newNsec();   // "another Nostr key" in these tests
const otherNpub = npubOf(other.pubkey);

test('npubOf: the npub of a 64-hex key, read back by nostrPubkeyHex', () => {
  assert.match(otherNpub, /^npub1[02-9ac-hj-np-z]{58}$/);
  assert.equal(nostrPubkeyHex(otherNpub), other.pubkey);
  assert.equal(npubOf('xyz'), null);
});

test('#648 words, new: no owner before the words; confirmed, the words\' key owns the node and the owner step is done', async () => {
  await run(async (c, state) => {
    assert.deepEqual((await c.post('/api/start', { control: 'words', action: 'new' })).json, { ok: true, control: 'words', origin: 'new' });
    let st = (await c.get('/api/state')).json;
    assert.deepEqual([!!st.done.owner, st.owner], [false, null], 'no words yet: no owner yet');
    const r = await confirmWords(c);
    assert.equal(r.ok, true, r.why);
    const seedKey = ownerKeyOf(Buffer.from(state.readSecret('seed.hex').trim(), 'hex')).pubkey;
    assert.deepEqual(r.owner, { mode: 'seed', pubkey: seedKey });
    st = (await c.get('/api/state')).json;
    assert.deepEqual([!!st.done.seed, !!st.done.owner, st.owner, st.ownerNpub], [true, true, { mode: 'seed', pubkey: seedKey }, npubOf(seedKey)]);
    assert.equal(ownerFile(state).pubkey, seedKey, 'bound beside the database before the first start');
    assert.equal(nextStep({ ...state.read(), done: { ...state.read().done, start: 1, chain: 1, roles: 1, apps: 1, emergency: 1 } }), 'reach', 'the owner step is skipped');
  });
});

test('#648 words, restore: the typed words\' key owns the node at once', async () => {
  const old = newSeed();
  await run(async (c, state) => {
    const r = (await c.post('/api/start', { control: 'words', action: 'restore', words: old.words.join(' ') })).json;
    assert.equal(r.ok, true, r.why);
    const key = ownerKeyOf(old.seed).pubkey;
    assert.deepEqual(r.owner, { mode: 'seed', pubkey: key });
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([!!st.done.seed, !!st.done.owner, st.owner.mode, st.owner.pubkey], [true, true, 'seed', key]);
    assert.equal(ownerFile(state).pubkey, key);
    assert.equal(ownerFile(state).nostrSeed, undefined);
  });
});

test('#648 Nostr, new and restore: the nsec owns the node (nostrSeed), the owner door\'s "own key" is the nsec, not the seed it gives', async () => {
  for (const action of ['new', 'restore']) {
    const key = newNsec();
    await run(async (c, state) => {
      const r = (await c.post('/api/start', { control: 'nostr', action, nsec: key.nsec })).json;
      assert.equal(r.ok, true, r.why);
      assert.deepEqual(r.owner, { mode: 'nostr', pubkey: key.pubkey });
      const st = (await c.get('/api/state')).json;
      assert.deepEqual([st.control, st.origin, !!st.done.owner, st.owner.pubkey, st.nostrPubkey], ['nostr', action, true, key.pubkey, key.pubkey]);
      assert.deepEqual([ownerFile(state).pubkey, ownerFile(state).nostrSeed], [key.pubkey, true]);
      // the owner step opened again and saved with "my own key": the nsec's key, never the seed's (whose words a Nostr node never shows)
      const o = (await c.post('/api/owner', { mode: 'seed' })).json;
      assert.deepEqual(o.owner, { mode: 'nostr', pubkey: key.pubkey });
      assert.notEqual(key.pubkey, ownerKeyOf(seedOfNsec(key.nsec).seed).pubkey);
      const h = (await c.get('/api/owner/handoff')).json;
      assert.deepEqual([h.ok, h.kind], [true, 'nsec'], 'the nsec is handed to the dashboard: it is the owner');
    });
  }
});

test('#648 another Nostr key as owner: bound for new words at their seed step, restored words and a Nostr node at once', async () => {
  // new words + another owner (also "Log in with an extension or a phone signer (owner only)": the node gets words of its own)
  await run(async (c, state) => {
    assert.match((await c.post('/api/start', { control: 'words', action: 'new', ownerNpub: 'npub1nope' })).json.why, /neither an npub nor 64 hex/);
    const r = (await c.post('/api/start', { control: 'words', action: 'new', ownerNpub: otherNpub })).json;
    assert.deepEqual(r, { ok: true, control: 'words', origin: 'new', owner: { mode: 'nostr', pubkey: other.pubkey } });
    assert.equal((await c.get('/api/state')).json.done.owner, undefined, 'bound only once the node has its words');
    const s = await confirmWords(c);
    assert.deepEqual(s.owner, { mode: 'nostr', pubkey: other.pubkey });
    const st = (await c.get('/api/state')).json;
    assert.deepEqual([!!st.done.owner, st.owner, st.ownerNpub], [true, { mode: 'nostr', pubkey: other.pubkey }, otherNpub]);
    assert.equal(ownerFile(state).pubkey, other.pubkey);
    assert.equal((await c.get('/api/owner/handoff')).json.ok, false, 'no words handed over: they do not log in');
  });
  // the start step taken again without the other key, before the words: the words' own key after all
  await run(async (c) => {
    await c.post('/api/start', { control: 'words', action: 'new', ownerNpub: otherNpub });
    await c.post('/api/start', { control: 'words', action: 'new' });
    const s = await confirmWords(c);
    assert.equal(s.owner.mode, 'seed');
  });
  // restored words + another owner
  await run(async (c, state) => {
    const r = (await c.post('/api/start', { control: 'words', action: 'restore', words: newSeed().words.join(' '), ownerNpub: other.pubkey })).json;
    assert.deepEqual([r.ok, r.owner], [true, { mode: 'nostr', pubkey: other.pubkey }]);
    assert.equal(ownerFile(state).pubkey, other.pubkey);
  });
  // a Nostr node + another owner: the node runs on its nsec, another key logs in; the nsec is not handed over as the owner's
  await run(async (c, state) => {
    const key = newNsec();
    const r = (await c.post('/api/start', { control: 'nostr', action: 'new', nsec: key.nsec, ownerNpub: otherNpub })).json;
    assert.deepEqual([r.ok, r.owner], [true, { mode: 'nostr', pubkey: other.pubkey }]);
    assert.deepEqual([ownerFile(state).pubkey, ownerFile(state).nostrSeed], [other.pubkey, undefined]);
    assert.equal((await c.get('/api/owner/handoff')).json.ok, false);
    // back to its own key from the owner step
    assert.deepEqual((await c.post('/api/owner', { mode: 'seed' })).json.owner, { mode: 'nostr', pubkey: key.pubkey });
    assert.deepEqual([ownerFile(state).pubkey, ownerFile(state).nostrSeed], [key.pubkey, true]);
  });
});

test('#648 an installed node run again: its owner and owner file stay (#2099), unless another key is named', async () => {
  const words = newSeed();
  const seedHex = Buffer.from(words.seed).toString('hex');
  const seedKey = ownerKeyOf(words.seed).pubkey;
  const ALL = ['start', 'chain', 'roles', 'apps', 'seed', 'emergency', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done'];
  const installed = (owner) => (home) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'seed.hex'), seedHex + '\n', { mode: 0o600 });
    nodeState(home).save({ origin: 'new', control: 'words', seedOwnerPubkey: seedKey, owner, done: Object.fromEntries(ALL.map((k) => [k, 1])) });
    writeFileSync(join(home, 'node.db.owner.json'), JSON.stringify({ pubkey: owner.pubkey, claimedAtMs: 1000, leaving: { atMs: 5000 }, settings: { autoUpdate: true } }) + '\n');
  };
  // owned by another key: the start step saved again (new words, the same words restored) keeps it, and the file whole
  await run(async (c, state) => {
    assert.deepEqual((await c.post('/api/start', { control: 'words', action: 'new' })).json, { ok: true, control: 'words', origin: 'new' });
    assert.deepEqual(ownerFile(state), { pubkey: other.pubkey, claimedAtMs: 1000, leaving: { atMs: 5000 }, settings: { autoUpdate: true } });
    const r = (await c.post('/api/start', { control: 'words', action: 'restore', words: words.words.join(' ') })).json;
    assert.deepEqual([r.ok, r.owner], [true, { mode: 'nostr', pubkey: other.pubkey }], 'the owner the node has, kept');
    assert.deepEqual(ownerFile(state), { pubkey: other.pubkey, claimedAtMs: 1000, leaving: { atMs: 5000 }, settings: { autoUpdate: true } }, 'the Leave kept');
    const st = (await c.get('/api/state')).json;
    assert.equal(st.step, 'done', 'the wizard stays where it was');
  }, { before: installed({ mode: 'nostr', pubkey: other.pubkey }) });
  // owned by its words: another key named on the rerun is bound now (the words are written down already)
  await run(async (c, state) => {
    const k = newNsec();
    const r = (await c.post('/api/start', { control: 'words', action: 'new', ownerNpub: k.pubkey })).json;
    assert.deepEqual([r.ok, r.owner], [true, { mode: 'nostr', pubkey: k.pubkey }]);
    assert.equal(ownerFile(state).pubkey, k.pubkey);
    assert.equal((await c.get('/api/state')).json.owner.pubkey, k.pubkey);
    // and the owner step's "My 24 words" takes it back to the words
    assert.deepEqual((await c.post('/api/owner', { mode: 'seed' })).json.owner, { mode: 'seed', pubkey: seedKey });
  }, { before: installed({ mode: 'seed', pubkey: seedKey }) });
});
