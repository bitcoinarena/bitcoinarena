// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { makeHealth, live, keyOf, ageOf, keepable, AT_ONCE } from '../../arena-ui/health/network.js';

// THE NETWORK HEALTH PAGE'S COPY (kanban #686, 2026-10-26: "health is very very slow to load. Cache all the data in the background and if
// data is outdated show it instead that its older than 5 minutes. right now it's unusable."): the page's own read (src/arena-ui/health/
// network.js) run here, nothing drawn, its answers kept in KV 'health' - { atMs, builtMs, daily, answers: { door: answer + atMs }, complete }.
// A read here only finds which doors the page would ask, from the answers kept (no node asked); then the doors not asked for HEALTH_FRESH_MS are
// asked, the oldest first, at most HEALTH_BUDGET a run, and the read runs again for the doors those answers name (a new node, a new
// federation), up to four times. A door the run could not ask keeps its last answer, with its time: the copy is as old as its oldest answer
// (ageOf), which the page shows. A Worker that may fetch fewer times (the free plan's 50) still goes round all doors, a part each minute.
export const HEALTH_DAILY = 'https://testnet.bitcoin-arena.io/daily.json', HEALTH_CRON = '*/2 * * * *';   // every 2 min: "*/1" is the poll's own schedule to Cloudflare, which ran it once (kanban #686)
const HEALTH_FRESH_MS = 45000, HEALTH_PASSES = 4;
const NOTHING_DRAWN = new Proxy({}, { get: (_, k) => (k === 'draw' ? () => {} : () => []) });
export async function readHealth(env, fetchImpl = fetch) {
  const t0 = Date.now();
  const was = JSON.parse((await env.EXPLORER.get('health')) || 'null');
  const answers = (was && was.answers) || {};
  const budget = Number(env.HEALTH_BUDGET) || 900;
  let asked = 1, limited = false;   // daily.json is the first
  // a Worker's fetch takes no `cache` field before its compatibility flag: left out here
  const get = (url, init = {}) => { const { cache, ...rest } = init; void cache; return fetchImpl(url, rest); };
  const daily = await (await get(HEALTH_DAILY)).json();
  const health = makeHealth({ H: NOTHING_DRAWN, $: () => null, window: {} });
  let used = new Map();
  for (let pass = 0; pass <= HEALTH_PASSES; pass++) {
    used = new Map();
    const fromKept = async (base, path) => { const k = keyOf(base, path); used.set(k, [base, path]);
      const a = answers[k]; return a ? { ok: a.ok, status: a.status, why: a.why, ms: a.ms, body: a.body } : { ok: false, status: 0, why: 'not read yet', ms: 0 }; };
    if (!(await health.read({ transport: fromKept, daily: async () => daily }))) throw new Error('the health read failed on the kept answers');
    if (pass === HEALTH_PASSES || limited) break;
    const now = Date.now();
    const due = [...used].filter(([k]) => !answers[k] || now - Number(answers[k].atMs || 0) > HEALTH_FRESH_MS)
      .sort(([a], [b]) => Number((answers[a] || {}).atMs || 0) - Number((answers[b] || {}).atMs || 0)).slice(0, Math.max(0, budget - asked));
    if (!due.length) break;
    // AT_ONCE at a time (the page's six; a Worker keeps six connections open)
    let i = 0;
    await Promise.all(Array.from({ length: Number(env.HEALTH_AT_ONCE) || AT_ONCE }, async () => {
      while (i < due.length && !limited) {
        const [k, [base, path]] = due[i++];
        asked++;
        const a = await live(base, path, get);
        // the plan's subrequest limit reached: no answer, and nothing more asked this run - the door keeps what it answered before
        if (!a.ok && /subrequest/i.test(String(a.why))) { limited = true; break; }
        answers[k] = { ...a, atMs: Date.now() };
      }
    }));
  }
  // the doors the last read asked, small (keepable: what the cards use)
  const kept = keepable(Object.fromEntries([...used.keys()].filter((k) => answers[k]).map((k) => [k, answers[k]])), health.spare());
  const snap = { atMs: 0, builtMs: Date.now(), daily, answers: kept, complete: [...used.keys()].every((k) => answers[k]) };
  snap.atMs = ageOf(snap);
  await env.EXPLORER.put('health', JSON.stringify(snap));
  const n = { doors: used.size, asked, limited, complete: snap.complete, ageS: Math.round((Date.now() - snap.atMs) / 1000), ms: Date.now() - t0 };
  console.log(JSON.stringify({ health: n }));
  return n;
}
