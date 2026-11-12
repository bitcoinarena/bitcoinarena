// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 2) of #1814: "a package hostedPlugins refuses returns { ok: false, 422 } instead of throwing ...
// never thrown out of an autoUpdate sweep". The throw is only caught AFTER verifyPackage: checkPackage itself throws a
// TypeError on a package whose cores/clients entries are not objects (pkg.cores [null] passes the count check and the new
// carried-once check, then `c.source` throws; pkg.clients [null] throws at `k.body`). adoptPackage calls verifyPackage outside
// any try, so one network seat (a peer in networkSeats(), no owner act) listing the developer's genuine next version and
// answering /plugin with that genuine package plus `clients: [null]` throws out of takeGame and ends the whole autoUpdate
// sweep - every source after it is never asked, on every sweep (same order each time): the honest seat's update is never taken.
// Safe behaviour: a malformed package is refused (422) and the sweep goes on to the honest seat.
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
import { verifyPackage, packageOf } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'a45r6s2-'));
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

test('#1489 a45 refute #1814 s2-1: a genuine package with a null client entry is refused, not thrown', async () => {
  const v2 = await ticGame({ version: 1, tag: 'u1' });
  const honest = packageOf(v2);
  for (const relayed of [{ ...honest, clients: [null] }, { ...honest, cores: [null] }, { ...honest, clients: {} }]) {
    let r = null, err = null;
    try { r = verifyPackage(relayed, { verify: verifyEd25519, want: toHex(v2.gameId) }); } catch (e) { err = e.message; }
    assert.equal(err, null, `verifyPackage throws on a relayed package (adoptPackage and the autoUpdate sweep throw with it): ${err}`);
    assert.equal(r.ok, false);
  }
});

test('#1489 a45 refute #1814 s2-1: one peer seat answering /plugin with a malformed genuine package does not end the autoUpdate sweep', async () => {
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
    if (req.url.startsWith('/plugin')) { pluginAsks++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...genuine, clients: [null] })); }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => bad.listen(0, '127.0.0.1', ok));
  const M = `http://127.0.0.1:${bad.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'a45r6s2-plugins-'));
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
