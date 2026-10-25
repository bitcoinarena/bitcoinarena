// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN APP'S DONATION SPLIT, SIGNED BY ITS DEVELOPER (kanban #582, 2026-10-22: only when the game dev is logged in): the browser signs the next version - version + 1, the
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
import { devKeyFromText, splitAsSet, nextVersionWithSplit } from '../src/app-version.js';
import { checkUpdate } from '../src/plugin-check.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { testAttestedGame, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { gameIdOf, manifestStands, manifestBodyId, encodeManifest } from '../../arena-protocol/src/manifest.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { gameInfoStands } from '../../arena-protocol/src/game-info.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seedOf = (word) => createHash('sha256').update(`test game developer: ${word}`).digest();
const keysDir = (...words) => { const d = mkdtempSync(join(tmpdir(), 'app-keys-')); for (const w of words) writeFileSync(join(d, `${w.replace(/\W/g, '-')}.pkcs8`), Buffer.concat([PKCS8_ED25519, seedOf(w)]), { mode: 0o600 }); writeFileSync(join(d, 'notes.txt'), 'not a key'); return d; };
const K = (n) => '02' + String(n).repeat(64).slice(0, 64);
const SPLIT = [{ key: K(1), label: 'dev a', shareBps: 5000 }, { key: K(2), label: 'dev b', shareBps: 3000 }, { key: K(3), label: 'dev c', shareBps: 2000 }];

test('the developer\'s key as the developer has it: PKCS#8 PEM, its DER in base64 or hex, or the seed in hex - anything else refused', () => {
  const seed = seedOf('split-market'), der = Buffer.concat([PKCS8_ED25519, seed]);
  const want = toHex(testDevKey('split-market').pubkey);
  for (const text of [der.toString('base64'), `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`, der.toString('hex'), seed.toString('hex')])
    assert.equal(devKeyFromText(text).pubkey, want);
  assert.equal(devKeyFromText('not a key').ok, false);
  assert.equal(devKeyFromText(Buffer.alloc(48, 1).toString('base64')).ok, false, 'not an Ed25519 PKCS#8');
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

test('POST /owner/apps/split: the version its developer signed in the browser, hosted on the owner\'s request; another key\'s refused; the old one no longer changed', async () => {
  const { registration: g } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'] });
  const { registration: other } = testAttestedGame({ name: 'not-ours', outcomes: ['A', 'B'] });
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [g, other], port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')),
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (args, s = secret) => signOwnerRequest({ node, action: 'apps/split', args, secret: s, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (body) => { const r = await fetch(`${B}/owner/apps/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const old = toHex(g.gameId);
    // what the developer's browser sends: the next version, signed with the developer's key there
    const signedBy = (word, game, recipients) => { const set = splitAsSet(recipients); if (!set.ok) return { game, why: set.why };
      const n = nextVersionWithSplit(game === old ? g : other, set.set, seedOf(word)); return { game, manifest: n.hex, donationSet: n.donationSet, info: n.info }; };
    let listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    assert.deepEqual(listed.map((x) => [x.name, x.newest, x.split.map((y) => y.shareBps)]).sort(), [['not-ours', true, [10000]], ['split-market', true, [10000]]]);
    assert.equal((await post(req(signedBy('split-market', old, SPLIT), ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'not the owner');
    assert.throws(() => signedBy('split-market', toHex(other.gameId), SPLIT), /not this app's developer key/, 'the browser signs only with that app\'s own key');
    // a version signed by another key: refused by the node, as any update by another developer
    const forged = (() => { const set = splitAsSet(SPLIT).set; const { signature: _x, ...body0 } = g.manifest;
      const body = { ...body0, version: 2, parentManifestId: g.gameId, gameDevPubkey: testDevKey('mallory').pubkey, gameDonationSetId: donationSetId(set) };
      const m = { ...body, signature: ed25519.sign(manifestBodyId(body), seedOf('mallory')) };
      return { game: old, manifest: toHex(encodeManifest(m)), donationSet: set.map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })) }; })();
    const f = await post(req(forged));
    assert.equal(f.body.ok, false);
    assert.match(f.body.why, /another developer/, f.body.why);
    const r = await post(req(signedBy('split-market', old, SPLIT)));
    assert.equal(r.status, 200, r.body.why);
    assert.deepEqual([r.body.version, r.body.parent, r.body.replaces, r.body.running], [2, old, old, true]);
    listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    const v2 = listed.find((x) => x.name === 'split-market' && x.version === 2);
    assert.deepEqual(v2.split.map((x) => [x.label, x.shareBps]), [['dev a', 5000], ['dev b', 3000], ['dev c', 2000]]);
    assert.deepEqual([listed.find((x) => x.id === old).supersededBy, listed.find((x) => x.id === old).newest, v2.newest], [v2.id, false, true]);
    assert.match((await post(req(signedBy('split-market', old, SPLIT.map((x, i) => ({ ...x, shareBps: [4000, 4000, 2000][i] })))))).body.why, /a newer version of this app runs here/);
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
  const b = await serve(openStore(), { plugins: [v1, v2], port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')),
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const listed = (await (await fetch(`${B}/owner/plugins`)).json()).hosted;
    assert.deepEqual(listed.map((x) => [x.version, x.newest]).sort(), [[1, false], [2, true]]);
    const n = nextVersionWithSplit(v1, splitAsSet(SPLIT).set, seedOf('split-market'));
    const body = signOwnerRequest({ node, action: 'apps/split', args: { game: toHex(v1.gameId), manifest: n.hex, donationSet: n.donationSet }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${B}/owner/apps/split`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).why, /a newer version of this app runs here/);
  } finally { await b.close(); }
});

test('a game developer key the owner installs on the node: only then the overview lists its apps and the node signs their new split (kanban #582)', async () => {
  const { registration: g } = testAttestedGame({ name: 'split-market', outcomes: ['UP', 'DOWN'] });
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const keys = mkdtempSync(join(tmpdir(), 'app-keys-'));
  const b = await serve(openStore(), { plugins: [g], port: 0, pluginsDir: mkdtempSync(join(tmpdir(), 'arena-plugins-')), appDevKeysDir: join(keys, 'node.db.app-keys'),
    owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, action, args) => { const r = await fetch(`${B}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req(action, args)) }); return { status: r.status, body: await r.json() }; };
    const devs = async () => (await (await fetch(`${B}/owner/app-devs`)).json()).devs;
    assert.deepEqual(await devs(), [], 'no key installed: no game developer here');
    assert.match((await post('/owner/apps/split', 'apps/split', { game: toHex(g.gameId), recipients: SPLIT })).body.why, /no key of this app's developer is installed/);
    assert.equal((await post('/owner/apps/dev-key', 'apps/dev-key', { key: 'not a key' })).status, 400);
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([PKCS8_ED25519, seedOf('split-market')]).toString('base64')}\n-----END PRIVATE KEY-----`;
    const added = (await post('/owner/apps/dev-key', 'apps/dev-key', { key: pem })).body;
    assert.deepEqual([added.ok, added.pubkey, added.apps], [true, toHex(testDevKey('split-market').pubkey), ['split-market']]);
    assert.equal(JSON.stringify(added).includes(seedOf('split-market').toString('hex')), false, 'never the key itself');
    let d = await devs();
    assert.deepEqual(d.map((x) => [x.devKey, x.apps.map((a) => [a.name, a.version, a.split.map((s) => s.shareBps)])]), [[added.pubkey, [['split-market', 1, [10000]]]]]);
    const r = await post('/owner/apps/split', 'apps/split', { game: toHex(g.gameId), recipients: SPLIT });
    assert.equal(r.status, 200, r.body.why);
    d = await devs();
    assert.deepEqual(d[0].apps[0].versions.map((v) => [v.version, v.split.map((s) => s.shareBps)]), [[2, [5000, 3000, 2000]], [1, [10000]]], 'the new split in force, the old one in its history');
    assert.equal((await post('/owner/apps/dev-key', 'apps/dev-key', { remove: added.pubkey })).body.removed, true);
    assert.deepEqual(await devs(), [], 'removed: no game developer here again');
  } finally { await b.close(); }
});
