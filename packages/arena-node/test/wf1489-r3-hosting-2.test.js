// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

// kanban #1489 round 3 (hosting-2): takeGame reads a seat's GET /plugin answer whole (r.json(), no byte limit) - reached without the
// owner by the automatic update, from any network seat that lists a manifest naming a hosted game as its parent (the listing is not
// signature-checked before the fetch). Safe behaviour: the reader stops well before 64 MB; a game package is a few hundred kB.

test('#1489 r3 hosting-2: a seat\'s oversized GET /plugin answer is not read whole by the automatic update', async () => {
  const v1 = await ticGame({ version: 1, tag: 'm1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 'm2' });
  const TOTAL = 200 * 1024 * 1024, CHUNK = Buffer.alloc(1024 * 1024, 0x61);
  let sent = 0, finished = false, asked = 0;
  const bad = http.createServer((req, res) => {
    if (req.url.startsWith('/games')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ games: [{ id: sha(Buffer.from('fake')), manifest: toHex(encodeManifest(v2.manifest)) }] }));
    }
    if (req.url.startsWith('/plugin')) {
      if (asked++) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"format":"arena-plugin/v1","pad":"');
      const pump = () => {
        while (sent < TOTAL) { sent += CHUNK.length; if (!res.write(CHUNK)) { res.once('drain', pump); return; } }
        res.end('"}', () => { finished = true; });
      };
      res.on('close', () => {});
      return pump();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => bad.listen(0, '127.0.0.1', ok));
  const M = `http://127.0.0.1:${bad.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, peers: [M],
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    for (let i = 0; i < 120 && !finished && !(asked && sent >= TOTAL); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    console.log(`bad seat wrote ${Math.round(sent / 1048576)} MB of /plugin; whole answer taken: ${finished}`);
    assert.ok(asked >= 1, 'the automatic update asked the seat for the package');
    assert.ok(!finished && sent < 64 * 1024 * 1024, `a package answer is cut off before 64 MB (taken: ${Math.round(sent / 1048576)} MB)`);
  } finally {
    bad.closeAllConnections?.(); bad.close();
    await b.close();
  }
});
