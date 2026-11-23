// kanban #1489 round 21 (hosting): THE PLUGIN TRIAL RUNS ONLY A HEAD-TO-HEAD GAME'S DECIDE. plugin-trial.js answers
// { ok: true, cases: 0 } for every other result type ("no decide adapter to run"), and checkPackage refuses no result type,
// so a store package (takeGame, or an autoUpdate of an installed game: checkUpdate checks developer, parent and version only)
// whose manifest says REPLAY is installed with its core never run on anything but load + meta. That core's runTicks /
// runTicksFits / step are then asked synchronously on the seat's own thread (plugins.js runLengthFits at every round.open,
// replay.js runTicksIn, the warm ghost's stepTo). A core whose runTicksFits never returns holds the seat ASK_MS (+ its end)
// on EVERY round opened for it - a failed ask is not memoized.
// Safe behaviour: a package whose core the seat would ask is tried on those asks (or refused), so a spinning one is not hosted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { runLengthFits } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('#1489-r21-hosting-2: a REPLAY-type store package whose core spins is not hosted untried', async () => {
  const name = 'replay-untried';
  const src = `export const DECIDE = { name: 'replay-untried', decide(moves) { return {}; } };
export const CORE = { name: 'replay-untried', RUN_TICKS: 100,
  runTicks() { return 100; },
  runTicksFits(t) { let i = 0; while (i >= 0) i++; return true; } };`;
  const cfg = '11'.repeat(32);
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([[cfg, {}]]) };
  const game = testGame({ name, cores: new Map([[core.hash, core]]), runTicksMax: 100 });
  const gameId = toHex(gameIdOf(game.manifest));
  const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: [cfg], source: Buffer.from(src).toString('base64') }], clients: [] };
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log(`verifyPackage: ok=${v.ok} ${v.why || ''} | ${(v.checks || []).at(-1)?.check}: ${(v.checks || []).at(-1)?.detail}`);
  if (!v.ok) return;   // refused: safe
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r21-hosting-2-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const c = [...reg.cores.values()][0];
  const times = [];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    let r; try { r = runLengthFits(c, cfg, 100); } catch (e) { r = { ok: false, why: e.message }; }
    times.push(Date.now() - t0);
    console.log(`round.open's runLengthFits #${i + 1}: ${Date.now() - t0} ms on this thread: ${JSON.stringify(r).slice(0, 160)}`);
  }
  assert.ok(Math.max(...times) < 500, `the package passed the checks untried and holds the seat's thread ${times.join(' ms, ')} ms per round opened`);
});
