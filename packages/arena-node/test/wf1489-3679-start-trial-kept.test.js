// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3679, #1489 r1 hosting-1 (gap in #2688): autoUpdateSweep takes one developer-signed next version of a hosted game per sweep (~144 a
// day, unattended, no cap), and every superseded version stays installed. #2688 stopped each version from keeping a core thread, but the
// seat's start (main.js -> loadInstalled, awaited before serve()) still runs verifyPackage - the whole plugin TRIAL (one kept thread plus
// FRESH_FIRST_CASES fresh threads, every case twice, up to TRIAL_MS) - and then registrationFromPackage's sandbox load, for EVERY installed
// version, on the seat's thread, before the seat listens. The developer of any game a seat hosts grows every restart of that seat by one
// trial per 10 minutes, for good.
// Safe behaviour: the start's cost does not grow with the number of versions a developer ever published - superseded versions are not each
// trialed again at start (or their number is bounded): 16 installed versions start in well under 16x the time of one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as P from '../src/plugin-package.js';
const { packageOf, installPackage, loadInstalled, verifyPackage } = P, TRIAL_MARK_FILE = P.TRIAL_MARK_FILE || 'trial-passed.json';   // the base build exports no mark
import { readFileSync } from 'node:fs';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'r1h1-'));
const src = (v) => `export const DECIDE = { name: 'tic', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move)); /* v${v} */
  const w = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = w === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function version(v, parent) {
  const s = src(v), file = join(srcDir, `d${v}.mjs`); writeFileSync(file, s);
  const hash = sha(Buffer.from(s)), cfg = '22'.repeat(32), set = testDonationSet('tic'), key = testDevKey('tic dev');
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version: v, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: 'tic', hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

test('#3679 #1489 r1 hosting-1: a seat\'s restart does not run the trial again for every auto-updated version of a hosted game', async () => {
  const N = 16, games = [];
  let parent = NO_PARENT;
  for (let v = 1; v <= N; v++) { const g = version(v, parent); games.push(g); parent = g.gameId; }
  const one = mkdtempSync(join(tmpdir(), 'r1h1-one-')), many = mkdtempSync(join(tmpdir(), 'r1h1-many-'));
  // as adoptPackage keeps each taken version: the package with its ancestors, oldest first
  games.forEach((g, i) => installPackage(many, packageOf(g, { ancestors: games.slice(0, i).map((x) => x.manifest) }), toHex(g.gameId)));
  installPackage(one, packageOf(games[N - 1], { ancestors: games.slice(0, N - 1).map((x) => x.manifest) }), toHex(games[N - 1].gameId));
  await loadInstalled(one, { verify: verifyEd25519 });   // warm-up (module compile caches), and the first start after the install
  let t = Date.now(); const first = await loadInstalled(many, { verify: verifyEd25519 }); const firstMs = Date.now() - t;
  t = Date.now(); const a = await loadInstalled(one, { verify: verifyEd25519 }); const oneMs = Date.now() - t;
  t = Date.now(); const b = await loadInstalled(many, { verify: verifyEd25519 }); const manyMs = Date.now() - t;
  console.log(`#3679 first start after the installs: ${N} versions ${firstMs} ms (${first.registrations.length} hosted)`);
  console.log(`#3679 restart: 1 version ${oneMs} ms (${a.registrations.length} hosted), ${N} versions ${manyMs} ms (${b.registrations.length} hosted, ${b.refused.length} refused)`);
  assert.equal(first.registrations.length, N);
  assert.equal(b.registrations.length, N, 'every installed version is still hosted');
  // kanban #3679: the trial is not run again for a version whose trial passed at an earlier start. What is left per version at a restart
  // (its manifest chain's signatures, every file's hash, the scan, its cores' load) still grows with the versions kept - bounding the
  // versions kept is a question on the card, not this test's claim.
  assert.ok(manyMs < firstMs / 4, `the restart ran the trial for every one of ${N} versions again: ${manyMs} ms against ${firstMs} ms at the first start`);
});

test('#3679 a kept mark stands only for the same bytes: another key, or a core changed on disk, is not taken', async () => {
  const g = version(1, NO_PARENT), dir = mkdtempSync(join(tmpdir(), 'r1h1-mark-')), id = toHex(g.gameId);
  const at = installPackage(dir, packageOf(g), id);
  const pkg = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));
  const firstLoad = await loadInstalled(dir, { verify: verifyEd25519 });
  assert.equal(firstLoad.registrations.length, 1, JSON.stringify(firstLoad.refused));
  assert.equal(verifyPackage(pkg, { verify: verifyEd25519, want: id, trialedAt: at }).trialKept, true);
  assert.notEqual(verifyPackage(pkg, { verify: verifyEd25519, want: id }).trialKept, true, 'a caller naming no directory always runs the trial');
  writeFileSync(join(at, TRIAL_MARK_FILE), JSON.stringify({ key: '00'.repeat(32) }));
  assert.notEqual(verifyPackage(pkg, { verify: verifyEd25519, want: id, trialedAt: at }).trialKept, true, 'a mark for other bytes is not taken');
  await loadInstalled(dir, { verify: verifyEd25519 });   // marked again
  const core = [...g.cores.keys()][0];
  writeFileSync(join(at, `core-${core}.mjs`), 'export const DECIDE = { name: "x", decide() { return {}; } };\n');
  const after = await loadInstalled(dir, { verify: verifyEd25519 });
  assert.equal(after.registrations.length, 0, 'a core changed on disk under a kept mark is still refused');
});
