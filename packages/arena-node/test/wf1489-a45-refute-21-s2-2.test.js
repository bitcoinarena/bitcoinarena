// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute #1854 (skeptic 2, a stranger after a malicious seat): f67594394 lets a package carry any number of
// ancestors and never decodes the ones below the cut - but the seat that took it keeps them all, decodes them all into its
// hosted entry, and on EVERY GET /plugin (public, anyone) re-hashes, sorts, re-encodes and sends them (chainOf + packageOf).
// A malicious seat fills the 16 MB body with ~25k unsigned junk versions under a genuine game; the honest seat that installs
// it then spends its main thread on them for any stranger who asks, and answers MBs of manifests no one ever verified.
// The bound #1854 set ("at most 64 ancestors decoded / verified") must hold for what the seat keeps and serves too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { testGame } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { MAX_PACKAGE_ANCESTORS } from '../src/plugin-check.js';

const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);
const CH = createHash('sha256').update('x').digest('hex');
const padGame = (v, parent) => testGame({ name: 'p', cores: new Map([[CH, { configs: new Map([['cc'.repeat(32), {}]]) }]]), runTicksMax: 1, version: v, parentManifestId: parent, dev: 'attacker' }).manifest;

test('a seat keeps and serves no more unchecked earlier versions of a game than the bound it checks', async () => {
  const h = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const genuine = await (await fetch(`http://127.0.0.1:${h.port}/plugin?game=${RPS_ID}`)).json();
  const real = genuine.ancestors || [];
  // the window: the attacker's own signed chain on the cut
  const win = []; let parent = new Uint8Array(32).fill(0x5a);
  for (let v = 2; v < 2 + MAX_PACKAGE_ANCESTORS - real.length; v++) { const m = padGame(v, parent); win.push(m); parent = gameIdOf(m); }
  // below the cut: junk versions, each a distinct unsigned manifest, until the package is ~15 MB
  const base = win[0], junk = [];
  let bytes = JSON.stringify(genuine).length;
  for (let v = 0x10000; bytes < 15 * 1024 * 1024; v++) { const hx = toHex(encodeManifest({ ...base, version: v, signature: new Uint8Array(64) })); junk.push(hx); bytes += hx.length + 3; }
  const evil = { ...genuine, ancestors: [...junk, ...win.map((m) => toHex(encodeManifest(m))), ...real] };
  const body = JSON.stringify(evil);
  const x = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise((r) => x.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  const B = `http://127.0.0.1:${b.port}`;
  try {
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = signOwnerRequest({ node, action: 'install', args: { game: RPS_ID, from: `http://127.0.0.1:${x.address().port}` }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${B}/owner/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json();
    console.log(`junk below the cut: ${junk.length}; install ${r.status} ${j.why || ''}`);
    if (r.status !== 200) return;   // refused: nothing kept, nothing served - the bound holds
    const t0 = performance.now();
    const served = await (await fetch(`${B}/plugin?game=${RPS_ID}`)).text();
    const ms = performance.now() - t0;
    const n = JSON.parse(served).ancestors.length;
    console.log(`a stranger's GET /plugin: ${ms.toFixed(0)} ms, ${served.length} bytes, ${n} earlier versions`);
    assert.ok(n <= MAX_PACKAGE_ANCESTORS + real.length + 1, `the seat serves ${n} earlier versions (${served.length} bytes, ${ms.toFixed(0)} ms) - ${junk.length} of them never decoded or verified when it took them`);
  } finally { await h.close(); await b.close(); x.close(); }
});
