// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TRIAL RUN (2026-10-10: "Malicious code checks are very important"): after the scan, a decide
// adapter is RUN before it is installed - on every combination of moves for every player count its manifest allows (capped).
// It must not throw, must answer each player present exactly once with WIN, DRAW or LOSS, and must answer the same thing twice.
// IN THE CORE SANDBOX, NOT THE NODE'S THREAD (kanban #1538): the trial ran the untrusted adapter in a node:vm context in the
// seat's own thread - 200 ms per call, up to 2000 cases twice, no memory bound - and autoUpdate runs it unattended on every
// signed next version, so one version held a seat's event loop for minutes or grew it past any limit (measured 6 s held and
// 256 MB of kept arrays, accepted). Now it runs exactly as the seat would run it once installed: core-sandbox.js loadCore from
// the package's bytes (its own worker thread, heap limits, the 64 MB array budget, the RSS backstop, no Date or Math.random),
// and the whole trial - load and every call - has ONE deadline, TRIAL_MS, inside a core ask's ASK_MS. The thread is ended after.
import { loadCore, ASK_MS } from './core-sandbox.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const VERDICTS = new Set(['WIN', 'DRAW', 'LOSS']);
/** The whole trial, load included: inside ASK_MS, with room for the checks before it and the thread's end after. */
export const TRIAL_MS = ASK_MS - 500;
const MAX_CASES = 2000;

export function trialRun(source, manifest, { ms = TRIAL_MS } = {}) {
  if (manifest.resultType !== RESULT_TYPE.HEAD_TO_HEAD) return { ok: true, cases: 0, why: 'no decide adapter to run (not a head-to-head game)' };
  const until = Date.now() + ms;
  const left = () => until - Date.now();
  let box;
  try { box = loadCore({ files: new Map([['core.mjs', String(source)]]), entry: 'core.mjs' }, { name: 'plugin trial', loadMs: ms, askMs: ms }); }
  catch (e) { return { ok: false, cases: 0, why: `it does not load in the sandbox: ${e.message}` }; }
  try { return trialCases(box, manifest, left); } finally { box.end(); }
}

function trialCases(box, manifest, left) {
  if (!box.meta.decide) return { ok: false, cases: 0, why: 'it exports no DECIDE with a decide(moves) function' };
  let cases = 0;
  const moves = manifest.moveCount, maxPlayers = Math.min(manifest.players, 4);
  for (let players = 2; players <= maxPlayers; players++) {
    const total = moves ** players;
    for (let n = 0; n < total && cases < MAX_CASES; n++) {
      const list = Array.from({ length: players }, (_, i) => ({ key: 'p' + i, move: Math.floor(n / moves ** i) % moves }));
      let a, b;
      try {
        if (left() <= 0) throw new Error(`the trial did not finish within ${TRIAL_MS} ms`);
        a = JSON.stringify(box.call('decide', { moves: list }, left()));
        if (left() <= 0) throw new Error(`the trial did not finish within ${TRIAL_MS} ms`);
        b = JSON.stringify(box.call('decide', { moves: list }, left()));
      } catch (e) { return { ok: false, cases, why: `it fails on ${JSON.stringify(list.map((m) => m.move))}: ${e.message}` }; }
      if (a !== b) return { ok: false, cases, why: `it answers ${JSON.stringify(list.map((m) => m.move))} differently twice` };
      let v; try { v = JSON.parse(a); } catch { v = null; }
      if (!v || typeof v !== 'object') return { ok: false, cases, why: `it answers ${JSON.stringify(list.map((m) => m.move))} with no verdicts` };
      const keys = Object.keys(v).sort();
      if (keys.join(',') !== list.map((m) => m.key).sort().join(',')) return { ok: false, cases, why: `it does not answer each player exactly once on ${JSON.stringify(list.map((m) => m.move))}` };
      if (!keys.every((k) => VERDICTS.has(v[k]))) return { ok: false, cases, why: `it answers something other than WIN, DRAW or LOSS on ${JSON.stringify(list.map((m) => m.move))}` };
      cases++;
    }
  }
  return { ok: true, cases };
}
