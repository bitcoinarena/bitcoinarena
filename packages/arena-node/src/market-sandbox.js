// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S CODE, RUN ONLY HERE (kanban #920, docs/MARKET-CREATOR.md; spec §0A.6's sandbox for one pure function). A worker thread of its own with a
// 128 MB heap, a fresh vm context with code generation off, and the clock, randomness and everything else a node could differ on taken away. Only strings
// cross: what was read goes in as JSON text and the answer comes out as JSON text, so no object of the node's is ever in reach. The thread is ended at the limit.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const MARKET_RUN_MS = 2000;
const REMOVED = ['Date', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'WeakRef', 'FinalizationRegistry', 'console'];

/** Runs `decide(reads, market)`. Answers { ok: true, out } or { ok: false, why }. */
export function runMarketCode({ code, reads, market }, { limitMs = MARKET_RUN_MS } = {}) {
  return new Promise((done) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { arenaMarket: { code: String(code), reads: JSON.stringify(reads ?? null), market: JSON.stringify(market ?? null) } },
      env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let over = false;
    const end = (r) => { if (over) return; over = true; clearTimeout(t); w.terminate(); done(r); };
    const t = setTimeout(() => end({ ok: false, why: `Stopped after ${limitMs / 1000} s` }), limitMs);
    w.on('message', (m) => end(m));
    w.on('error', (e) => end({ ok: false, why: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Out of memory' : String(e.message) }));
    w.on('exit', () => end({ ok: false, why: 'The code ended without an answer' }));
  });
}

if (!isMainThread && workerData && workerData.arenaMarket) {
  const { code, reads, market } = workerData.arenaMarket;
  try {
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(`"use strict"; for (const k of ${JSON.stringify(REMOVED)}) delete globalThis[k]; delete Math.random;`, ctx);
    vm.runInContext(`"use strict";\n${code}`, ctx);
    const text = vm.runInContext(`JSON.stringify(decide(JSON.parse(${JSON.stringify(reads)}), JSON.parse(${JSON.stringify(market)})))`, ctx);
    parentPort.postMessage(typeof text === 'string' ? { ok: true, out: JSON.parse(text) } : { ok: false, why: 'decide returned nothing' });
  } catch (e) { parentPort.postMessage({ ok: false, why: String((e && e.message) || e).slice(0, 300) }); }
}
