// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute #1854 (skeptic 3, the window and the served chain disagree): a98067b43 keeps the checked window and serves
// it through chainHex, which puts the cut marker back only when chainOf gives at least MAX_PACKAGE_ANCESTORS versions. But chainOf
// DEDUPLICATES by game id, while checkPackage accepts the same version twice in its window. A malicious seat X sends a genuine
// game with [junk cut, v2..v33, v2..v33]: 65 entries, so the window of 64 stands on the cut. Honest B takes it, keeps the window
// and the marker - and then serves only v2..v33 with NO cut (32 < 64): v2 stands on nothing a peer holds, so honest D refuses the
// game from B (422). Same effect as skeptic 2's forged-version attack, by another road.
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
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);
const CH = createHash('sha256').update('x').digest('hex');
const filler = (n) => {   // the attacker's own validly self-signed chain v2..v(n+1), standing on the cut
  const out = []; let parent = new Uint8Array(32).fill(0x5a);
  for (let v = 2; v < n + 2; v++) { const g = testGame({ name: 'pad', cores: new Map([[CH, { configs: new Map([['cc'.repeat(32), {}]]) }]]), runTicksMax: 1, version: v, parentManifestId: parent, dev: 'attacker' }); out.push(g.manifest); parent = gameIdOf(g.manifest); }
  return out;
};

async function ownerSeat() {
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const s = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  const url = `http://127.0.0.1:${s.port}`;
  const node = (await (await fetch(`${url}/owner`)).json()).node;
  const install = async (from) => {
    const body = signOwnerRequest({ node, action: 'install', args: { game: RPS_ID, from }, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const r = await fetch(`${url}/owner/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return [r.status, await r.json()];
  };
  return { s, url, install };
}

test('a window with repeated versions does not stop an honest seat from handing the game on', async () => {
  const h = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const genuine = await (await fetch(`http://127.0.0.1:${h.port}/plugin?game=${RPS_ID}`)).json();
  const real = genuine.ancestors || [];
  const half = filler((64 - real.length) / 2 | 0).map((m) => toHex(encodeManifest(m)));
  const win = [...half, ...half];
  while (win.length + real.length < 64) win.push(half[half.length - 1]);
  const junk = 'ab'.repeat(40);   // the cut marker: never decoded
  const evil = { ...genuine, ancestors: [junk, ...win, ...real] };
  const x = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(evil)); });
  await new Promise((r) => x.listen(0, '127.0.0.1', r));
  const b = await ownerSeat(), d = await ownerSeat();
  try {
    const [st1, j1] = await b.install(`http://127.0.0.1:${x.address().port}`);
    assert.equal(st1, 200, `B takes the genuine game from X: ${j1.why}`);
    const served = await (await fetch(`${b.url}/plugin?game=${RPS_ID}`)).json();
    const [st2, j2] = await d.install(b.url);
    assert.equal(st2, 200, `honest D cannot take the game from honest B (B serves ${served.ancestors.length} earlier versions): ${j2.why}`);
  } finally { await h.close(); await b.s.close(); await d.s.close(); x.close(); }
});
