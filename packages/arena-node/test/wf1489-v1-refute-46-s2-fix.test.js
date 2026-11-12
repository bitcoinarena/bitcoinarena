// kanban #1880, #1913 (the fix of #1489 refute 46 s2): EACH case measured alone - the next one starts only once the earlier
// trial's thread is gone - so the top-level and the second decide case are timed too, not answered by the `retry` refusal.
// From the refute (skeptic 2) of #1538 / #1719: the trial's ONE deadline is kept by Atomics.wait in the seat's thread and
// by terminate() of the core's thread - but end() then waits up to EXIT_WAIT_MS (3000 ms) for that thread to be gone. A core
// sitting in ONE long builtin that V8 does not interrupt (a sort, a parse) is not gone until the builtin returns, so the
// seat's thread is held for TRIAL_MS + that builtin's tail, past ASK_MS. Probe: several such builtins inside decide().
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ASK_MS, lingeringCores } from '../src/core-sandbox.js';
import { TRIAL_MS } from '../src/plugin-trial.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

// 2.0 (kanban #1489 port of #1880): a trial loads each core under its own name, as the seat does (#1694), not 'plugin trial' - so every
// lingering core thread is waited for here
const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 4 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] };
}

const LCG = `let s = 12345; const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);`;
// ONE builtin call: Array.prototype.sort with the default comparison (numbers compared as strings) - not interrupted by terminate()
const SORT = `${LCG} const a = new Array(6e6); for (let i = 0; i < a.length; i++) a[i] = rnd(); a.sort();`;
const CASES = [
  ['in decide, run 1', `let done = 0;\nexport const DECIDE = { name: "x", decide(moves) { if (!done) { done = 1; ${SORT} }\nconst out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`],
  ['in decide, run 2', `let done = 0;\nexport const DECIDE = { name: "y", decide(moves) { if (!done) { done = 1; ${SORT} }\nconst out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`],
  ['at the top level (load)', `${SORT}\nexport const DECIDE = { name: "z", decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`],
];

test('#1880/#1913: each uninterruptible builtin, measured alone, holds the seat\'s thread at most ASK_MS; the next trial waits for nothing', async () => {
  let n = 0;
  for (const [what, src] of CASES) {
    for (let t = Date.now(); lingeringCores() && Date.now() - t < 60000;) await new Promise((r) => setTimeout(r, 50));
    assert.equal(lingeringCores(), 0, 'the earlier trial\'s thread is gone once its builtin returns');
    const pkg = pkgOf(src, { name: `alone-${n++}` });
    const t0 = Date.now();
    const v = verifyPackage(pkg, { verify: verifyEd25519 });
    const held = Date.now() - t0;
    console.log(`${what}: ok=${v.ok} trial=${v.trial} held ${held} ms (${(v.why || '').slice(0, 160)})`);
    assert.equal(v.ok, false); assert.equal(v.trial, true, `${what}: a verdict of the trial, not a retry`);
    assert.ok(held <= ASK_MS, `${what}: held ${held} ms (ASK_MS ${ASK_MS}, TRIAL_MS ${TRIAL_MS})`);
    // a trial started while that thread still sorts is refused at once, as no verdict
    if (lingeringCores()) {
      const t1 = Date.now(); const w = verifyPackage(pkgOf(CASES[0][1].replace('name: "x"', 'name: "w"'), { name: `retry-${n}` }), { verify: verifyEd25519 });
      assert.ok(Date.now() - t1 <= 200); assert.equal(w.retry, true); assert.notEqual(w.trial, true);
    }
  }
  // and an honest adapter is taken once the threads are gone
  for (let t = Date.now(); lingeringCores() && Date.now() - t < 60000;) await new Promise((r) => setTimeout(r, 50));
  const ok = verifyPackage(pkgOf(`export const DECIDE = { name: "h", decide(moves) { const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out; } };`, { name: 'honest' }), { verify: verifyEd25519 });
  assert.equal(ok.ok, true, ok.why);
});
