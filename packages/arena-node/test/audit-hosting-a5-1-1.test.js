// Audit 2026-11-22 round 1 (hosting), finding 1: the #2844/#3042 fresh-thread sample is 4 random move sets.
// The seat decides every head-to-head close on a fresh core thread (verify.js #headToHeadClose -> core-sandbox per-call thread),
// so the trial must make sure that a decide adapter answers a fresh thread's first call for ANY move set it may be given. The
// trial runs every move set on its kept thread, but only 4 random sets as a fresh thread's first call. An adapter that counts its
// calls and spins only on a first call with one chosen set (here {30, 31} of 32 moves, 2 players: 2 of 1024 sets, so the 4 random
// sets miss it ~99 % of the time) passes the trial. At the seat, a round where the developer's two entries play 30 and 31 makes
// every close and every retry (each entry, each finality tick) spin until ASK_MS: the seat's main thread is held ~2 s per attempt.
// Safe behaviour: an adapter that passed the trial answers the seat's fresh-thread decide on every move set its manifest allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { sandboxFor, ASK_MS } from '../src/core-sandbox.js';
import { decideBounded, DECIDE_TRIES } from '../src/verify.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { headToHeadResults } from '../../arena-protocol/src/head-to-head.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function pkgOf(src, { name, players, moveCount }) {
  const core = { name, hash: sha(Buffer.from(src)), configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name, core, players, moveCount });
  return { gameId: toHex(gameIdOf(game.manifest)), pkg: { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name, configs: ['11'.repeat(32)], source: Buffer.from(src).toString('base64') }], clients: [] } };
}

test('audit-hosting-a5-1-1: an adapter that spins on one chosen move set as a fresh thread\'s first call is refused by the trial, or holds the seat at most DECIDE_TRIES times a round', async () => {
  const src = `let calls = 0;
export const DECIDE = {
  name: 'one-set-first-call',
  decide(moves) {
    const first = calls === 0;
    calls += 1;
    if (first && moves.length === 2) {
      const a = moves[0].move, b = moves[1].move;
      if ((a === 30 && b === 31) || (a === 31 && b === 30)) { let n = 1; while (n > 0) n = n + 1; }
    }
    const out = {};
    let best = -1;
    for (const m of moves) if (m.move > best) best = m.move;
    for (const m of moves) out[m.key] = m.move === best ? 'WIN' : 'LOSS';
    return out;
  },
};`;
  const { pkg, gameId } = pkgOf(src, { name: 'one-set-first-call', players: 2, moveCount: 32 });
  let passed = 0;
  for (let i = 0; i < 3; i++) {
    const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
    console.log(`trial ${i}: ok=${v.ok} ${v.why || ''}`);
    if (!v.ok) return;   // the safe behaviour: refused by the trial
    passed++;
  }
  const base = join(process.env.TMPDIR || process.cwd(), `audit-hosting-a5-1-1-${process.pid}`);
  mkdirSync(base, { recursive: true });
  const at = installPackage(mkdtempSync(join(base, 'p-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const box = sandboxFor([...reg.cores.values()][0]);
  const moves = [{ key: 'ab'.repeat(32), move: 30 }, { key: 'cd'.repeat(32), move: 31 }];
  // kanban #3298: the trial cannot try every move set as a first call, so the seat bounds what such a set costs it: a decide that failed for a
  // round's move list is run at most DECIDE_TRIES times (verify.js decideBounded); every later retryClose of the round answers the failure at once
  const failed = new Map(), key = `round:${JSON.stringify(moves)}`;
  let runs = 0, why = 'decided';
  const t0 = Date.now();
  for (let retry = 0; retry < 5; retry++) {
    try { decideBounded(failed, key, () => { runs++; return headToHeadResults(moves, (m, config) => box.call('decide', { moves: m, config }), {}, { players: 2 }); }); }
    catch (e) { why = e.message; }
  }
  const heldMs = Date.now() - t0;
  console.log(`seat closes of the round {30, 31}, 5 tries: ${why} (the core ran ${runs} times, the seat's thread held ${heldMs} ms)`);
  assert.ok(runs <= DECIDE_TRIES, `the core ran ${runs} times for one round's move list`);
  assert.ok(heldMs < DECIDE_TRIES * (ASK_MS + 1000), `the seat's thread was held ${heldMs} ms over 5 closes of one round`);
});
