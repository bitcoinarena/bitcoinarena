// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE THREAD THAT WATCHES THE CORE THREADS (spec §0A.6). The node waits for a core's answer blocked in
// Atomics.wait, so it hears no event from the core's thread: a core killed by its heap limit left the node waiting until
// the call's deadline (measured 8 s of 8 s; up to 120 s for a replay), and memory read between 50 ms slices let a core
// grow the node to 857-933 MB past a 512 MB backstop. This thread is never blocked. It starts each core thread for its
// node thread (core-sandbox.js), and for each one:
//   - hears its exit at once - a heap death, a terminate, anything - and wakes the waiting node (ctrl[0] = EXITED);
//   - reads the core thread's OWN memory (its isolate's heap, external and malloced bytes) every SAMPLE_MS while a call
//     runs, and ends the core the moment it has grown past the trigger since its call began, keeping the call's
//     high-water for the node to read;
//   - ends it when the node asks (a deadline, the array budget), so the node can wait for the thread to be gone.
// One per node thread that loads cores, started on the first core.
//
// kanban #3557 (RCE audit #3552): THE CORE THREADS ARE NOT THIS PROCESS'S ANY MORE. They run in a child process (core-runner.js) that
// holds none of the seat's keys and may read none of its files; this thread starts it, relays each call and answer between the node
// thread's port and the child, and wakes the node thread as before - on an answer (ctrl[0] = ANSWERED, the answer on its port first) and
// on an exit (ctrl[0] = EXITED). The memory watch and the ending run in the child, beside the core threads they read; their figures
// (the call's high-water, a backstop's catch) come back with each answer and exit. A child that dies takes its cores with it: each
// is reported gone, and the next core starts a new child.
// kanban #3732: ONE CHILD PER CORE (its files' hash), not one for the seat: a core whose run-time heap overrun aborts its process (V8's
// FatalProcessOutOfMemory, SIGABRT) takes only the cores that run its own files, never another game's.
import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// the control slots shared with core-sandbox.js (an Int32Array over a SharedArrayBuffer of 8 slots)
export const C = Object.freeze({ STATE: 0, SLEEP: 1, CODE: 2, CALL: 3, FROM_MB: 4, HIGH_MB: 5, CAUGHT: 6 });
export const ANSWERED = 1, EXITED = 2;
// real paths: they are bound into the core process's file system as they are named (kanban #3557)
const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };
const RUNNER = realOr(fileURLToPath(new URL('./core-runner.js', import.meta.url)));
const SRC_DIR = dirname(RUNNER);

const PACKAGE_JSON = realOr(join(dirname(SRC_DIR), 'package.json'));
/** kanban #3732: how long a core process with no core thread left is kept for the next call into the same core. */
export const IDLE_MS = 60000;

/** THE CORE PROCESS'S NODE COMMAND LINE: node's permission model - it reads only this node's code (its src directory and the package.json
 *  that says those files are modules), writes nothing, starts no process, loads no addon, opens no inspector; it may start worker threads. */
export function runnerArgs({ permission = true } = {}) {
  // (node 20 and 22 name the model --experimental-permission; 23 on --permission)
  const flag = Number(process.versions.node.split('.')[0]) >= 23 ? '--permission' : '--experimental-permission';
  // (no --max-old-space-size: V8's flag is the process's, and it overrides each core thread's own resourceLimits - measured, a core
  // within HEAP_LIMITS' 128 MB died of a 64 MB one)
  return [...(permission ? [flag, '--allow-worker', `--allow-fs-read=${SRC_DIR}`,
    `--allow-fs-read=${PACKAGE_JSON}`] : []), '--disable-warning=ExperimentalWarning', '--disable-warning=SecurityWarning', RUNNER];
}

/**
 * AND AROUND IT, WHERE THE MACHINE HAS ONE, A BOUNDARY OF THE OPERATING SYSTEM'S (bubblewrap, Linux): node's permission model holds
 * JavaScript, not a core that escaped V8 into native code - that runs as the seat's user and could open the seat's files. Inside
 * bwrap the process has its own user, pid, network, ipc and uts namespaces (no network at all), no capability, and a file system of
 * the node binary, the system's libraries and this node's src directory, all read-only: the seat's data, keys and home are not there
 * to open. It dies with the seat. `mode` (ARENA_CORE_PROCESS): 'bwrap' inside bubblewrap, 'node' under the permission model alone, 'plain'
 * a process of its own with neither (the last resort of a node whose permission flags do not start); 'auto' (the default) is 'bwrap'
 * where /usr/bin/bwrap is, else 'node'. Answers [command, args, mode].
 */
export function runnerCommand(mode = 'auto') {
  const node = realpathSync(process.execPath);
  const bwrap = process.platform === 'linux' ? ['/usr/bin/bwrap', '/bin/bwrap'].find((p) => existsSync(p)) || null : null;
  if (mode === 'auto') mode = bwrap ? 'bwrap' : 'node';
  if (mode === 'plain') return [node, runnerArgs({ permission: false }), mode];
  if (mode !== 'bwrap') return [node, runnerArgs(), 'node'];
  if (!bwrap) throw new Error('ARENA_CORE_PROCESS=bwrap, and this machine has no bwrap');
  const ro = (p) => ['--ro-bind', p, p];
  const libs = ['/lib', '/lib64', '/usr/lib', '/usr/lib64'].filter((p) => existsSync(p));
  // (the empty /tmp first: the binds after it may lie below /tmp)
  return [bwrap, ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--tmpfs', '/tmp',
    ...libs.flatMap(ro), ...ro(node), ...ro(SRC_DIR), ...ro(PACKAGE_JSON), '--proc', '/proc', '--dev', '/dev',
    '--chdir', '/', node, ...runnerArgs()], mode];
}

// only in the thread core-sandbox.js started as a supervisor - a replay worker imports this file too
if (parentPort && workerData && workerData.arenaCoreSupervisor) {
  const cores = new Map();   // id -> { ctrl, port, group }
  let report = null;         // the port the node reads deaths on (receiveMessageOnPort)
  // kanban #3732: ONE CORE PROCESS PER CORE (its files' hash, core-sandbox.js groupOf), not one for every core of the seat. A core's
  // run-time heap overrun can be V8's FatalProcessOutOfMemory, which aborts the whole process (SIGABRT) - as #3067/#3386 showed for
  // the compile - and with one shared process every other game's core thread in it died with it. Now an abort ends only the cores
  // that run the same files: the game whose core did it. A process with no core left is kept IDLE_MS for the next call into the
  // same core (a fresh-thread call such as decide starts and ends a core thread each time), then ended.
  const children = new Map();   // group -> { p, ready, queued, said, started, cores: Set<id>, idle }
  /** A core gone: its death said on the report port first, then the node thread woken (as the exit event did before #3557). */
  const gone = (id, { code = 1, error = null, caught = 0, high = 0 } = {}) => {
    const c = cores.get(id);
    if (!c) return;
    cores.delete(id);
    const k = children.get(c.group);
    if (k) { k.cores.delete(id); idleCheck(c.group, k); }
    try { c.port.close(); } catch { /* closed */ }
    if (report) report.postMessage({ id, code, error });
    if (caught) Atomics.store(c.ctrl, C.CAUGHT, caught | 0);
    if (high > Atomics.load(c.ctrl, C.HIGH_MB)) Atomics.store(c.ctrl, C.HIGH_MB, high | 0);
    Atomics.store(c.ctrl, C.CODE, code | 0);
    Atomics.store(c.ctrl, C.STATE, EXITED);
    Atomics.notify(c.ctrl, C.STATE);
  };
  /** A core process with no core left is ended after IDLE_MS, unless a core of its group comes first. */
  const idleCheck = (group, k) => {
    if (k.cores.size || k.idle || children.get(group) !== k) return;
    k.idle = setTimeout(() => {
      k.idle = null;
      if (k.cores.size || children.get(group) !== k) return;
      children.delete(group);
      try { k.p.disconnect(); } catch { /* gone */ }
      try { k.p.kill('SIGKILL'); } catch { /* gone */ }
    }, IDLE_MS);
    k.idle.unref();
  };
  // what the owner set (ARENA_CORE_PROCESS); only 'auto' steps down when a core process does not start
  const asked = String(workerData.coreProcess || 'auto');
  let mode = asked;
  const childOf = (group) => {
    const had = children.get(group);
    if (had) { if (had.idle) { clearTimeout(had.idle); had.idle = null; } return had; }
    let cmd;
    try { cmd = runnerCommand(mode); } catch (e) { console.log(`[sandbox] ${e.message}: the core process is not started`); throw e; }
    // AN EMPTY ENVIRONMENT, and nothing of this process's argv: the child is node, its permission flags and the runner
    const p = spawn(cmd[0], cmd[1], { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true });
    // `queued`: what was sent before the child said it is ready (a bwrap that cannot start is not the core's fault)
    const k = { p, ready: false, queued: [], said: '', started: cmd[2], cores: new Set(), idle: null };
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (s) => { if (k.said.length < 2048) k.said += s; });
    p.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ready') {
        k.ready = true;
        const q = k.queued; k.queued = null;
        for (const x of q) p.send(x);
        return;
      }
      const c = cores.get(m.id);
      if (!c || c.group !== group) return;
      if (m.t === 'answer') {
        Atomics.store(c.ctrl, C.HIGH_MB, m.high | 0);
        // the answer on the node thread's port first, then the flag it waits on (core-host.js answer())
        c.port.postMessage(m.m);
        Atomics.store(c.ctrl, C.STATE, ANSWERED);
        Atomics.notify(c.ctrl, C.STATE);
      } else if (m.t === 'exit') gone(m.id, m);
    });
    const lost = (why) => {
      if (children.get(group) !== k) return;
      children.delete(group);
      if (k.idle) { clearTimeout(k.idle); k.idle = null; }
      if (k.said.trim()) console.log(`[sandbox] the core process ended (${why}): ${k.said.trim().slice(0, 300)}`);
      // A BWRAP THAT NEVER STARTED THE RUNNER (no user namespaces on this machine, say) is the machine's, not a core's: in 'auto' the core
      // process is started again under the permission model alone, with what was waiting for it, and that is said once
      // ...and a node whose permission flags do not start one runs it as a plain process of its own, said as loudly
      if (!k.ready && asked === 'auto' && k.started !== 'plain') {
        if (mode === k.started) {
          mode = k.started === 'bwrap' ? 'node' : 'plain';
          console.log(k.started === 'bwrap' ? '[sandbox] bwrap could not start the core process: it runs under node\'s permission model alone (kanban #3557)'
            : '[sandbox] the core process did not start under node\'s permission model: it runs as a plain process of its own (kanban #3557)');
        }
        const q = k.queued || []; k.queued = null;
        for (const x of q) toChild(group, x);
        return;
      }
      k.queued = null;
      // only this process's cores: every other core's process is its own (kanban #3732)
      for (const id of [...k.cores]) gone(id, { code: 1, error: `the core process ended (${why})` });
    };
    p.on('exit', (code, signal) => lost(signal || `exit ${code}`));
    p.on('error', (e) => lost(String((e && e.code) || e).slice(0, 100)));
    p.unref();
    if (p.channel && typeof p.channel.unref === 'function') p.channel.unref();
    children.set(group, k);
    return k;
  };
  const toChild = (group, m) => {
    try {
      const k = childOf(group);
      if (m.t === 'spawn') k.cores.add(m.id);
      if (k.queued) k.queued.push(m); else k.p.send(m);
    } catch (e) { if (m.id) gone(m.id, { code: 1, error: `the core process could not be reached (${String(e && (e.code || e.message) || e).slice(0, 100)})` }); }
  };
  parentPort.on('message', (m) => {
    if (m.type === 'report') { report = m.port; report.unref(); return; }
    if (m.type === 'spawn') {
      const ctrl = new Int32Array(m.ctrl);
      const port = m.port;
      // (a spawn without its group - none of this node's - shares one process, as before kanban #3732)
      const group = typeof m.group === 'string' && m.group ? m.group : '-';
      cores.set(m.id, { ctrl, port, group });
      // the node thread's call: its op and JSON string, nothing else, to the child
      port.on('message', (q) => { if (cores.has(m.id)) toChild(group, { t: 'call', id: m.id, op: String(q && q.op), json: String(q && q.json) }); });
      port.unref();
      toChild(group, { t: 'spawn', id: m.id, files: m.files, entry: m.entry, name: m.name, arrayBudget: m.arrayBudget, liveCap: m.liveCap,
        answerMax: m.answerMax, heap: m.heap, triggerMb: m.triggerMb });
      return;
    }
    if (m.type === 'end' && cores.has(m.id)) toChild(cores.get(m.id).group, { t: 'end', id: m.id });
  });
}
