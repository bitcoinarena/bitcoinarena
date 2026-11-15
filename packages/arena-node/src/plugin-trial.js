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
// and the whole trial - load, loadCore's own meta ask (kanban #1719) and every call - has ONE deadline, TRIAL_MS, inside a core ask's ASK_MS. The thread is ended after.
import { loadCore, lingeringCores, ASK_MS, ARRAY_BUDGET, SINGLE_ENTRY } from './core-sandbox.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { randomBytes } from 'node:crypto';

const VERDICTS = new Set(['WIN', 'DRAW', 'LOSS']);
/** The whole trial, load included: inside ASK_MS, with room for the checks before it and the thread's end after. */
export const TRIAL_MS = ASK_MS - 500;
const MAX_CASES = 2000;
// 2.0 (kanban #1694): a trial loads each core under the name the seat loads it under, so the names its threads lingered under
// are kept here (bounded; dropped once none of them lingers) and a new trial waits while any of them still does
const trialNames = new Set();
const trialLingers = () => {
  let n = 0;
  for (const t of trialNames) n += lingeringCores(t);
  if (!n) trialNames.clear();
  return n;
};
/** How many trial threads still linger (kanban #2711: loadInstalled waits for them before it checks a package again). */
export const trialThreadsLingering = () => trialLingers();

export function trialRun(source, manifest, { ms = TRIAL_MS, name = 'plugin trial' } = {}) {
  if (manifest.resultType !== RESULT_TYPE.HEAD_TO_HEAD) return { ok: true, cases: 0, why: 'no decide adapter to run (not a head-to-head game)' };
  // ONE TRIAL THREAD AT A TIME (kanban #1880, #1913): the trial never waits for a thread held in a long builtin past its deadline
  // (core-sandbox.js `lingering`); while one still lingers no other is started - refused for now, `retry`: not the version's verdict
  if (trialLingers()) return { ok: false, retry: true, cases: 0, why: 'an earlier trial\'s core thread is still ending: tried again later' };
  const until = Date.now() + ms;
  const left = () => until - Date.now();
  let box;
  if (trialNames.size < 256) trialNames.add(name);
  // kanban #1694: the same entry name and core name the seat loads it under (core-sandbox.js coreFiles), so the core cannot
  // tell the trial from the seat by its module's identifier
  try { box = loadCore({ files: new Map([[SINGLE_ENTRY, String(source)]]), entry: SINGLE_ENTRY }, { name, loadMs: ms, askMs: ms, until, liveCap: ARRAY_BUDGET, oneThread: true }); }   // kanban #1538: kept arrays refused at the budget; #1719: `until` - load and meta share the trial's one deadline
  catch (e) { return { ok: false, cases: 0, why: `it does not load in the sandbox: ${String(e.message).slice(0, 300)}` }; }   // kanban #2165: bounded
  try { return trialCases(box, manifest, left); } finally { box.end(); }
}

// kanban #2165, #2232, #2304: the refusal carries at most 300 characters of the core's text (the seat logs it and answers it
// in the 422), as server.js cuts a peer's error
function trialCases(box, manifest, left) {
  if (!box.meta.decide) return { ok: false, cases: 0, why: 'it exports no DECIDE with a decide(moves) function' };
  let cases = 0;
  const moves = manifest.moveCount;
  // EVERY PLAYER COUNT THE MANIFEST SEATS (kanban #2791): the exhaustive pass below stops at 4 players and at MAX_CASES, so a
  // game seating 5-16 whose adapter spins only past 4 players (or past what the cap reaches) passed and held the seat at close.
  // Now each count 2..manifest.players the exhaustive pass does not reach in full is run first on a few move sets (all the same
  // move, and a mixed one), the full count included.
  const sampled = [];
  let reached = 0;
  for (let players = 2; players <= manifest.players; players++) {
    reached += moves ** players;
    if (players <= 4 && reached <= MAX_CASES) continue;   // every combination of this count is run below
    for (let m = 0; m < Math.min(moves, 3); m++) sampled.push(Array.from({ length: players }, () => m));
    sampled.push(Array.from({ length: players }, (_, i) => (i * 7 + players) % moves));
  }
  const exhaustive = function* () {
    const maxPlayers = Math.min(manifest.players, 4);
    for (let players = 2; players <= maxPlayers; players++) {
      const total = moves ** players;
      for (let n = 0; n < total; n++) yield Array.from({ length: players }, (_, i) => Math.floor(n / moves ** i) % moves);
    }
  };
  const all = function* () { yield* sampled; yield* exhaustive(); };
  for (const set of all()) {
    if (cases >= MAX_CASES + sampled.length) break;
    // THE SEAT'S CALL SHAPE (kanban #2674): verify.js decides with each entry's 64-hex id as the key and the installed config
    // ({} - a package's configs are signed hashes with no body), so the trial does too: an adapter that spins only when handed a
    // config, or a seat-shaped key, is run on that branch here and refused, not first at the seat's close.
    // FRESH RANDOM KEYS (kanban #2791): the keys were fixed ('a0a0..a0', 'a1a1..a1'), so an adapter told them from a real entry
    // id and spun only on the seat's; now each case draws new random 64-hex ids, as an entry id is, with no pattern to recognise
    const list = set.map((move) => ({ key: randomBytes(32).toString('hex'), move }));
    let a, b;
    try {
      if (left() <= 0) throw new Error(`the trial did not finish within ${TRIAL_MS} ms`);
      a = JSON.stringify(box.call('decide', { moves: list, config: {} }, left()));
      if (left() <= 0) throw new Error(`the trial did not finish within ${TRIAL_MS} ms`);
      b = JSON.stringify(box.call('decide', { moves: list, config: {} }, left()));
    } catch (e) { return { ok: false, cases, why: `it fails on ${JSON.stringify(set)}: ${String(e.message).slice(0, 300)}` }; }
    if (a !== b) return { ok: false, cases, why: `it answers ${JSON.stringify(set)} differently twice` };
    let v; try { v = JSON.parse(a); } catch { v = null; }
    if (!v || typeof v !== 'object') return { ok: false, cases, why: `it answers ${JSON.stringify(set)} with no verdicts` };
    const keys = Object.keys(v).sort();
    if (keys.join(',') !== list.map((m) => m.key).sort().join(',')) return { ok: false, cases, why: `it does not answer each player exactly once on ${JSON.stringify(set)}` };
    if (!keys.every((k) => VERDICTS.has(v[k]))) return { ok: false, cases, why: `it answers something other than WIN, DRAW or LOSS on ${JSON.stringify(set)}` };
    cases++;
  }
  return { ok: true, cases };
}
