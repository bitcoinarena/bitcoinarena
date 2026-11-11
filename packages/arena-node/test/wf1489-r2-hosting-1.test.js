// kanban #1489 round 2 (hosting): THE TRIAL RUN IS THE NODE'S OWN THREAD.
// verifyPackage runs every head-to-head decide adapter of a package in plugin-trial.js's node:vm context - in the seat's own
// thread, with a 200 ms vm timeout per call, up to 2000 move combinations twice each, and no memory limit at all. autoUpdate
// does this unattended every 10 minutes for any signed next version a source seat lists. A game developer (or anyone who signs
// a game an owner installed once) ships a version whose decide passes the scan and:
//   - spends ~190 ms per call: the seat's event loop is held for (cases x 2 x 190 ms) - 4 x 4 x 2 here, 2000 x 2 at most (~760 s);
//   - keeps the arrays it allocates: the sandbox's 64 MB array budget (core-sandbox.js) does not apply, the process grows.
// Safe behaviour: the trial is bounded like any core call (off the node's thread, within ASK_MS in total) and refuses a
// core past the sandbox's array budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ASK_MS, ARRAY_BUDGET } from '../src/core-sandbox.js';
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
const verdicts = 'const out = {}; for (const m of moves) out[m.key] = "DRAW"; return out;';

test('#1489-r2-hosting-1a: a decide adapter that spends its time does not hold the seat\'s thread past a core\'s ask deadline', () => {
  // passes the scan: no while(true), no for(;;), no globals named
  const slow = `export const DECIDE = { name: "slow", decide(moves) { const t = Date.now(); let n = 0; while (Date.now() - t < 190) n++; ${verdicts} } };`;
  const pkg = pkgOf(slow, { name: 'slow-game' });
  let ticks = 0; const iv = setInterval(() => { ticks++; }, 10);
  const t0 = Date.now();
  const v = verifyPackage(pkg, { verify: verifyEd25519 });
  const held = Date.now() - t0;
  clearInterval(iv);
  console.log(`trial: ok=${v.ok} held the thread ${held} ms (event-loop ticks meanwhile: ${ticks})`);
  assert.ok(held <= ASK_MS, `the trial run held the node's own thread ${held} ms (ASK_MS ${ASK_MS}); ok=${v.ok} ${v.why || ''}`);
});

test('#1489-r2-hosting-1b: a decide adapter that keeps its arrays is refused at the sandbox\'s array budget, not accepted', () => {
  const MB8 = 8 * 1024 * 1024;
  const hog = `const kept = [];\nexport const DECIDE = { name: "hog", decide(moves) { kept.push(new Uint8Array(${MB8}).fill(1)); ${verdicts} } };`;
  const pkg = pkgOf(hog, { name: 'hog-game' });
  const before = process.memoryUsage().arrayBuffers;
  const v = verifyPackage(pkg, { verify: verifyEd25519 });
  const grew = Math.round((process.memoryUsage().arrayBuffers - before) / 1048576);
  console.log(`trial: ok=${v.ok} array bytes in the node's process grew ${grew} MB (budget ${ARRAY_BUDGET / 1048576} MB)`);
  assert.equal(v.ok, false, `a core holding ${grew} MB of arrays in the node's own process passed the trial run`);
});
