// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE THREAD THAT WATCHES THE CORE THREADS (spec §0A.6). The node waits for a core's answer blocked in
// Atomics.wait, so it hears no event from the core's thread: a core killed by its heap limit left the node waiting until
// the call's deadline (measured 8 s of 8 s; up to 120 s for a replay), and memory read between 50 ms slices let a core
// grow the node to 857-933 MB past a 512 MB backstop. This thread is never blocked. It starts each core thread for its
// node thread (core-sandbox.js), and for each one:
//   - hears its exit at once - a heap death, a terminate, anything - and wakes the waiting node (ctrl[0] = EXITED);
//   - reads this process's memory every SAMPLE_MS while a call runs, and ends the core the moment it has grown the
//     process past the trigger, keeping the call's high-water for the node to read;
//   - ends it when the node asks (a deadline, the array budget), so the node can wait for the thread to be gone.
// One per node thread that loads cores, started on the first core.
import { Worker, parentPort, workerData } from 'node:worker_threads';

// the control slots shared with core-sandbox.js (an Int32Array over a SharedArrayBuffer of 8 slots)
export const C = Object.freeze({ STATE: 0, SLEEP: 1, CODE: 2, CALL: 3, FROM_MB: 4, HIGH_MB: 5, CAUGHT: 6 });
export const ANSWERED = 1, EXITED = 2;
const SAMPLE_MS = 2;
const MB = 1048576;

// only in the thread core-sandbox.js started as a supervisor - a replay worker imports this file too
if (parentPort && workerData && workerData.arenaCoreSupervisor) {
  const cores = new Map();   // id -> { worker, ctrl, triggerMb }
  const rssMb = () => Math.round(process.memoryUsage.rss() / MB);
  let report = null;         // the port the node reads deaths on (receiveMessageOnPort)
  parentPort.on('message', (m) => {
    if (m.type === 'report') { report = m.port; report.unref(); return; }
    if (m.type === 'spawn') {
      const ctrl = new Int32Array(m.ctrl);
      const worker = new Worker(new URL('./core-host.js', import.meta.url), {
        execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'], env: {}, resourceLimits: m.heap,
        workerData: { files: m.files, entry: m.entry, name: m.name, port: m.port, ctrl: m.ctrl, arrayBudget: m.arrayBudget },
        transferList: [m.port],
      });
      const c = { worker, ctrl, triggerMb: m.triggerMb, error: null };
      cores.set(m.id, c);
      worker.on('error', (e) => { c.error = (e && (e.code || e.message)) || String(e); });
      worker.on('exit', (code) => {
        cores.delete(m.id);
        if (report) report.postMessage({ id: m.id, code, error: c.error });
        Atomics.store(ctrl, C.CODE, code | 0);
        Atomics.store(ctrl, C.STATE, EXITED);
        Atomics.notify(ctrl, C.STATE);
      });
      return;
    }
    if (m.type === 'end') { const c = cores.get(m.id); if (c) c.worker.terminate().catch(() => {}); }
  });
  // THE BACKSTOP, read every SAMPLE_MS from a thread that is never blocked: past the trigger the core is ended at once
  setInterval(() => {
    if (!cores.size) return;
    let now = null;
    for (const [, c] of cores) {
      if (Atomics.load(c.ctrl, C.CALL) !== 1) continue;
      now = now === null ? rssMb() : now;
      const grew = now - Atomics.load(c.ctrl, C.FROM_MB);
      if (grew > Atomics.load(c.ctrl, C.HIGH_MB)) Atomics.store(c.ctrl, C.HIGH_MB, grew);
      if (grew > c.triggerMb && Atomics.load(c.ctrl, C.CAUGHT) === 0) {
        Atomics.store(c.ctrl, C.CAUGHT, grew);
        c.worker.terminate().catch(() => {});
      }
    }
  }, SAMPLE_MS);
}
