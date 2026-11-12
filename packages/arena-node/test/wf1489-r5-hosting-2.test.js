// kanban #1489 round 5 (hosting): THE TRIAL RUN IS NOT THE RUN THE SEAT MAKES (bypass of #1538).
// #1538 put the plugin trial in the core sandbox with ONE deadline, TRIAL_MS, so a package's adapter that does not stop or
// stalls is refused before anything is installed. But the trial loads the source as 'core.mjs' and the seat, once it passed,
// loads it again from disk as 'core-<hash>.mjs' (registrationFromPackage -> sandboxFor, LOAD_MS 10 s + ASK_MS 2 s, waited for
// synchronously in the node's own thread). The core reads which one it is in from `new Error().stack` (V8's default stack text
// names the module) - no word the scan refuses - and behaves in the trial only. The installed copy spins at its top level: the
// seat's event loop is held for LOAD_MS on install, again on every restart (loadInstalled), and once per sibling version a
// developer lists (autoUpdate takes each signed next version of a hosted game, unattended, every 10 minutes).
// Safe behaviour: a package that passed the trial loads at the seat inside the trial's bound - the seat never holds its thread
// for a core longer than ASK_MS on install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, moveCount });
  return { gameId: toHex(gameIdOf(game.manifest)), pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

test('#1489-r5-hosting-2: an adapter that passed the trial does not hold the seat\'s thread when the seat loads it', async () => {
  const src = `const where = String(new Error('x').stack);
if (!where.includes('core:/core.mjs')) { let n = 0; for (let i = 0; i < 1e12; i++) n += i; }
export const DECIDE = { name: 'two-faced', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };`;
  const { pkg, gameId } = pkgOf(src, { name: 'two-faced' });
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log(`trial: ok=${v.ok} ${v.why || ''} ${(v.checks || []).at(-1)?.detail || ''}`);
  assert.equal(v.ok, true, 'the package passes the scan and the trial');
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r5-hosting-2-')), pkg, gameId);
  let ticks = 0; const iv = setInterval(() => { ticks++; }, 10);
  const t0 = Date.now();
  let why = 'loaded';
  try { await registrationFromPackage(at, pkg); } catch (e) { why = e.message; }
  const held = Date.now() - t0;
  clearInterval(iv);
  console.log(`install load: held the node's thread ${held} ms (event-loop ticks meanwhile: ${ticks}); ${why}`);
  assert.ok(held <= ASK_MS, `the seat's thread was held ${held} ms loading a core that passed the trial (ASK_MS ${ASK_MS}): ${why}`);
});
