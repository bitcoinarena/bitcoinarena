// kanban #3042: the card's test
// Audit 2026-11-19 round 3 (hosting): gap between the #2791 and #2844 fixes of the plugin trial.
// #2791 samples player counts 5..16 - but only on the trial's ONE KEPT thread, where the very first call is a sampled
// all-same-move set. #2844 decides random move sets as the FIRST call of a FRESH thread (as verify.js does at every close) -
// but only for 2..4 players (2 + floor(random * (min(players, 4) - 1))). So no trial case is ever a mixed 5+ player move set
// decided as a fresh thread's first call, which is exactly every real close of a 5+ player round at a seat. An adapter that
// counts its calls answers {} (or spins - `while (1)` passes the scan) only there: the trial passes, autoUpdate takes it
// unattended, and every seat's close of every such round throws "no verdict" (with a spin: ASK_MS of the seat's thread held
// per close attempt).
// Safe behaviour: an adapter that passed the trial answers the seat's decide (fresh thread) with a verdict for each player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { sandboxFor } from '../src/core-sandbox.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { headToHeadResults } from '../../arena-protocol/src/head-to-head.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, players, moveCount = 3 }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, players, moveCount });
  return { gameId: toHex(gameIdOf(game.manifest)), pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

test('audit-hosting-r3-1: a 5-player adapter that passed the trial answers the seat\'s fresh-thread decide on a mixed move set', async () => {
  const src = `let calls = 0;
export const DECIDE = {
  name: 'five-first-call',
  decide(moves) {
    const first = calls === 0;
    calls += 1;
    const out = {};
    if (first && moves.length >= 5 && moves.some((m) => m.move !== moves[0].move)) return out;
    let best = -1;
    for (const m of moves) if (m.move > best) best = m.move;
    for (const m of moves) out[m.key] = m.move === best ? 'WIN' : 'LOSS';
    return out;
  },
};`;
  const { pkg, gameId } = pkgOf(src, { name: 'five-first-call', players: 5 });
  // several tries: the fresh-thread cases are random, so a pass that is luck would show here
  for (let i = 0; i < 3; i++) {
    const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
    console.log(`trial ${i}: ok=${v.ok} ${v.why || ''}`);
    if (!v.ok) return;   // the safe behaviour: refused by the trial
  }
  const base = join(process.env.TMPDIR || process.cwd(), `audit-hosting-r3-1-${process.pid}`);
  mkdirSync(base, { recursive: true });
  const at = installPackage(mkdtempSync(join(base, 'p-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const box = sandboxFor([...reg.cores.values()][0]);
  const moves = [0, 1, 2, 1, 0].map((move, i) => ({ key: String(i + 1).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'), move }));
  let results = null, why = 'decided';
  try { results = headToHeadResults(moves, (m, config) => box.call('decide', { moves: m, config }), {}, { players: 5 }); } catch (e) { why = e.message; }
  console.log(`seat close of a 5-player round: ${why}`);
  assert.ok(results, `the trial passed the adapter three times, and the seat's close of a 5-player round throws: ${why}`);
});
