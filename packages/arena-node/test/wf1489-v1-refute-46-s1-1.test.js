// kanban #1489 refute of #1538 (r2:fix:hosting:1): the trial's ONE deadline does not cover loadCore's own meta ask.
// trialRun computes `until = now + TRIAL_MS` and passes loadMs: TRIAL_MS AND askMs: TRIAL_MS to loadCore - but loadCore
// itself asks 'meta' (core-driver.js reads DECIDE.name and DECIDE.decide, both may be getters) with the full askMs, not with
// what is left of the trial. A package whose top level spends ~1.1 s (under the load deadline) and whose `name` getter
// spins holds the seat's thread for load + a whole second TRIAL_MS: well past ASK_MS, the bound the fix claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { TRIAL_MS } from '../src/plugin-trial.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 4 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
}

// iterations of a plain integer loop per ms on this machine (the attacker tunes for the seats' hardware the same way)
function perMs() {
  const spin = (k) => { let x = 0; for (let i = 0; i < k; i++) x = (x + i) | 0; return x; };
  spin(5e7);
  const k = 3e8; const t = Date.now(); spin(k); return k / Math.max(1, Date.now() - t);
}

test('#1489-v1-refute-46-s1-1: a slow top level plus a spinning `name` getter holds the seat\'s thread past ASK_MS', () => {
  const rate = perMs();
  let worst = 0, line = '', n = 0;
  const probe = (K) => {
    // passes the scan: no while(true), no for(;;), no clock (the sandbox has none)
    const src = `function burn(k) { let x = 0; for (let i = 0; i < k; i++) x = (x + i) | 0; return x; }\nconst w = burn(${K});\n` +
      `export const DECIDE = { get name() { let x = w; for (let i = 0; i < 1e13; i++) x = (x + i) | 0; return "s" + x; }, ` +
      `decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`;
    const pkg = pkgOf(src, { name: `meta-spin-${n++}` });
    const t0 = Date.now();
    const v = verifyPackage(pkg, { verify: verifyEd25519 });
    const held = Date.now() - t0;
    console.log(`K=${K}: ok=${v.ok} held the thread ${held} ms (${v.why || ''})`);
    if (held > worst) { worst = held; line = v.why || ''; }
    return /\(meta\)/.test(v.why || '');   // the top level finished inside the load deadline
  };
  // the attacker tunes the top level to end just inside the load deadline: a binary search on the work, as one would on the seats' hardware
  let lo = 0, hi = Math.round(rate * TRIAL_MS);
  for (let i = 0; i < 12 && worst <= ASK_MS; i++) { const mid = Math.round((lo + hi) / 2); if (probe(mid)) lo = mid; else hi = mid; }
  for (let i = 0; i < 4 && worst <= ASK_MS; i++) probe(Math.round(lo * 0.97));
  assert.ok(worst <= ASK_MS, `the trial run held the node's own thread ${worst} ms (ASK_MS ${ASK_MS}, TRIAL_MS ${TRIAL_MS}): ${line}`);
});
