// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LEVEL'S CEILING OFF THE SERVICE'S THREAD (kanban #3332): src/level-ceiling.mjs takes ~10 s of one core per level; a worker thread runs it so
// the round service keeps answering. ceilingInWorker(candles, seed, version) -> Promise<{ total, timeS, finished, steps }>.
import { Worker } from 'node:worker_threads';

const SRC = `
import { parentPort, workerData } from 'node:worker_threads';
const { buildLevel } = await import(workerData.sim);
const { levelCeiling } = await import(workerData.ceiling);
parentPort.postMessage(levelCeiling(buildLevel(workerData.candles, workerData.seed, workerData.version)));
`;

export function ceilingInWorker(candles, seed, version, { timeoutMs = 10 * 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(SRC)}`), { workerData: { candles, seed, version,
      sim: new URL('../src/sim/index.js', import.meta.url).href, ceiling: new URL('../src/level-ceiling.mjs', import.meta.url).href } });
    const t = setTimeout(() => { w.terminate(); reject(new Error('the level ceiling took too long')); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(t); resolve(m); w.terminate(); });
    w.once('error', (e) => { clearTimeout(t); reject(e); });
    w.once('exit', (c) => { clearTimeout(t); if (c !== 0 && c !== 1) reject(new Error(`the level ceiling worker exited ${c}`)); });
  });
}
