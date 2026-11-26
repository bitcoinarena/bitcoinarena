// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT hosting a8-1-1 (P11, gap in the #3679 fix): the kept trial verdict (plugin-package.js TRIAL_CODE / trialKeyOf) names "the trial's own
// code" as plugin-trial.js + core-sandbox.js + plugin-check.js only. What the trial actually decides on is the core realm too - core-host.js
// (the LOCKDOWN), core-driver.js, core-depth.js, core-intrinsics.js - and the sandbox fixes of the last week (#3316 NaN bits, #3358 intrinsics,
// #3242 import(), #2808 driver, #3065 depth) each changed ONLY those files. So after a seat takes a release that closes such a hole, every
// installed version that the OLD build's trial passed keeps its mark: loadInstalled skips the trial and hosts a version the new build's own
// trial refuses. Its head-to-head rounds then open on the seat and every decide at their close fails.
//
// The old build is simulated exactly as #3316 changed it: a copy of this tree with the one #3316 line of core-host.js taken out (a Float64Array
// may be made on a buffer). Everything the mark key reads is byte for byte the same.
// Safe behaviour: a version whose trial the running build refuses is not hosted at start, whatever an older build's mark says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as P from '../src/plugin-package.js';
import { loadCore } from '../src/core-sandbox.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKGS = join(HERE, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A decide adapter that makes a Float64Array on a buffer: fine before #3316, refused by every seat's realm after it
const SRC = `export const DECIDE = { name: 'flt', decide(moves) { const f = new Float64Array(new ArrayBuffer(8)); f[0] = moves.length;
  const out = {}; for (const m of moves) out[m.key] = f[0] > 0 ? 'DRAW' : 'LOSS'; return out; } };\n`;

function game(dir) {
  const file = join(dir, 'flt.mjs'); writeFileSync(file, SRC);
  const hash = sha(Buffer.from(SRC)), cfg = '22'.repeat(32), set = testDonationSet('flt'), key = testDevKey('flt dev');
  const manifest = signManifest({ gameName: 'flt', gameDevPubkey: key.pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'flt', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: 'flt', hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

/** The release before a core-host.js-only sandbox fix: this tree with the #3316 line taken out of core-host.js. */
function olderBuild() {
  const root = mkdtempSync(join(tmpdir(), 'a8-1-1-old-'));
  for (const p of ['arena-node', 'arena-protocol']) {
    cpSync(join(PKGS, p, 'src'), join(root, 'packages', p, 'src'), { recursive: true });
    cpSync(join(PKGS, p, 'package.json'), join(root, 'packages', p, 'package.json'));
  }
  const host = join(root, 'packages', 'arena-node', 'src', 'core-host.js');
  const text = readFileSync(host, 'utf8');
  const line = /^\s*if \(R\.apply\(Set\.prototype\.has, FLOAT, \[k\]\) && isBuffer\(x\)\) throw .*$/m;
  assert.match(text, line, 'the #3316 line is where the fix put it');
  writeFileSync(host, text.replace(line, ''));
  for (const f of ['plugin-trial.js', 'core-sandbox.js', 'plugin-check.js'])
    assert.equal(readFileSync(join(root, 'packages', 'arena-node', 'src', f), 'utf8'), readFileSync(join(PKGS, 'arena-node', 'src', f), 'utf8'));
  return join(root, 'packages', 'arena-node', 'src');
}

test('audit hosting a8-1-1: a version the running build\'s trial refuses is not hosted at start on an older build\'s kept trial mark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a8-1-1-plugins-')), g = game(mkdtempSync(join(tmpdir(), 'a8-1-1-src-')));
  const id = toHex(g.gameId);
  const at = P.installPackage(dir, P.packageOf(g), id);
  const pkg = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));

  // 1. the seat on the older release: the trial passes, the version is hosted, the mark is written
  const Old = await import(pathToFileURL(join(olderBuild(), 'plugin-package.js')).href);
  const before = await Old.loadInstalled(dir, { verify: verifyEd25519 });
  console.log(`a8-1-1 older build: ${before.registrations.length} hosted, refused ${JSON.stringify(before.refused)}`);
  assert.equal(before.registrations.length, 1, 'the older build hosts it (its trial passes)');
  assert.ok(existsSync(join(at, P.TRIAL_MARK_FILE)), 'the older build kept its trial mark');

  // 2. control: the running build's own trial refuses these bytes
  const fresh = P.verifyPackage(pkg, { verify: verifyEd25519, want: id });
  console.log(`a8-1-1 running build, trial run: ok=${fresh.ok} ${fresh.why}`);
  assert.equal(fresh.ok, false, 'the running build\'s trial refuses it');

  // and every decide at a close of its rounds fails on the running build
  let decideWhy = null;
  const box = loadCore({ files: new Map([['core.mjs', SRC]]), entry: 'core.mjs' });
  try { box.call('decide', { moves: [{ key: 'aa'.repeat(32), move: 0 }, { key: 'bb'.repeat(32), move: 1 }], config: {} }); } catch (e) { decideWhy = e.message; } finally { box.end(); }
  console.log(`a8-1-1 running build, decide at a close: ${decideWhy}`);
  assert.ok(decideWhy, 'its decide fails on the running build');

  // 3. the same seat restarted on the running build (main.js -> loadInstalled)
  const after = await P.loadInstalled(dir, { verify: verifyEd25519 });
  console.log(`a8-1-1 running build start: ${after.registrations.length} hosted, refused ${JSON.stringify(after.refused)}`);
  assert.equal(after.registrations.length, 0,
    'the running build hosts a version its own trial refuses: the older build\'s mark stood for it, because the mark key leaves out core-host.js (and core-driver/depth/intrinsics)');
});
