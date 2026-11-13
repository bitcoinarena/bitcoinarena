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
//    core thread's own memory every 2 ms while a call runs, ending the core before the backstop (kanban #1813: never
//    another thread's memory - one game's cores elsewhere in the process do not end another game's core). No vm timeout is used: one firing in
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
/** THE BACKSTOP: how far one core's own thread may grow while one call into it runs - read every 2 ms by the core supervisor
 *  (kanban #1813: its own isolate's memory, not the process's, which other games' cores share). */
export const RSS_BACKSTOP = 512 * 1024 * 1024;
/** THE LONGEST ANSWER a core may give one call, in characters (kanban #1691): the node copies it into its own thread and
 *  parses it there, where no limit of the core's thread applies. A replay's answer is a few kB (three truck words a picture);
 *  4 MB parses in well under ASK_MS. core-host.js refuses a longer one before it is posted, and the node again before it is read. */
export const ANSWER_MAX = 4 * 1024 * 1024;
/** THE LONGEST FAILURE TEXT (kanban #2165, #2232, #2304; refute of #1691): core-host.js cuts the core's own message to 1 kB
 *  before posting it; with the host's own prefix a `why` is far below this. Anything else - not a string, or longer - is never
 *  thrown into the node: the core is ended, and a fixed text says so. */
export const WHY_MAX = 4096;
const whyBounded = (why) => typeof why === 'string' && why.length <= WHY_MAX;
/** The supervisor ends a core this far below the backstop: it reads the process every 2 ms, and a core allocating at full
 *  speed keeps going for the moments its isolate takes to stop (measured on the card). */
const BACKSTOP_MARGIN_MB = 96;
/** After a core is ended: how long the node waits for its supervisor to say the thread is gone. */
const EXIT_WAIT_MS = 3000;
/** A load with ONE ABSOLUTE DEADLINE (`until`, the plugin trial) waits for its thread's end at most this far past it (kanban
 *  #1880, #1913): an idle thread is gone in a few ms, and one in an uninterruptible builtin is not waited for (see `lingering`). */
const UNTIL_EXIT_GRACE_MS = 100;
// THREADS ENDED BUT NOT YET GONE (kanban #1880, #1913): a core inside ONE long builtin (a sort, a parse) does not take V8's
// TerminateExecution until the builtin returns, so end() waiting EXIT_WAIT_MS held the seat's thread past a deadline the caller
// set - twice, once in the deadline's end() and once in the caller's. A load with `until` does not wait past it: the supervisor
// has been told to end the thread (it dies the moment the builtin returns, inside its heap limits), and it is kept here by its
// load's name, so a caller can refuse to start another while one still lingers (plugin-trial.js).
const lingering = new Set();
/** How many ended core threads named `name` (every one when null) are not yet gone. */
export function lingeringCores(name = null) {
  let n = 0;
  for (const l of [...lingering]) {
    if (Atomics.load(l.ctrl, C.STATE) === EXITED) { lingering.delete(l); continue; }
    if (name === null || l.name === name) n++;
  }
  return n;
}
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

/** ONE CORE THREAD (core-host.js), started by this thread's supervisor and loaded: { call(op, input, within) answering the
 *  driver's JSON, end(why), lastEnd, highWaterMb }. Throws when the core does not load. */
function startThread({ files, entry }, { callMs, stepMs, askMs, loadMs, name, arrayBudget, liveCap, heap, rssBackstop, answerMax = ANSWER_MAX, until = null, lingerAs = null, loadUntil = null }) {
  // `lingerAs`: the label an ended, not yet gone thread is kept under for lingeringCores (the plugin trial's, kanban #1880) - never
  // the core's own name, which stays the seat's (kanban #1694)
  // `until` (kanban #1719, #1538): ONE ABSOLUTE DEADLINE (a Date.now() time) for the load AND the meta ask loadCore makes
  // itself - the plugin trial gives load, meta and every decide call one TRIAL_MS in total; meta reads DECIDE's fields, which
  // may be getters, so without it load + meta held the seat's thread up to loadMs + askMs
  // `loadUntil` (kanban #2058, #2078): the same one deadline for the load and its meta ask ONLY - the first load of a core a seat
  // has just adopted (plugin-package.js registrationFromPackage) is bounded like the trial, and the box it gives is kept with
  // the installed core's own deadlines from then on
  let loading = true;
  const by = () => Math.min(Number.isFinite(until) ? until : Infinity, loading && Number.isFinite(loadUntil) ? loadUntil : Infinity);
  const leftOf = (ms) => (Number.isFinite(by()) ? Math.max(1, Math.min(ms, by() - Date.now())) : ms);
  const sup = supervisorOf();
  const id = sup.next++;
  const ctrl = new Int32Array(new SharedArrayBuffer(8 * 4));
  Atomics.store(ctrl, C.FROM_MB, -1);   // kanban #1813: the core thread writes its own figure when its load or a call begins
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  // THE TRIGGER sits BACKSTOP_MARGIN below the backstop: sampled every 2 ms, and the core keeps allocating until its isolate
  // stops, so the line it must never cross is the backstop itself, not the trigger
  const triggerMb = Math.max(1, Math.round(rssBackstop / 1048576) - BACKSTOP_MARGIN_MB);
  sup.worker.postMessage({ type: 'spawn', id, files: [...files], entry, name, port: port2, ctrl: ctrl.buffer, arrayBudget, liveCap,
    answerMax, heap: { ...heap }, triggerMb }, [port2]);
  let ended = null;
  let lastEnd = null;
  const rssMb = () => Math.round(process.memoryUsage.rss() / 1048576);
  /** THE THREAD'S OWN END, read from its supervisor: why it exited, and the call's high-water. */
  const gone = () => Atomics.load(ctrl, C.STATE) === EXITED;
  /** END THE CORE'S THREAD and wait - in slices - for its supervisor to say the thread is gone: what it held goes with it,
   *  before the node answers. At most EXIT_WAIT_MS. */
  // ONCE ONLY, AND NEVER PAST `until` + UNTIL_EXIT_GRACE_MS (kanban #1880, #1913): a second end() (the caller's, after the
  // deadline's own) does not wait again, and a thread still inside a builtin is left to its supervisor (`lingering`)
  const end = (why) => {
    if (ended) return;
    ended = why;
    const t0 = Date.now();
    const waitMs = Number.isFinite(by()) ? Math.max(0, Math.min(EXIT_WAIT_MS, by() + UNTIL_EXIT_GRACE_MS - t0)) : EXIT_WAIT_MS;
    if (!gone()) sup.worker.postMessage({ type: 'end', id });
    while (!gone() && Date.now() - t0 < waitMs) Atomics.wait(ctrl, C.STATE, Atomics.load(ctrl, C.STATE), Math.max(1, Math.min(10, waitMs - (Date.now() - t0))));
    if (!gone()) lingering.add({ ctrl, name: lingerAs || name });
    lastEnd = { exitMs: Date.now() - t0, exited: gone(), rssMb: rssMb(), highMb: Atomics.load(ctrl, C.HIGH_MB) };
    Atomics.store(ctrl, C.CALL, 0);
  };
  /** Wait for the core thread's next answer, or its end: the deadline, its supervisor's backstop, its exit. */
  const wait = (ms, what) => {
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
  const loaded = wait(leftOf(loadMs), 'loading');
  loading = false;   // (kanban #2058) the load's own bound ends with the load
  // kanban #2165, #2232, #2304: a failure text past WHY_MAX (or not a string) is never thrown into the node
  if (!loaded.ok) { const why = whyBounded(loaded.why) ? loaded.why : `the core failed while loading with a message longer than ${WHY_MAX} characters`; end(why); throw new Error(why); }

  // `within`: a shorter deadline for this one call (kanban #1538: the plugin trial run gives all its calls one deadline in total)
  const callHere = (op, input = {}, within = null) => {
    if (ended) throw new Error(ended);
    // kanban #1813: unknown until the core thread writes its own memory as it takes this call (before the post: never stale)
    Atomics.store(ctrl, C.FROM_MB, -1);
    port1.postMessage({ op: String(op), json: plain(input) });
    const ms = Number.isFinite(within) ? Math.max(1, Math.min(within, { callMs, stepMs, askMs }[DEADLINE[op] || 'askMs'])) : { callMs, stepMs, askMs }[DEADLINE[op] || 'askMs'];
    const a = wait(ms, op);
    // kanban #2165, #2232, #2304: a failure text past WHY_MAX (or not a string) is never thrown into the node - a bounded one is
    if (!a.ok && !whyBounded(a.why)) throw new Error(`the core failed in ${op} with a message longer than ${WHY_MAX} characters`);
    // A CALL PAST ITS ARRAY BUDGET FAILS, AND ONLY THAT CALL (kanban #1721, #1792, #1831): core-host.js drops the context it
    // ran in - the core cannot catch the refusal and keep what it held. Ending the core here made every later call on this
    // seat fail ("it is not run again") while a seat that never ran that input answered them: the seat's history again.
    // kanban #1691: past its answer size the core is ended, as core-host.js does - and an answer that is not a string of at most
    // ANSWER_MAX characters is never parsed in this thread
    if (!a.ok && /its answer was longer than/.test(a.why)) { end(`${a.why}: its thread was ended, and it is not run again`); throw new Error(ended); }
    if (!a.ok) throw new Error(a.why);
    if (typeof a.json !== 'string' || a.json.length > answerMax) { end(`the core answered ${op} with more than ${answerMax} characters: its thread was ended, and it is not run again`); throw new Error(ended); }
    return a.json;
  };
  return { call: callHere, end, ended: () => ended, lastEnd: () => lastEnd, highWaterMb: () => Atomics.load(ctrl, C.HIGH_MB) };
}

/** The warm ghost's operations: a run kept in the core between calls. Nobody signs what they answer. */
const KEPT = new Set(['open', 'pose', 'stepTo', 'drop']);
/** The small asks whose answer is kept by input: a call on a thread of its own answers from the core's files and the input alone. */
const PURE = new Set(['meta', 'runTicks', 'runTicksFits']);
const PURE_MAX = 4096;

/**
 * LOAD ONE CORE INTO A SANDBOX OF ITS OWN, in a thread of its own, from its files (read and checked above). Answers
 * { call(op, input), meta }: `call` hands the driver a JSON copy of `input`, waits for its answer against the op's deadline
 * and answers it revived. A core that does not load (an import outside its files, a top level that throws or does not stop)
 * is refused here, before it is ever asked anything. A call on a thread of its own that misses its deadline, dies of its
 * heap limit or grows this process past the backstop fails alone: that thread is ended - the node waits for it to be gone -
 * and the next call gets a fresh one (kanban #2008). On the kept thread (KEPT, `oneThread`) the same ends the core, and it
 * is refused from then on. A call past its array budget fails alone.
 *
 * EVERY CALL THE NODE SIGNS ON IS ANSWERED BY A THREAD STARTED FOR IT (kanban #1721, #1792, #1831): meta, runTicks,
 * runTicksFits, replay and decide each run on a core thread loaded from the core's files for that one call and ended after
 * it (about 16 ms for the truck's 450 KB, measured), so the answer is a function of the files and the input alone. Before,
 * one thread served a core's whole life: a core that counted its calls in a module variable answered the same call 10 on
 * a fresh thread and 9 after one call (measured), and the arrays an earlier call dropped decided whether a later one was
 * ended - a seat's answer to a round depended on which rounds it had replayed before, and when. The long-lived thread
 * loaded here serves only the warm ghost (KEPT), whose answers nobody signs - and every call with `oneThread` (the
 * plugin trial, which wants to see what an adapter keeps across calls). The small asks (PURE) are answered once per input.
 */
export function loadCore({ files, entry }, { callMs = CALL_MS, stepMs = STEP_MS, askMs = ASK_MS, loadMs = LOAD_MS, name = entry,
  arrayBudget = ARRAY_BUDGET, liveCap = 0, oneThread = false, heap = HEAP_LIMITS, rssBackstop = RSS_BACKSTOP, answerMax = ANSWER_MAX, until = null, lingerAs = null, loadUntil = null } = {}) {
  // answerMax (kanban #1691), until (kanban #1719), lingerAs (kanban #1880) and loadUntil (kanban #2058) reach every thread this core starts
  const opts = { callMs, stepMs, askMs, loadMs, name, arrayBudget, liveCap, heap, rssBackstop, answerMax, until, lingerAs, loadUntil };
  const leftOf = (ms) => (Number.isFinite(until) ? Math.max(1, Math.min(ms, until - Date.now())) : ms);
  let kept = startThread({ files, entry }, opts);
  let ended = null;
  let last = kept;
  const memo = new Map();
  const end = (why) => { ended = why; kept.end(why); };
  const call = (op, input = {}, within = null) => {
    if (ended) throw new Error(ended);
    op = String(op);
    if (oneThread || KEPT.has(op)) {
      // THE WARM GHOST'S THREAD THAT DIES ENDS THAT THREAD ALONE (kanban #2121, #1489 v1-refute-45-s3-1, as #2008 for a call's own
      // thread): a player's input that kills its heap while a ghost is stepped is set by the input, not by the core, and ending the
      // core made every later signed call on this seat throw "it is not run again" while seats that never drew that ghost answered.
      // The next KEPT call gets a fresh kept thread (the open runs went with the old one: the ghosts open them again). Only the
      // plugin trial (`oneThread`), which watches one thread across calls, still ends the core.
      if (!oneThread && kept.ended()) kept = startThread({ files, entry }, opts);
      last = kept;
      try { return revive(kept.call(op, input, within)); } finally { if (oneThread && kept.ended()) ended = kept.ended(); }
    }
    const key = PURE.has(op) ? `${op}\0${plain(input)}` : null;
    if (key !== null && memo.has(key)) return revive(memo.get(key));
    // A CALL'S OWN THREAD THAT DIES FAILS THAT CALL ALONE (kanban #2008, #1539): its heap limit, its deadline, the backstop
    // or its load. The thread is ended - what it held goes with it - but this core's `ended` and the kept thread are not
    // touched. A heap death is set by the input (every seat that runs it dies), so ending the core here made every later
    // round fail on the seats that had replayed it ("it is not run again") while seats on other committees answered the
    // same round: the seat's history decided its answer again, as the array budget did before #1721.
    const one = startThread({ files, entry }, opts);
    last = one;
    let json;
    try { json = one.call(op, input, within); }
    finally { if (!one.ended()) one.end('answered'); }
    if (key !== null) { if (memo.size >= PURE_MAX) memo.clear(); memo.set(key, json); }
    return revive(json);
  };
  // the core's meta from the thread just loaded, before it was asked anything: what a thread of its own would answer
  let meta;
  // the meta ask inside the trial's one deadline when one is given (kanban #1719)
  try { meta = revive(kept.call('meta', {}, Number.isFinite(until) ? leftOf(askMs) : null)); } catch (e) { kept.end(e.message); throw e; }
  memo.set(`meta\0${plain({})}`, JSON.stringify(meta));
  return Object.freeze({ call, meta, end: () => end('ended by the node'), lastEnd: () => last.lastEnd(), endedWhy: () => ended, highWaterMb: () => last.highWaterMb() });
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
