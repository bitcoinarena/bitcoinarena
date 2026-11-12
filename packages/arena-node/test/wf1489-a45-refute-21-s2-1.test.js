// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute #1854 (skeptic 2, a malicious seat poisons an honest one): since f67594394 checkPackage reads only the
// newest 64 ancestors and takes everything below the cut WITHOUT decoding it - but the seat still KEEPS every entry
// (adoptPackage keeps pkg.ancestors on a fresh install, registrationFromPackage decodes them all into the hosted entry) and
// re-serves them through chainOf, which SORTS BY VERSION. A forged, unsigned entry hidden below the cut with a huge version
// then lands at the top of the re-served chain, inside every peer's window: honest seat B takes the genuine game from
// malicious seat X, and from then on no honest seat D can take the game from B (and B's own next split is refused the same
// way - hostSplit packs chainOf too). A package one seat accepted must be accepted from it by the next.
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

test('a genuine game an honest seat took from a malicious one can still be taken from that honest seat', async () => {
  const h = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const genuine = await (await fetch(`http://127.0.0.1:${h.port}/plugin?game=${RPS_ID}`)).json();
  const real = genuine.ancestors || [];
  const pad = filler(64 - real.length).map((m) => toHex(encodeManifest(m)));
  // below the cut: not decoded by checkPackage - an unsigned manifest claiming version 2^31-1
  const forged = toHex(encodeManifest({ ...decodeManifest(fromHex(pad[0])), version: 0x7fffffff, signature: new Uint8Array(64) }));
  const evil = { ...genuine, ancestors: [forged, ...pad, ...real] };
  const x = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(evil)); });
  await new Promise((r) => x.listen(0, '127.0.0.1', r));
  const b = await ownerSeat(), d = await ownerSeat();
  try {
    const [st1, j1] = await b.install(`http://127.0.0.1:${x.address().port}`);
    assert.equal(st1, 200, `B takes the genuine game from X: ${j1.why}`);
    const [st2, j2] = await d.install(b.url);
    assert.equal(st2, 200, `honest D cannot take the game from honest B any more: ${j2.why}`);
  } finally { await h.close(); await b.s.close(); await d.s.close(); x.close(); }
});
