// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r2 hosting-1 (bypass of #2307 / #1814 by another field): checkPackage reads a package's donation set through
// Number(r.shareBps) and String(r.label || ''), but registrationFromPackage hands hostedPlugins the raw values. A relaying seat
// (one peer in networkSeats(), no owner act) answers /plugin with the developer's GENUINE next version and only
// donationSet[0].shareBps written as the string "10000" (signed by nobody): verifyPackage passes it (the id still matches),
// adoptPackage writes it to disk, and hostedPlugins refuses it ("no whole share") - answered { checked: true }, so autoUpdate
// marks the parent as tried for the sweep and never asks the honest seat after it. Same order every sweep: the update is never taken.
// Safe behaviour: what is checked is what is hosted - such a package is refused BEFORE it counts as the parent's one try (or
// hosted with the checked values), and the honest seat's genuine v2 is taken.
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
import { verifyPackage, packageOf, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'r2h1-'));
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


test('#1489 r2 hosting-1: what verifyPackage passes, hostedPlugins hosts', async () => {
  const v1 = await ticGame({ version: 1, tag: 'h1' });
  const honest = packageOf(v1);
  const relayed = { ...honest, donationSet: honest.donationSet.map((r) => ({ ...r, shareBps: String(r.shareBps) })) };
  const v = verifyPackage(relayed, { verify: verifyEd25519, want: toHex(v1.gameId) });
  const dir = mkdtempSync(join(tmpdir(), 'r2h1-one-'));
  let hostedErr = null;
  if (v.ok) {
    const at = installPackage(dir, relayed, toHex(v1.gameId));
    const reg = await registrationFromPackage(at, relayed);
    try { hostedPlugins([reg], { log: () => {} }); } catch (e) { hostedErr = e.message; }
  }
  console.log(`verifyPackage ok=${v.ok}; hostedPlugins: ${hostedErr || 'hosted'}`);
  assert.ok(!v.ok || hostedErr === null, `the checks pass a package the seat then cannot host: ${hostedErr}`);
});

test('#1489 r2 hosting-1: a relayed genuine package with a string shareBps does not hold the automatic update', async () => {
  const v1 = await ticGame({ version: 1, tag: 's1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 's2' });
  const c = await serve(openStore(), { plugins: [{ ...v2, ancestors: [v1.manifest] }], port: 0 });
  const C = `http://127.0.0.1:${c.port}`, id2 = toHex(v2.gameId);
  const genuine = await (await fetch(`${C}/plugin?game=${id2}`)).json();
  assert.equal(verifyPackage(genuine, { verify: verifyEd25519, want: id2 }).ok, true, 'the honest seat serves the genuine v2');
  // THE BAD SEAT: a network peer that relays the genuine v2 under its own id, with one client entry nulled (signed by nobody)
  let pluginAsks = 0;
  const bad = http.createServer((req, res) => {
    if (req.url.startsWith('/games')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ games: [{ id: id2, manifest: toHex(encodeManifest(v2.manifest)) }] }));
    }
    if (req.url.startsWith('/plugin')) { pluginAsks++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...genuine, donationSet: genuine.donationSet.map((r) => ({ ...r, shareBps: String(r.shareBps) })) })); }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => bad.listen(0, '127.0.0.1', ok));
  const M = `http://127.0.0.1:${bad.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'r2h1-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, peers: [M, C],
    owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    let seen = [];
    for (let i = 0; i < 60 && !seen.includes(id2); i++) { await new Promise((r) => setTimeout(r, 100)); seen = (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id); }
    console.log(`bad seat /plugin asks: ${pluginAsks}; hosted after 6 s: ${seen.map((x) => x.slice(0, 8)).join(',')}`);
    assert.ok(pluginAsks >= 1, 'the bad seat was asked');
    assert.ok(seen.includes(id2), `the honest seat's genuine v2 is not taken within 6 s: the bad seat's package (asked ${pluginAsks} times) ends every sweep before the honest seat`);
  } finally {
    bad.closeAllConnections?.(); bad.close();
    await b.close(); await c.close();
  }
});
