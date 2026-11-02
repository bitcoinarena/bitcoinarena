// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FOUNDERS' DKG BY FILES (spec 5A.3B, kanban #972): each founder on its own store and nothing but a shared folder between them. One key, a founder that never dealt still holds its share, a
// bad deal is named and dropped, and what each keeps opens the key genesis names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { plan, deal, sign, finish } from '../tools/founders-dkg.mjs';
import { openStore, nodeIdentity } from '../src/store.js';
import { CensusKeyStore } from '../src/census-key-store.js';
import { feldmanGroup } from '../src/curve.js';
import { censusKey0Stands } from '../../arena-protocol/src/genesis.js';
import { decodeCensusDeal, encodeCensusDeal, joinSignedCensusDeal, lagrangeOf, censusDealId, splitSignedCensusDeal } from '../../arena-protocol/src/census-dkg.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function founders(n) {
  const root = mkdtempSync(join(tmpdir(), 'founders-dkg-'));
  const list = Array.from({ length: n }, (_, i) => {
    const store = join(root, `node-${i}.db`), db = openStore(store), id = nodeIdentity(db);
    db.close();
    return { store, secret: id.secret, key: toHex(schnorr.getPublicKey(id.secret)) };
  });
  return { root, dir: join(root, 'shared'), list, done: () => rmSync(root, { recursive: true, force: true }) };
}
const heldBy = (f, publicKey) => { const db = openStore(f.store); const h = new CensusKeyStore(db).held(fromHex(publicKey), 0); db.close(); return h; };

test('four founders by files: one key, every share kept, and the shares open it', async () => {
  const f = founders(4);
  try {
    const p = plan({ founders: f.list.map((x) => x.key), network: 'regtest', dir: f.dir });
    assert.equal(p.threshold, 3);
    for (const x of f.list) assert.equal((await deal({ store: x.store, dir: f.dir })).again, false);
    assert.equal((await deal({ store: f.list[0].store, dir: f.dir })).again, true, 'a founder deals once: its deal stays');
    const said = [];
    for (const x of f.list) said.push(await sign({ store: x.store, dir: f.dir }));
    assert.deepEqual(said.map((s) => s.ok), [true, true, true, true]);
    assert.equal(new Set(said.map((s) => s.recordId)).size, 1, 'one record');
    await assert.rejects(finish({ store: f.list[0].store, dir: join(f.root, 'nowhere') }), /ENOENT/);
    const out = [];
    for (const x of f.list) out.push(await finish({ store: x.store, dir: f.dir }));
    assert.equal(new Set(out.map((o) => JSON.stringify({ ...o, signers: 0 }))).size, 1, 'every founder prints the same census_key_0');
    const k0 = { publicKey: fromHex(out[0].publicKey), holders: out[0].holders.map(fromHex), threshold: out[0].threshold };
    assert.equal(censusKey0Stands(k0, { minHolders: 2, sharesMax: 1024 }).ok, true);
    const shares = new Map();
    for (const x of f.list) for (const [i, v] of heldBy(x, out[0].publicKey).shares) shares.set(i, v);
    assert.equal(shares.size, 4);
    const ids = [...shares.keys()].slice(0, 3), l = lagrangeOf(ids, ids);
    assert.equal(toHex(feldmanGroup.pointFromScalar(ids.reduce((a, i) => (a + l.get(i) * shares.get(i)) % N, 0n))).slice(2), out[0].publicKey, 'any three shares open it');
    assert.deepEqual([...heldBy(f.list[2], out[0].publicKey).shares.keys()], [out[0].holders.indexOf(f.list[2].key) + 1], 'the x of a founder is its place in genesis');
  } finally { f.done(); }
});

test('a founder that never dealt still holds its share, while those that did reach the threshold', async () => {
  const f = founders(4);
  try {
    plan({ founders: f.list.map((x) => x.key), network: 'regtest', dir: f.dir });
    for (const x of f.list.slice(0, 3)) await deal({ store: x.store, dir: f.dir });
    for (const x of f.list) assert.equal((await sign({ store: x.store, dir: f.dir })).dealers, 3);
    const out = await finish({ store: f.list[3].store, dir: f.dir });
    assert.equal(heldBy(f.list[3], out.publicKey).shares.size, 1);
  } finally { f.done(); }
});

test('a deal that is not on its polynomial: a founder names it, the proof is in the folder, the others drop it and sign one record', async () => {
  const f = founders(4);
  try {
    plan({ founders: f.list.map((x) => x.key), network: 'regtest', dir: f.dir });
    for (const x of f.list) await deal({ store: x.store, dir: f.dir });
    // founder 3 seals a bad share to founder 0: everything else of its deal is right, and it signs what it sends
    const path = join(f.dir, `deal-${f.list[3].key}.bin`);
    const parts = splitSignedCensusDeal(new Uint8Array(readFileSync(path))), d = decodeCensusDeal(parts.bytes);
    const x = JSON.parse(readFileSync(join(f.dir, 'plan.json'), 'utf8')).holders.indexOf(f.list[0].key) + 1;
    d.sealed[x - 1].bytes = Uint8Array.from(d.sealed[x - 1].bytes, (b, i) => (i === 31 ? b ^ 1 : b));
    writeFileSync(path, joinSignedCensusDeal(encodeCensusDeal(d), schnorr.sign(censusDealId(d), f.list[3].secret)));
    const first = await sign({ store: f.list[0].store, dir: f.dir });
    assert.equal(first.ok, false);
    assert.deepEqual(first.complaints, [f.list[3].key]);
    assert.equal(readdirSync(f.dir).filter((n) => n.startsWith('complaint-')).length, 1);
    const said = [];
    for (const x of f.list) said.push(await sign({ store: x.store, dir: f.dir }));
    assert.deepEqual(said.map((s) => s.ok), [true, true, true, true]);
    assert.equal(new Set(said.map((s) => s.recordId)).size, 1);
    assert.equal(said[0].dealers, 3);
    const out = await finish({ store: f.list[1].store, dir: f.dir });
    assert.equal(out.threshold, 3);
  } finally { f.done(); }
});

test('the plan refuses what genesis would, and the command line runs a step', () => {
  const f = founders(4);
  try {
    assert.throws(() => plan({ founders: f.list.map((x) => x.key), network: 'mainnet', dir: f.dir }), /under the census minimum of 10/);
    assert.throws(() => plan({ founders: [f.list[0].key, f.list[0].key, f.list[1].key], network: 'regtest', dir: f.dir }), /names a holder twice/);
    const file = join(f.root, 'founders.txt');
    writeFileSync(file, `${f.list.map((x) => x.key).join('\n')}\n`);
    const said = execFileSync(process.execPath, [new URL('../tools/founders-dkg.mjs', import.meta.url).pathname, 'plan', '--founders', file, '--network', 'regtest', '--dir', f.dir], { encoding: 'utf8' });
    assert.equal(JSON.parse(said).threshold, 3);
  } finally { f.done(); }
});
