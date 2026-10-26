// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SLOW READ KEPT, AND READ AGAIN BEHIND IT (kanban #686, measured 2026-10-26: GET /pending on the seven release-installed nodes, whose chain
// is read through the bridge, ran past 20 s cold and took 6.7 s warm; a test host seat with its own bitcoind answers in 0.06 s - and the
// Network health page and the explorer's copy ask every seat for it every minute).
//   get(key, compute)   the kept answer while it is of `key` (e.g. the tip and its hash) and younger than freshMs; an older one - or one of
//                       another key - is answered at once while compute() runs behind it; only the first read ever waits
//   forget()            nothing kept (something the next answer must show has changed): the next get waits for a compute of its own
// One compute at a time: a get while one runs waits on that one, or takes the kept answer.
export function keptRead({ freshMs = 60000, now = () => Date.now() } = {}) {
  let kept = null, running = null, gen = 0;
  const run = (key, compute) => {
    if (!running) {
      const g = gen;
      const p = (async () => {
        try { const r = await compute(); if (g === gen) kept = { key, at: now(), r }; return r; } finally { if (running === p) running = null; }
      })();
      running = p;
    }
    return running;
  };
  return {
    async get(key, compute) {
      if (kept && kept.key === key && now() - kept.at < freshMs) return kept.r;
      if (kept) { run(key, compute).catch(() => {}); return kept.r; }
      return run(key, compute);
    },
    // a compute already running read before the change: it is not kept, and not waited on
    forget() { kept = null; running = null; gen++; },
    kept: () => (kept ? { key: kept.key, at: kept.at } : null),
  };
}
