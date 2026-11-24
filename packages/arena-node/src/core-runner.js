// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3557 (RCE audit #3552): THE PROCESS THE CORES RUN IN - not the seat's. A core is third-party code; it ran in a worker thread of
// the seat process, in the same address space as the seat's identity secret, its DKG shares and the guardian admin password, so one
// V8 or vm escape was all of them. Node itself says vm is not a security boundary. Now every core thread (core-host.js, unchanged) is
// started in this child process instead, which the seat's core supervisor (core-supervisor.js) starts:
//   - with an empty environment, under node's permission model: it reads only the node's own code files (core-host.js, the driver,
//     the depth count) and nothing else - no file of the seat's, no write, no child process, no addon, no inspector; it may start
//     worker threads (each core's own). Where the machine has bubblewrap it runs inside it as well (core-supervisor.js runnerCommand):
//     no network, and none of the seat's files even exist there - the boundary that holds a core that escaped V8 into native code;
//   - it holds nothing of the seat's: the core's source text and the strings of each call reach it over its IPC channel, and only the
//     answers' strings go back;
//   - it does what the supervisor thread did for each core thread: hears its exit at once, reads its own memory every SAMPLE_MS while a
//     call runs and ends it past the trigger, ends it when asked - and says each of these to the supervisor, which wakes the waiting
//     node thread as before. The deadlines stay the node's own (core-sandbox.js).
// The message API, supervisor -> here: spawn {id, files, entry, name, arrayBudget, liveCap, answerMax, heap, triggerMb}, call {id, op,
// json}, end {id}; here -> supervisor: answer {id, m, high}, exit {id, code, error, caught, high}. Nothing else is read.
import { Worker, MessageChannel } from 'node:worker_threads';
import { C } from './core-supervisor.js';
import { CORE_STACK_MB } from './core-depth.js';

const SAMPLE_MS = 2;
const MB = 1048576;
const cores = new Map();   // id -> { worker, ctrl, port, triggerMb, error, asking, high }
const send = (m) => { try { process.send(m); } catch { /* the seat is gone: the disconnect below ends this process */ } };
// THE SEAT GONE, THIS PROCESS GOES: nothing of a core outlives the node that started it
process.on('disconnect', () => process.exit(0));

const spawnCore = (m) => {
  const ctrl = new Int32Array(new SharedArrayBuffer(8 * 4));
  Atomics.store(ctrl, C.FROM_MB, -1);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./core-host.js', import.meta.url), {
    execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'], env: {},
    // kanban #2220, #2476: room for core-depth.js's DEPTH_MAX frames, so V8's own overflow is not reached through the core's functions
    resourceLimits: { stackSizeMb: CORE_STACK_MB, ...m.heap },
    workerData: { files: m.files, entry: m.entry, name: m.name, port: port2, ctrl: ctrl.buffer, arrayBudget: m.arrayBudget, liveCap: m.liveCap,
      answerMax: m.answerMax },
    transferList: [port2],
  });
  const c = { worker, ctrl, port: port1, triggerMb: m.triggerMb, error: null, asking: false };
  cores.set(m.id, c);
  // the load is a call: its memory is watched from the start (core-host.js writes FROM_MB first)
  Atomics.store(ctrl, C.HIGH_MB, 0);
  Atomics.store(ctrl, C.CALL, 1);
  port1.on('message', (answer) => {
    Atomics.store(ctrl, C.CALL, 0);
    send({ t: 'answer', id: m.id, m: answer, high: Atomics.load(ctrl, C.HIGH_MB) });
  });
  // kanban #2549: the core controls its error's code and message - only the first 512 characters are carried
  worker.on('error', (e) => { c.error = String((e && (e.code || e.message)) || e).slice(0, 512); });
  worker.on('exit', (code) => {
    cores.delete(m.id);
    port1.close();
    send({ t: 'exit', id: m.id, code: code | 0, error: c.error, caught: Atomics.load(ctrl, C.CAUGHT), high: Atomics.load(ctrl, C.HIGH_MB) });
  });
};

process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'spawn') return spawnCore(m);
  const c = cores.get(m.id);
  if (!c) return;
  if (m.t === 'call') {
    Atomics.store(c.ctrl, C.FROM_MB, -1);
    Atomics.store(c.ctrl, C.HIGH_MB, 0);
    Atomics.store(c.ctrl, C.CALL, 1);
    c.port.postMessage({ op: String(m.op), json: String(m.json) });
    return;
  }
  if (m.t === 'end') c.worker.terminate().catch(() => {});
});

// THE BACKSTOP (core-supervisor.js before #3557, kanban #1813): each core charged only for its own isolate's memory - heap, external
// and malloced - against the figure its thread wrote when the call began; past the trigger it is ended at once
const ownMb = (h) => Math.round(((h.total_heap_size || 0) + (h.external_memory || 0) + (h.malloced_memory || 0)) / MB);
setInterval(() => {
  if (!cores.size) return;
  for (const [, c] of cores) {
    if (Atomics.load(c.ctrl, C.CALL) !== 1 || c.asking) continue;
    c.asking = true;
    c.worker.getHeapStatistics().then((h) => {
      c.asking = false;
      const from = Atomics.load(c.ctrl, C.FROM_MB);
      if (Atomics.load(c.ctrl, C.CALL) !== 1 || from < 0) return;
      const grew = ownMb(h) - from;
      if (grew > Atomics.load(c.ctrl, C.HIGH_MB)) Atomics.store(c.ctrl, C.HIGH_MB, grew);
      if (grew > c.triggerMb && Atomics.load(c.ctrl, C.CAUGHT) === 0) {
        Atomics.store(c.ctrl, C.CAUGHT, grew);
        c.worker.terminate().catch(() => {});
      }
    }, () => { c.asking = false; });
  }
}, SAMPLE_MS);
send({ t: 'ready' });
