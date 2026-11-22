// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3 (hosting): EVERY VERSION A GAME DEVELOPER EVER PUBLISHED IS LOADED, EACH IN A LIVE CORE THREAD, AT EVERY START.
// autoUpdate takes a hosted game's next signed version unattended, one per sweep (every 10 min), with no bound on how many: the
// version it replaces stays installed and hosted, and nothing ever retires it. At start, loadInstalled (registrationFromPackage)
// and hostedPlugins load every installed version's core into its sandbox - sandboxFor keyed by the version's own directory, so
// the same core bytes in 2 versions are 2 threads - and each loaded core keeps a thread of its own (its kept context, with what
// its top level allocated: up to the 64 MB array budget plus its 128 MB heap) for CORE_IDLE_MS (15 min). A developer that signs
// 144 versions a day (each a valid split change) makes every seat that hosts the game start with 144+ core threads at once,
// each holding what its top level kept - the seat runs out of memory at every start, and every game it hosts goes with it.
// Safe behaviour: the number of core threads a seat holds after loading one game's installed versions is bounded (superseded
// versions are not each kept loaded at once), whatever the number of versions its developer published.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPackage, loadInstalled } from '../src/plugin-package.js';
import { hostedPlugins } from '../src/plugins.js';
import { endIdleCores } from '../src/core-sandbox.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MB = 24;
// one honest decide; its top level keeps MB of arrays (inside the 64 MB array budget, so the trial and the load take it)
const SRC = `const kept = new Uint8Array(${MB} * 1048576); kept.fill(7);
export const DECIDE = { name: 'heavy', decide(moves) { const out = {}; let best = 0; for (const m of moves) if (m.move > best) best = m.move;
  const w = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = w === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS';
  out[moves[0].key] = kept[0] === 7 ? out[moves[0].key] : 'LOSS'; return out; } };\n`;
const HASH = sha(Buffer.from(SRC));
const CFG = '33'.repeat(32);
const dev = testDevKey('version spammer');
const set = testDonationSet('version spammer');

function versionChain(n) {
  const out = [];
  let parent = NO_PARENT;
  for (let v = 1; v <= n; v++) {
    const m = signManifest({ gameName: 'spam', gameDevPubkey: dev.pubkey, version: v, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
      cores: [{ hash: fromHex(HASH), configs: [fromHex(CFG)] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
      rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, dev);
    out.push(m);
    parent = gameIdOf(m);
  }
  return out;
}

test('#1489 r3 hosting-2: a seat holding many installed versions of one game does not keep a core thread for each of them', async () => {
  const VERSIONS = 8;
  const chain = versionChain(VERSIONS);
  const dir = mkdtempSync(join(tmpdir(), 'arena-versions-'));
  // what autoUpdate leaves on disk after VERSIONS - 1 sweeps: every version, each with its chain
  chain.forEach((m, i) => {
    const pkg = { format: 'arena-plugin/v1', name: 'spam', title: 'spam', manifest: toHex(encodeManifest(m)),
      ancestors: chain.slice(0, i).map((a) => toHex(encodeManifest(a))),
      donationSet: set.map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
      cores: [{ hash: HASH, name: 'spam', configs: [CFG], source: Buffer.from(SRC).toString('base64') }], clients: [] };
    installPackage(dir, pkg, toHex(gameIdOf(m)), { title: 'spam' });
  });
  const got = await loadInstalled(dir, { verify: verifyEd25519 });
  assert.deepEqual(got.refused, [], 'every version is a valid installed package');
  assert.equal(got.registrations.length, VERSIONS);
  const hosted = hostedPlugins(got.registrations, { log: () => {} });
  assert.equal(hosted.size, VERSIONS, 'every version is hosted');
  // the cores loaded with a live thread right now (each keeping what its top level allocated, here MB MB)
  const live = endIdleCores(0);
  assert.ok(live <= 2, `after loading ${VERSIONS} installed versions of one game the seat held ${live} core threads at once `
    + `(each keeping ${MB} MB, ${live * MB} MB together) - one per version its developer ever published`);
});
