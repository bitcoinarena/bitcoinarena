// kanban #1489 round 25 (hosting): THE TRIAL'S FIRST DECIDE IS ALWAYS THE SAME INPUT, AND ONLY THE TRIAL CALLS DECIDE TWICE ON A THREAD.
// plugin-trial.js runs every case on ONE kept thread (`oneThread`), in a fixed order: for a game of up to 4 players with every
// combination in reach, the first decide it ever asks is the all-zero move set ([0,0] for two players; the keys are random since
// #2791, the moves are not). The seat (verify.js) runs each decide on a FRESH thread - every decide there is the first call its
// thread sees, on the round's real moves. An adapter that counts its calls in a module variable answers good verdicts on its
// first call when every move is 0 and on every later call (all of the trial), and none (or spins - `while (1)` passes the scan)
// on a first call with any other move: every case of the trial passes, and every real close where a player did not play move 0
// throws "no verdict" on every seat alike (no round of the game is decided; with a spin, ASK_MS of the seat's thread per retry).
// Not #2730/#2808 (no meta, no getter) and not #2791 (keys and player counts): the order and history of the trial's own calls.
// Safe behaviour: the seat's decide on an input the trial covered answers what the trial saw (a verdict for each player).
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

test('#1489-r25-hosting-3 (trial call order): an adapter that passed the trial answers the seat\'s decide on the same input', async () => {
  const src = `let calls = 0;
export const DECIDE = {
  name: 'rps-first-call',
  decide(moves) {
    const first = calls === 0;
    calls += 1;
    const out = {};
    if (first && moves.some((m) => m.move !== 0)) return out;
    const [a, b] = moves;
    const d = (a.move - b.move + 3) % 3;
    out[a.key] = d === 0 ? 'DRAW' : d === 1 ? 'WIN' : 'LOSS';
    out[b.key] = d === 0 ? 'DRAW' : d === 1 ? 'LOSS' : 'WIN';
    return out;
  },
};`;
  const { pkg, gameId } = pkgOf(src, { name: 'rps-first-call' });
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  console.log(`trial: ok=${v.ok} ${v.why || ''} | ${(v.checks || []).at(-1)?.detail || ''}`);
  // kanban #2844: the trial now decides random move sets (at least one with a non-zero move) as the first call of a fresh thread, as the seat
  // does - this adapter is refused there; a package that passes is still checked against the seat's own decide below
  if (!v.ok) { assert.match(String(v.why), /on a fresh thread/); return; }
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r25-hosting-3-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const core = [...reg.cores.values()][0];
  const box = sandboxFor(core);
  // exactly what the trial asked: keys p0/p1, moves 0..2, no config
  const moves = [{ key: 'aa'.repeat(32), move: 0 }, { key: 'bb'.repeat(32), move: 1 }];
  const answered = box.call('decide', { moves });
  console.log(`seat decide on the trial's input ${JSON.stringify(moves.map((m) => m.move))}: ${JSON.stringify(answered)}`);
  let results = null, why = 'decided';
  try { results = headToHeadResults(moves, (m, config) => box.call('decide', { moves: m, config }), undefined, { players: 2 }); } catch (e) { why = e.message; }
  console.log(`seat close: ${why}${results ? ` ${JSON.stringify(results)}` : ''}`);
  assert.deepEqual(Object.keys(answered).sort(), ['aa'.repeat(32), 'bb'.repeat(32)], `the seat's decide answered ${JSON.stringify(answered)} where the trial saw a verdict for each player`);
  assert.ok(results, `every seat's head-to-head close of this game throws: ${why}`);
});
