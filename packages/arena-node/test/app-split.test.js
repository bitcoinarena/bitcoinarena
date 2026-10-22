// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN APP'S DONATION SPLIT, CHANGED FROM THE OWNER PAGE (kanban #578, ruling A): the node signs the app's next version - version + 1, the
// version it replaces as its parent, the new set - with the app's developer key from its app-keys folder, and hosts it at once; it
// stands as an update. Only the newest version, only with the app's own key, only a set that stands and is new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { appKeysIn, splitAsSet, nextVersionWithSplit } from '../src/app-split.js';
import { checkUpdate } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { testAttestedGame, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { gameInfoStands } from '../../arena-protocol/src/game-info.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seedOf = (word) => createHash('sha256').update(`test game developer: ${word}`).digest();
const keysDir = (...words) => { const d = mkdtempSync(join(tmpdir(), 'app-keys-')); for (const w of words) writeFileSync(join(d, `${w.replace(/\W/g, '-')}.pkcs8`), Buffer.concat([PKCS8_ED25519, seedOf(w)]), { mode: 0o600 }); writeFileSync(join(d, 'notes.txt'), 'not a key'); return d; };
const K = (n) => '02' + String(n).repeat(64).slice(0, 64);
const SPLIT = [{ key: K(1), label: 'dev a', shareBps: 5000 }, { key: K(2), label: 'dev b', shareBps: 3000 }, { key: K(3), label: 'dev c', shareBps: 2000 }];

test('the keys in the folder: each PKCS#8 Ed25519 file by its public key, anything else skipped', () => {
  const keys = appKeysIn(keysDir('split-market', 'other-app'));
  assert.deepEqual([...keys.keys()].sort(), [toHex(testDevKey('split-market').pubkey), toHex(testDevKey('other-app').pubkey)].sort());
  assert.equal(appKeysIn(null).size, 0);
  assert.equal(appKeysIn('/nonexistent/app-keys').size, 0);
});

test('the next version: version + 1, its parent the one it replaces, the new set named, signed by the same developer, its description signed again', () => {
  const { registration: g } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'] });
  const set = splitAsSet(SPLIT);
  assert.equal(set.ok, true, set.why);
  const info = { description: 'Up or down', website: 'https://example.com' };
  const signedInfo = { ...info, signature: new Uint8Array(64) };
  const n = nextVersionWithSplit({ ...g, info: signedInfo }, set.set, seedOf('split-market'));
  assert.deepEqual([n.manifest.version, toHex(n.manifest.parentManifestId), toHex(n.manifest.gameDonationSetId)], [2, toHex(g.gameId), toHex(donationSetId(set.set))]);
  assert.equal(manifestStands(n.manifest, { verify: verifyEd25519, parentOf: (id) => (toHex(id) === toHex(g.gameId) ? g.manifest : null) }).ok, true);
  assert.equal(checkUpdate({ gameId: toHex(g.gameId), devKey: toHex(g.manifest.gameDevPubkey), version: 1 }, { devKey: toHex(n.manifest.gameDevPubkey), parent: toHex(n.manifest.parentManifestId), version: 2 }).ok, true, 'it stands as an update');
  assert.equal(gameInfoStands(n.info, { gameId: gameIdOf(n.manifest), manifest: n.manifest, verify: verifyEd25519 }).ok, true);
  assert.deepEqual(n.donationSet.map((r) => [r.label, r.shareBps]), [['dev a', 5000], ['dev b', 3000], ['dev c', 2000]]);
  assert.throws(() => nextVersionWithSplit(g, set.set, seedOf('other-app')), /not this app's developer key/);
  assert.match(splitAsSet([{ key: K(1), label: 'a', shareBps: 6000 }]).why, /sum to 6000/);
  assert.match(splitAsSet([{ key: 'zz', label: 'a', shareBps: 10000 }]).why, /33-byte key|key/);
});

test('POST /owner/apps/split: signed by the owner, the new version hosted at once and shown with its split; the old one is no longer changed', async () => {
  const { registration: g } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'] });
  const { registration: other } = testAttestedGame({ name: 'not-ours', outcomes: ['A', 'B'] });
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [g, other], port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')), appKeysDir: keysDir('split-market'),
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (args, s = secret) => signOwnerRequest({ node, action: 'apps/split', args, secret: s, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (body) => { const r = await fetch(`${B}/owner/apps/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const old = toHex(g.gameId);
    let listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    assert.deepEqual(listed.map((x) => [x.name, x.canSplit]).sort(), [['not-ours', false], ['split-market', true]]);
    assert.deepEqual(listed.find((x) => x.name === 'split-market').split.map((x) => x.shareBps), [10000]);
    assert.equal((await post(req({ game: old, recipients: SPLIT }, ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'not the owner');
    assert.equal((await post(req({ game: toHex(other.gameId), recipients: SPLIT }))).status, 403, 'no key for that app here');
    const same = listed.find((x) => x.name === 'split-market').split;
    assert.match((await post(req({ game: old, recipients: same }))).body.why, /the split it already has/);
    assert.match((await post(req({ game: old, recipients: SPLIT.slice(0, 2) }))).body.why, /sum to 8000/);
    const r = await post(req({ game: old, recipients: SPLIT }));
    assert.equal(r.status, 200, r.body.why);
    assert.deepEqual([r.body.version, r.body.parent, r.body.replaces, r.body.running], [2, old, old, true]);
    listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    const v2 = listed.find((x) => x.name === 'split-market' && x.version === 2);
    assert.deepEqual(v2.split.map((x) => [x.label, x.shareBps]), [['dev a', 5000], ['dev b', 3000], ['dev c', 2000]]);
    assert.equal(listed.find((x) => x.id === old).supersededBy, v2.id);
    assert.match((await post(req({ game: old, recipients: SPLIT.map((x, i) => ({ ...x, shareBps: [4000, 4000, 2000][i] })) }))).body.why, /a newer version of this app runs here/);
    // other nodes take it from here as an update: the package this node hands out stands, on its parent
    const pkg = await (await fetch(`${B}/plugin?game=${v2.id}`)).json();
    assert.equal(pkg.ancestors.length, 1);
    assert.equal(toHex(donationSetId(pkg.donationSet.map((x) => ({ recipientPk: Buffer.from(x.recipientPk, 'hex'), shareBps: x.shareBps, label: x.label })))), toHex(donationSetId(splitAsSet(SPLIT).set)));
  } finally { await b.close(); }
});

test('only an app\'s newest version takes a new split: an older built-in version is refused and not offered (measured on node 2)', async () => {
  const { registration: v1 } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'] });
  const { registration: v2 } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'], version: 2, parentManifestId: v1.gameId });
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [v1, v2], port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')), appKeysDir: keysDir('split-market'),
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    assert.deepEqual(listed.map((x) => [x.version, x.canSplit]).sort(), [[1, false], [2, true]]);
    const body = signOwnerRequest({ node, action: 'apps/split', args: { game: toHex(v1.gameId), recipients: SPLIT }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${B}/owner/apps/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).why, /a newer version of this app runs here/);
  } finally { await b.close(); }
});
