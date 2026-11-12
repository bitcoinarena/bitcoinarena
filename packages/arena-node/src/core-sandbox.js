// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SANDBOX A GAME'S CORE RUNS IN, AND THE ONLY WAY THIS NODE RUNS ONE (spec §0A.6).
//
// "It runs it only in the replay worker: no network, no file system, no clock, no randomness but the round's seed, the
// same integers on every machine." Before this a core was imported like any module of the node - in the replay worker,
// in the daemon's own thread (the registrations main.js loads, the packages plugin-package.js installs) and under the warm
// ghost - with every right the process has. Now every one of those loads comes here:
//
// 1. FILES, READ BY THE NODE. The node reads the core's files itself and checks them against the core's hash before a
//    line of it runs: a tree (every .js under `root`) or one file (sha256 of its bytes), by core-hash.js - the rule an app
//    takes from arena-sdk/core-hash (kanban #691). The core gets source text only; it never opens a file.
// 2. AN EMPTY CONTEXT. A fresh vm context with a global of its own (no node object behind it), code generation off (no eval, no Function, no
//    wasm). Before the core is evaluated its own intrinsics lose Date, Math.random, Intl, WebAssembly, SharedArrayBuffer,
//    Atomics, eval, Function, WeakRef, FinalizationRegistry and V8's own console; fetch, process, require, Buffer, timers,
//    performance and crypto are never there - a vm context does not have the node's globals.
// 3. THE LINKER IS THE GATE. Its modules are linked as vm.SourceTextModule (the core thread is started with --experimental-vm-modules; the node needs no flag): a relative
//    import resolves inside the hashed file set and nowhere else; node:*, package names, absolute paths and URLs are
//    refused, and with no importModuleDynamically an import() throws.
// 4. ONLY STRINGS CROSS. core-driver.js runs beside the core in the same sandbox and is called with an operation's name
//    and a JSON string; it answers a JSON string. No object of the node's is ever handed in.
// 5. A THREAD OF ITS OWN, WATCHED. The sandbox is built in a worker thread per core (core-host.js), a V8 isolate of its own
//    that holds none of the node's memory; the node calls it synchronously and waits for each answer against a deadline
//    (Atomics.wait). Each core thread is started by this node thread's core supervisor (core-supervisor.js), a thread that is
//    never blocked: it hears the core thread's exit at once - a heap death wakes the node, not its deadline - and reads the
//    process's memory every 2 ms while a call runs, ending the core before the backstop. No vm timeout is used: one firing in
//    the node's own thread was measured aborting the whole process (node 24.15, "Assertion failed: (env_->execution_async_id())
//    == (0)").
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { C, ANSWERED, EXITED } from './core-supervisor.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coreTree, coreRelPath, coreBytesHashHex } from './core-hash.js';

/** The longest a replay may run: a whole replay of the longest run (10800 ticks) is a few seconds; this is the ceiling. */
export const CALL_MS = 120000;
/** A warm ghost catching up (stepTo) in the node's own thread, which waits on it: less. */
export const STEP_MS = 30000;
/** Everything else the node asks a core (meta, run length, decide, a pose): a moment. */
export const ASK_MS = 2000;
/** Loading a core: its thread started and its modules' top level evaluated. */
export const LOAD_MS = 10000;
// ITS MEMORY (spec §0A.6): time alone did not bound it - measured, a core that allocated in a loop took the node
// to 2.9 GB before a 20 s deadline ended it. Three limits, each measured on the card:
/** The bytes of typed arrays and ArrayBuffers alive in one core's sandbox (core-host.js counts them; the core's real need
 *  is 0.28 MB for a whole 10800-tick replay, so 64 MB is about 228 times it). */
export const ARRAY_BUDGET = 64 * 1024 * 1024;
/** The V8 heap of the core's thread: its arrays, objects and strings. Past it only that thread dies. */
export const HEAP_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 });
/** THE BACKSTOP: how far this process may grow while one call into a core runs - read every 2 ms by the core supervisor. */
export const RSS_BACKSTOP = 512 * 1024 * 1024;
/** The supervisor ends a core this far below the backstop: it reads the process every 2 ms, and a core allocating at full
 *  speed keeps going for the moments its isolate takes to stop (measured on the card). */
const BACKSTOP_MARGIN_MB = 96;
/** After a core is ended: how long the node waits for its supervisor to say the thread is gone. */
const EXIT_WAIT_MS = 3000;
const DEADLINE = { replay: 'callMs', stepTo: 'stepMs' };

/** A core's files as core-hash.js hashes a tree (the rule an app takes from arena-sdk/core-hash, kanban #691): the hash, and each file's text by path. */
function treeOf(root) {
  const { hash, files } = coreTree(root);
  return { hash, files: new Map([...files].map(([rel, bytes]) => [rel, bytes.toString('utf8')])) };
}

/**
 * THE CORE'S FILES, READ AND CHECKED BY THE NODE: `root` (a directory URL or path) means a tree hashed as a whole, else
 * the one file `url` names, hashed alone. `sourceHash` when the core's name is not its files' hash (the truck before the
 * 82/90 fork runs 2069b4c2's files), else `hash`. Answers the files by path and the entry's path among them.
 */
/** The entry name of every single-file core, in the plugin trial and at the seat alike (kanban #1694). */
export const SINGLE_ENTRY = 'core.mjs';
export function coreFiles(core) {
  if (!core || typeof core.url !== 'string') throw new Error('that core names no file to load');
  const entryPath = fileURLToPath(core.url);
  const want = String(core.sourceHash || core.hash || '').toLowerCase();
  if (core.root) {
    const root = core.root instanceof URL || String(core.root).startsWith('file:') ? fileURLToPath(core.root) : String(core.root);
    const { hash, files } = treeOf(root);
    if (hash !== want) throw new Error(`core ${String(core.hash).slice(0, 16)}: its files hash to ${hash.slice(0, 16)}, not ${want.slice(0, 16)}`);
    const entry = coreRelPath(root, entryPath);
    if (!files.has(entry)) throw new Error(`core ${String(core.hash).slice(0, 16)}: its entry ${entry} is not one of its files`);
    return { files, entry };
  }
  const bytes = readFileSync(entryPath);
  const hash = coreBytesHashHex(bytes);
  if (hash !== want) throw new Error(`core ${String(core.hash).slice(0, 16)}: its file hashes to ${hash.slice(0, 16)}, not ${want.slice(0, 16)}`);
  // ONE NAME FOR EVERY SINGLE-FILE CORE (kanban #1694): the module's identifier was its file name ('core-<hash>.mjs' as
  // installed, 'core.mjs' in the plugin trial), and V8's stack text names it - so an adapter could read where it ran and
  // pass the trial, then spin at load in the seat's thread. Now the trial and every seat load it as SINGLE_ENTRY.
  return { files: new Map([[SINGLE_ENTRY, bytes.toString('utf8')]]), entry: SINGLE_ENTRY };
}

/** Reads back a driver answer: tagged bigints and bytes restored. */
const revive = (s) => JSON.parse(s, (k, x) => {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    if (typeof x.$big === 'string' && Object.keys(x).length === 1) return BigInt(x.$big);
    if (typeof x.$u8 === 'string' && Object.keys(x).length === 1) return Uint8Array.from(x.$u8.match(/../g) || [], (h) => parseInt(h, 16));
  }
  return x;
});

/** A JSON-able copy of what the node hands in: bytes as arrays of numbers, bigints refused (the core takes integers). */
const plain = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : typeof x === 'bigint' ? Number(x) : x));

/**
 * LOAD ONE CORE INTO A SANDBOX OF ITS OWN, in a thread of its own, from its files (read and checked above). Answers
 * { call(op, input), meta }: `call` hands the driver a JSON copy of `input`, waits for its answer against the op's deadline
 * and answers it revived. A core that does not load (an import outside its files, a top level that throws or does not stop)
 * is refused here, before it is ever asked anything; a core that misses a deadline is ended and refused from then on.
 */
/** THE SUPERVISOR of this thread's core threads (core-supervisor.js), started with the first core: a thread that is never
 *  blocked, so it hears each core thread's exit at once and reads the process's memory every 2 ms while a call runs. */
let supervisor = null;
function supervisorOf() {
  if (!supervisor) {
    // no flags of the process (the core thread names its own): a worker refuses --input-type, and a node started with
    // `node --input-type=module -e` lost its supervisor and waited out every core's load deadline
    const worker = new Worker(new URL('./core-supervisor.js', import.meta.url), { env: {}, workerData: { arenaCoreSupervisor: true },
      execArgv: [] });
    worker.unref();
    worker.on('error', (e) => { console.log(`[sandbox] the core supervisor failed: ${e && e.message}`); supervisor = null; });
    const { port1, port2 } = new MessageChannel();
    port1.unref();
    worker.postMessage({ type: 'report', port: port2 }, [port2]);
    supervisor = { worker, deaths: port1, said: new Map(), next: 1 };
  }
  return supervisor;
}
/** Why a core's thread exited, as its supervisor reported it (a heap death says ERR_WORKER_OUT_OF_MEMORY). */
function deathOf(sup, id) {
  for (let m = receiveMessageOnPort(sup.deaths); m; m = receiveMessageOnPort(sup.deaths)) sup.said.set(m.message.id, m.message);
  const d = sup.said.get(id); sup.said.delete(id);
  return d || null;
}

/**
 * LOAD ONE CORE INTO A SANDBOX OF ITS OWN, in a thread of its own, from its files (read and checked above). Answers
 * { call(op, input), meta }: `call` hands the driver a JSON copy of `input`, waits for its answer against the op's deadline
 * and answers it revived. A core that does not load (an import outside its files, a top level that throws or does not stop)
 * is refused here, before it is ever asked anything; a core that misses a deadline, dies of its heap limit, crosses its
 * array budget or grows this process past the backstop is ended - the node waits for its thread to be gone - and refused
 * from then on.
 */
export function loadCore({ files, entry }, options = {}) {
  const { callMs = CALL_MS, stepMs = STEP_MS, askMs = ASK_MS, loadMs = LOAD_MS, name = entry,
    arrayBudget = ARRAY_BUDGET, liveCap = 0, heap = HEAP_LIMITS, rssBackstop = RSS_BACKSTOP, oneReplay = false } = options;
  const sup = supervisorOf();
  const id = sup.next++;
  const ctrl = new Int32Array(new SharedArrayBuffer(8 * 4));
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  // THE TRIGGER sits BACKSTOP_MARGIN below the backstop: sampled every 2 ms, and the core keeps allocating until its isolate
  // stops, so the line it must never cross is the backstop itself, not the trigger
  const triggerMb = Math.max(1, Math.round(rssBackstop / 1048576) - BACKSTOP_MARGIN_MB);
  sup.worker.postMessage({ type: 'spawn', id, files: [...files], entry, name, port: port2, ctrl: ctrl.buffer, arrayBudget, liveCap,
    heap: { ...heap }, triggerMb }, [port2]);
  let ended = null;
  let lastEnd = null;
  const rssMb = () => Math.round(process.memoryUsage.rss() / 1048576);
  /** THE THREAD'S OWN END, read from its supervisor: why it exited, and the call's high-water. */
  const gone = () => Atomics.load(ctrl, C.STATE) === EXITED;
  /** END THE CORE'S THREAD and wait - in slices - for its supervisor to say the thread is gone: what it held goes with it,
   *  before the node answers. At most EXIT_WAIT_MS. */
  const end = (why) => {
    ended = why;
    const t0 = Date.now();
    if (!gone()) sup.worker.postMessage({ type: 'end', id });
    while (!gone() && Date.now() - t0 < EXIT_WAIT_MS) Atomics.wait(ctrl, C.STATE, Atomics.load(ctrl, C.STATE), 10);
    lastEnd = { exitMs: Date.now() - t0, exited: gone(), rssMb: rssMb(), highMb: Atomics.load(ctrl, C.HIGH_MB) };
    Atomics.store(ctrl, C.CALL, 0);
  };
  /** Wait for the core thread's next answer, or its end: the deadline, its supervisor's backstop, its exit. */
  const wait = (ms, what) => {
    Atomics.store(ctrl, C.FROM_MB, rssMb());
    Atomics.store(ctrl, C.HIGH_MB, 0);
    Atomics.store(ctrl, C.CALL, 1);
    const until = Date.now() + ms;
    let state = Atomics.load(ctrl, C.STATE);
    while (state === 0) {
      const left = until - Date.now();
      if (left <= 0) break;
      Atomics.wait(ctrl, C.STATE, 0, left);
      state = Atomics.load(ctrl, C.STATE);
    }
    if (state === ANSWERED) {
      Atomics.store(ctrl, C.CALL, 0);
      Atomics.store(ctrl, C.STATE, 0);
      const got = receiveMessageOnPort(port1);
      if (!got) { end('the core thread answered nothing'); throw new Error(ended); }
      return got.message;
    }
    if (state === EXITED) {
      // THE THREAD IS GONE BEFORE ITS ANSWER: the supervisor's backstop ended it, or it died (its heap limit)
      const caught = Atomics.load(ctrl, C.CAUGHT);
      const d = deathOf(sup, id);
      end(caught
        ? `the core grew this node by ${caught} MB in ${what}, and a call may grow it by at most ${Math.round(rssBackstop / 1048576)} MB: its thread was ended at ${triggerMb} MB, and it is not run again`
        : `the core's thread died in ${what}${d && d.error ? ` (${d.error === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out of its heap' : d.error})` : ''}: it is not run again`);
      throw new Error(ended);
    }
    end(`the core did not stop within ${ms} ms (${what}): its thread was ended, and it is not run again`);
    throw new Error(ended);
  };
  const loaded = wait(loadMs, 'loading');
  if (!loaded.ok) { end(loaded.why); throw new Error(loaded.why); }

  // `within`: a shorter deadline for this one call (kanban #1538: the plugin trial run gives all its calls one deadline in total)
  const callHere = (op, input = {}, within = null) => {
    if (ended) throw new Error(ended);
    port1.postMessage({ op: String(op), json: plain(input) });
    const ms = Number.isFinite(within) ? Math.max(1, Math.min(within, { callMs, stepMs, askMs }[DEADLINE[op] || 'askMs'])) : { callMs, stepMs, askMs }[DEADLINE[op] || 'askMs'];
    const a = wait(ms, op);
    // A CORE AT ITS ARRAY BUDGET IS ENDED, not asked again: it could catch the refusal and keep going, and what it holds goes
    // with its thread
    if (!a.ok && /asked for more than \d+ MB of arrays/.test(a.why)) { end(`${a.why}: its thread was ended, and it is not run again`); throw new Error(ended); }
    if (!a.ok) throw new Error(a.why);
    return revive(a.json);
  };
  // A REPLAY RUNS ON A FRESH CORE THREAD OF ITS OWN (kanban #1624): a core that recursed until V8's "Maximum call stack size
  // exceeded", caught the RangeError and counted its frames read its thread's JIT history - a frame's size depends on the tier
  // its function runs in, and the tiers on a thread depend on what it ran before (measured: 400 replays of one input on one
  // thread answered depths 41205, 41206 and 41209; 60 replays each on a fresh thread answered 41205 every time). The stack
  // overflow cannot be made sticky like the array budget: V8 builds and throws it without running any code a sandbox could
  // hook (not even the debugger hears it). So the replay - the call whose answer a seat signs - starts from the same history
  // every time: a thread loaded for it alone (~45 ms), ended after it. A thread that ends that way (a deadline, the array
  // budget, its heap, the backstop) ends this core too, as before. What this does not close: two machines (another CPU,
  // another node build) still count a different depth - that is a core's own nondeterminism, as with any engine limit.
  let lastOne = null;
  const replayFresh = (input, within) => {
    if (ended) throw new Error(ended);
    const one = loadCore({ files, entry }, { ...options, oneReplay: true });
    lastOne = one;
    try { return one.call('replay', input, within); } catch (e) {
      const why = one.endedWhy();
      if (why) { end(why); lastEnd = one.lastEnd(); }
      throw e;
    } finally { if (!one.endedWhy()) one.end(); }
  };
  const call = (op, input = {}, within = null) => (String(op) === 'replay' && !oneReplay ? replayFresh(input, within) : callHere(op, input, within));
  const meta = callHere('meta');
  return Object.freeze({ call, meta, end: () => end('ended by the node'), lastEnd: () => lastEnd, endedWhy: () => ended,
    highWaterMb: () => (lastOne ? lastOne.highWaterMb() : Atomics.load(ctrl, C.HIGH_MB)) });
}

/** Does this core draw a picture (a ghost)? false only when its sandbox says it does not; null when it does not load. */
export function drawsPicture(core) {
  try { return sandboxFor(core).meta.picture; } catch { return null; }
}

const cache = new Map();
/**
 * THE SANDBOX FOR A CORE AS A GAME INSTALLED IT ({ url, hash, root?, sourceHash? }), loaded once per thread and kept: the
 * one way the node reaches a core. Throws when the core cannot be sandboxed - a node that cannot run a core in the sandbox
 * does not run it.
 */
export function sandboxFor(core, options) {
  if (!core || typeof core.url !== 'string') throw new Error('that core names no file to load');
  const key = `${core.url}|${core.root || ''}|${core.sourceHash || core.hash}`;
  let s = cache.get(key);
  if (!s) {
    // A REFUSED CORE STAYS REFUSED in this thread: it is not read, started and waited for again on every ask
    try { s = loadCore(coreFiles(core), { name: core.name || String(core.hash).slice(0, 16), ...options }); }
    catch (e) {
      // ...BUT A LOAD THAT ONLY RAN OUT OF TIME is not cached (kanban #1586): a busy node can miss LOAD_MS once, and a refusal kept
      // for the thread's life left every later close of that game - a head-to-head decide's retry too - failing until a restart
      if (/did not stop within \d+ ms \(loading\)/.test(e.message)) throw e;
      s = { refused: e.message };
    }
    cache.set(key, s);
  }
  if (s.refused) throw new Error(s.refused);
  askedAt.set(key, Date.now());
  if (!sweeper && CORE_IDLE_MS > 0) { sweeper = setInterval(() => endIdleCores(CORE_IDLE_MS), 60000); sweeper.unref(); }
  return s;
}

// AN IDLE CORE'S THREAD IS ENDED, and loaded again on its next ask (kanban #576, measured 2026-10-23 03:5xZ on test host seat 1:
// RSS 1,139 MB of which the node's own heap was 212 MB - the rest mostly the 11 worker threads, one isolate per core of every
// game version it hosts, each kept for the life of the process though most versions are seldom played). Every caller asks
// sandboxFor() for each use, so nothing holds an ended core.
const CORE_IDLE_MS = Number(process.env.ARENA_CORE_IDLE_MS || 15 * 60000);
const askedAt = new Map();
let sweeper = null;
/** End every loaded core not asked for in `idleMs`; answers how many were ended. */
export function endIdleCores(idleMs = CORE_IDLE_MS) {
  const now = Date.now();
  let ended = 0;
  for (const [key, at] of [...askedAt]) {
    if (now - at < idleMs) continue;
    const s = cache.get(key);
    askedAt.delete(key); cache.delete(key);
    if (s && typeof s.end === 'function') { try { s.end(); ended += 1; } catch { /* already gone */ } }
  }
  return ended;
}
