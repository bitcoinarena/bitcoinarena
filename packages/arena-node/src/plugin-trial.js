// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TRIAL RUN (2026-10-10: "Malicious code checks are very important"): after the scan, a decide
// adapter is RUN before it is installed - in a context of its own (node:vm) with no process, no require, no network objects,
// a time limit per call - on every combination of moves for every player count its manifest allows (capped). It must not
// throw, must answer each player present exactly once with WIN, DRAW or LOSS, and must answer the same thing twice. The vm is
// not a security boundary by itself: the scan in front of it refuses what could reach out of it.
import vm from 'node:vm';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

const VERDICTS = new Set(['WIN', 'DRAW', 'LOSS']);
const CALL_MS = 200;
const MAX_CASES = 2000;

/** The adapter's DECIDE, evaluated in an empty context: `export const|function` made local, the module returning DECIDE. */
function loadInSandbox(source) {
  const body = String(source).replace(/^\s*export\s+(const|let|var|function|class)\s/gm, '$1 ').replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '');
  const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const decide = vm.runInContext(`(() => { 'use strict'; ${body}\n; return typeof DECIDE === 'undefined' ? null : DECIDE; })()`, ctx, { timeout: CALL_MS });
  return { ctx, decide };
}

export function trialRun(source, manifest) {
  if (manifest.resultType !== RESULT_TYPE.HEAD_TO_HEAD) return { ok: true, cases: 0, why: 'no decide adapter to run (not a head-to-head game)' };
  let loaded;
  try { loaded = loadInSandbox(source); } catch (e) { return { ok: false, cases: 0, why: `it does not load in the sandbox: ${e.message}` }; }
  const { ctx, decide } = loaded;
  if (!decide || typeof decide.decide !== 'function') return { ok: false, cases: 0, why: 'it exports no DECIDE with a decide(moves) function' };
  vm.runInContext('void 0', ctx);
  ctx.__decide = decide;
  let cases = 0;
  const moves = manifest.moveCount, maxPlayers = Math.min(manifest.players, 4);
  for (let players = 2; players <= maxPlayers; players++) {
    const total = moves ** players;
    for (let n = 0; n < total && cases < MAX_CASES; n++) {
      const list = Array.from({ length: players }, (_, i) => ({ key: 'p' + i, move: Math.floor(n / moves ** i) % moves }));
      ctx.__moves = JSON.stringify(list);
      let a, b;
      try {
        a = vm.runInContext('JSON.stringify(__decide.decide(JSON.parse(__moves)))', ctx, { timeout: CALL_MS });
        b = vm.runInContext('JSON.stringify(__decide.decide(JSON.parse(__moves)))', ctx, { timeout: CALL_MS });
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
