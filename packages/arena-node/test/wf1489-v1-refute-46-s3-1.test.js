// kanban #1489 refute (skeptic 3) of #1538: THE SECOND LOAD. The trial now runs the adapter in the sandbox under one TRIAL_MS
// deadline - but adoptPackage (owner install, autoUpdate unattended) loads THE SAME untrusted bytes a second time right after it:
// registrationFromPackage -> sandboxFor(core) -> loadCore with the installed-core limits (LOAD_MS 10 s, ASK_MS 2 s, EXIT_WAIT 3 s),
// synchronously on the seat's thread. The core can tell the two loads apart: the trial names its one file `core.mjs`, the
// install names it `core-<hash>.mjs`, and a plain `new Error().stack` shows which (allowed by the scan). So a version that
// passes the trial in ms holds the seat's thread for the whole LOAD_MS at install, and again at every start (loadInstalled).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { TRIAL_MS } from '../src/plugin-trial.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { game, pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

// passes the scan: no clock, no while(true)/for(;;); honest in the trial, spins at the top level when loaded as installed
const twoFaced = 'const inTrial = String(new Error("w").stack).includes("core:/core.mjs");\n' +
  'function burn(k) { let x = 0; for (let i = 0; i < k; i++) x = (x + i) | 0; return x; }\n' +
  'const w = inTrial ? 0 : burn(1e13);\n' +
  'export const DECIDE = { name: "two" + (w & 0), decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };\n';

test('#1489-v1-refute-46-s3-1: a version that passes the trial holds the seat\'s thread when the same bytes are loaded to install', async () => {
  const { game, pkg } = pkgOf(twoFaced, { name: 'twofaced' });
  const t0 = Date.now();
  const v = verifyPackage(pkg, { verify: verifyEd25519 });
  const trialMs = Date.now() - t0;
  console.log(`trial: ok=${v.ok} in ${trialMs} ms (${v.why || ''})`);
  // (fix, kanban #2058, #2078) the trial now names the module as the install does, so this core spins in the trial too and is
  // refused there, within TRIAL_MS. The install load is still measured: a package an older build kept on disk is loaded at start
  if (!v.ok) assert.ok(trialMs <= ASK_MS, `the trial refused it, but held the seat's thread ${trialMs} ms`);
  const dir = mkdtempSync(join(tmpdir(), 'arena-s3-'));
  const at = installPackage(dir, pkg, toHex(game.gameId));
  const t1 = Date.now();
  let why = null;
  try { await registrationFromPackage(at, pkg); } catch (e) { why = e.message; }
  const held = Date.now() - t1;
  console.log(`install load (adoptPackage's registrationFromPackage): held the thread ${held} ms (${why || 'loaded'})`);
  if (!v.ok) assert.ok(held <= ASK_MS, `the install load of bytes the trial refused held the seat's thread ${held} ms: ${why}`);
  else assert.ok(trialMs + held <= ASK_MS, `trial ${trialMs} ms (TRIAL_MS ${TRIAL_MS}) then the install load of the same bytes held the seat's thread ${held} ms: ${why}`);
});
