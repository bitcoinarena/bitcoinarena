// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3 (hosting): ONE PEER SEAT HOLDS EVERY AUTOMATIC APP UPDATE. autoUpdate reads each network seat's GET /games
// and, for every listed manifest whose parent is hosted here and whose (unsigned, as listed) dev key and version look like the next
// version, calls takeGame - one at a time, each waiting up to 15 s on that seat's GET /plugin. A seat that lists many made-up ids
// with the real next manifest and never answers /plugin keeps the sweep on itself, so the honest seat after it is never asked.
// Safe behaviour: the honest seat's genuine update is still taken within a few seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ownerSecretFromSeed } from '../src/owner.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'arena-tic-'));
const ticSource = (tag) => `export const DECIDE = { name: 'tic ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
async function ticGame({ version, parent = NO_PARENT, tag = 'v' + version }) {
  const src = ticSource(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet('tic');
  const key = testDevKey('tic dev');
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `tic ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

test('#1489 r3 hosting-1: one seat listing made-up update ids with a hanging /plugin does not hold the honest seat\'s automatic update', async () => {
  const v1 = await ticGame({ version: 1, tag: 'h1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 'h2' });
  const c = await serve(openStore(), { plugins: [{ ...v2, ancestors: [v1.manifest] }], port: 0 });
  // THE BAD SEAT: lists v2's real manifest under 60 made-up ids (nothing signed by it), and never answers GET /plugin
  let pluginAsks = 0;
  const hanging = [];
  const bad = http.createServer((req, res) => {
    if (req.url.startsWith('/games')) {
      const games = Array.from({ length: 60 }, (_, i) => ({ id: sha(Buffer.from('fake' + i)), manifest: toHex(encodeManifest(v2.manifest)) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ games }));
    }
    if (req.url.startsWith('/plugin')) { pluginAsks++; hanging.push(res); return; }   // never answered
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => bad.listen(0, '127.0.0.1', ok));
  const M = `http://127.0.0.1:${bad.address().port}`, C = `http://127.0.0.1:${c.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  // the network's seats as this seat finds them (no owner sources): the bad seat first, the honest one after it
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, peers: [M, C],
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`, id2 = toHex(v2.gameId);
    let seen = [];
    for (let i = 0; i < 60 && !seen.includes(id2); i++) { await new Promise((r) => setTimeout(r, 100)); seen = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id); }
    console.log(`bad seat /plugin asks: ${pluginAsks}; hosted after 6 s: ${seen.map((x) => x.slice(0, 8)).join(',')}`);
    assert.ok(seen.includes(id2), 'the honest seat\'s genuine v2 is taken within 6 s although one seat lists made-up ids and stalls /plugin');
  } finally {
    for (const r of hanging) { try { r.destroy(); } catch { /* gone */ } }
    bad.closeAllConnections?.(); bad.close();
    await b.close(); await c.close();
  }
});

test('#1489 r3 hosting-1 control: with only the honest seat, the same update is taken', async () => {
  const v1 = await ticGame({ version: 1, tag: 'k1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 'k2' });
  const c = await serve(openStore(), { plugins: [{ ...v2, ancestors: [v1.manifest] }], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, peers: [`http://127.0.0.1:${c.port}`],
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`, id2 = toHex(v2.gameId);
    let seen = [];
    for (let i = 0; i < 60 && !seen.includes(id2); i++) { await new Promise((r) => setTimeout(r, 100)); seen = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id); }
    assert.ok(seen.includes(id2));
  } finally { await b.close(); await c.close(); }
});
