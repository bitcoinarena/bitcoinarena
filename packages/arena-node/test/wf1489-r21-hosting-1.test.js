// kanban #1489 round 21 (hosting): BYPASS OF #2730. The fix reads DECIDE.name and DECIDE.decide once at load (core-driver.js),
// on every thread alike - but the driver's meta() still reads the CORE export's fields (name, RUN_TICKS, INPUT_WORDS,
// runTicks, ...) only when meta is asked. loadCore asks meta on the trial's kept thread before every decide; the seat's decide
// runs on a fresh thread with no meta before it. A head-to-head adapter that also exports a CORE object with a getter knows on
// every decide whether meta ran on its thread: in the trial it did, at the seat never. It passes the trial and answers no
// verdict at the seat: every head-to-head close of the game throws, no round is ever decided.
// Safe behaviour: the seat's decide on the trial's own input answers what the trial saw (a verdict for each player).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { sandboxFor } from '../src/core-sandbox.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { headToHeadResults } from '../../arena-protocol/src/head-to-head.js';
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

test('#1489-r21-hosting-1: an adapter that passed the trial answers the seat\'s decide on the same input (CORE getter)', async () => {
  const src = `let metaRan = false;
export const CORE = { get name() { metaRan = true; return 'rps-two-faced'; } };
export const DECIDE = {
  name: 'rps-two-faced',
  decide(moves) {
    const out = {};
    if (!metaRan) return out;
    const [a, b] = moves;
    const d = (a.move - b.move + 3) % 3;
    out[a.key] = d === 0 ? 'DRAW' : d === 1 ? 'WIN' : 'LOSS';
    out[b.key] = d === 0 ? 'DRAW' : d === 1 ? 'LOSS' : 'WIN';
    return out;
  },
};`;
  const { pkg, gameId } = pkgOf(src, { name: 'rps-two-faced' });
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log(`trial: ok=${v.ok} ${v.why || ''} | ${(v.checks || []).at(-1)?.detail || ''}`);
  assert.equal(v.ok, true, 'the package passes the scan and the trial');
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r21-hosting-1-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const core = [...reg.cores.values()][0];
  const box = sandboxFor(core);
  // exactly what the trial asked: keys p0/p1, moves 0..2, no config
  const moves = [{ key: 'p0', move: 0 }, { key: 'p1', move: 1 }];
  const answered = box.call('decide', { moves });
  console.log(`seat decide on the trial's input ${JSON.stringify(moves.map((m) => m.move))}: ${JSON.stringify(answered)}`);
  let results = null, why = 'decided';
  try { results = headToHeadResults(moves, (m, config) => box.call('decide', { moves: m, config }), undefined, { players: 2 }); } catch (e) { why = e.message; }
  console.log(`seat close: ${why}${results ? ` ${JSON.stringify(results)}` : ''}`);
  assert.deepEqual(Object.keys(answered).sort(), ['p0', 'p1'], `the seat's decide answered ${JSON.stringify(answered)} where the trial saw a verdict for each player`);
  assert.ok(results, `every seat's head-to-head close of this game throws: ${why}`);
});
