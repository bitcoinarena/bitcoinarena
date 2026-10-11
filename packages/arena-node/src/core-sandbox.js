// THE SANDBOX A GAME'S CORE RUNS IN, AND THE ONLY WAY THIS NODE RUNS ONE (spec §0A.6, kanban #328).
//
// "It runs it only in the replay worker: no network, no file system, no clock, no randomness but the round's seed, the
// same integers on every machine." Before this a core was imported like any module of the node - in the replay worker,
// in the daemon's own thread (the registrations main.js loads, the packages plugin-package.js installs) and under the warm
// ghost - with every right the process has. Now every one of those loads comes here:
//
// 1. FILES, READ BY THE NODE. The node reads the core's files itself and checks them against the core's hash before a
//    line of it runs: a tree (every .js under `root`, hashed as nextblock's tools/hash-core.js does) or one file (sha256
//    of its bytes). The core gets source text only; it never opens a file.
// 2. AN EMPTY CONTEXT. A fresh vm context with a global of its own (no node object behind it), code generation off (no eval, no Function, no
//    wasm). Before the core is evaluated its own intrinsics lose Date, Math.random, Intl, WebAssembly, SharedArrayBuffer,
//    Atomics, eval, Function, WeakRef, FinalizationRegistry and V8's own console; fetch, process, require, Buffer, timers,
//    performance and crypto are never there - a vm context does not have the node's globals.
// 3. THE LINKER IS THE GATE. Its modules are linked as vm.SourceTextModule (the core thread is started with --experimental-vm-modules; the node needs no flag): a relative
//    import resolves inside the hashed file set and nowhere else; node:*, package names, absolute paths and URLs are
//    refused, and with no importModuleDynamically an import() throws.
// 4. ONLY STRINGS CROSS. core-driver.js runs beside the core in the same sandbox and is called with an operation's name
//    and a JSON string; it answers a JSON string. No object of the node's is ever handed in.
// 5. A THREAD OF ITS OWN AND A DEADLINE. The sandbox is built in a worker thread per core (core-host.js), a V8 isolate of
//    its own that holds none of the node's memory; the node calls it synchronously and waits for each answer against a
//    deadline (Atomics.wait). A core that does not stop - at load or in a call, microtasks included - misses it, and its
//    thread is ended and the core refused from then on. No vm timeout is used: one firing in the node's own thread was
//    measured aborting the whole process (node 24.15, "Assertion failed: (env_->execution_async_id()) == (0)").
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The longest a replay may run: a whole replay of the longest run (10800 ticks) is a few seconds; this is the ceiling. */
export const CALL_MS = 120000;
/** A warm ghost catching up (stepTo) in the node's own thread, which waits on it: less. */
export const STEP_MS = 30000;
/** Everything else the node asks a core (meta, run length, decide, a pose): a moment. */
export const ASK_MS = 2000;
/** Loading a core: its thread started and its modules' top level evaluated. */
export const LOAD_MS = 10000;
const DEADLINE = { replay: 'callMs', stepTo: 'stepMs' };

/** A core's files as nextblock's hash-core.js hashes a tree: every .js below root, sorted, `rel \0 bytes \0`. */
function treeOf(root) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(root);
  files.sort();
  const h = createHash('sha256');
  const out = new Map();
  for (const f of files) {
    const rel = relative(root, f).split('\\').join('/');
    const bytes = readFileSync(f);
    h.update(rel); h.update('\0'); h.update(bytes); h.update('\0');
    out.set(rel, bytes.toString('utf8'));
  }
  return { hash: h.digest('hex'), files: out };
}

/**
 * THE CORE'S FILES, READ AND CHECKED BY THE NODE: `root` (a directory URL or path) means a tree hashed as a whole, else
 * the one file `url` names, hashed alone. `sourceHash` when the core's name is not its files' hash (the truck before the
 * 82/90 fork runs 2069b4c2's files), else `hash`. Answers the files by path and the entry's path among them.
 */
export function coreFiles(core) {
  if (!core || typeof core.url !== 'string') throw new Error('that core names no file to load');
  const entryPath = fileURLToPath(core.url);
  const want = String(core.sourceHash || core.hash || '').toLowerCase();
  if (core.root) {
    const root = core.root instanceof URL || String(core.root).startsWith('file:') ? fileURLToPath(core.root) : String(core.root);
    const { hash, files } = treeOf(root);
    if (hash !== want) throw new Error(`core ${String(core.hash).slice(0, 16)}: its files hash to ${hash.slice(0, 16)}, not ${want.slice(0, 16)}`);
    const entry = relative(root, entryPath).split('\\').join('/');
    if (!files.has(entry)) throw new Error(`core ${String(core.hash).slice(0, 16)}: its entry ${entry} is not one of its files`);
    return { files, entry };
  }
  const bytes = readFileSync(entryPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== want) throw new Error(`core ${String(core.hash).slice(0, 16)}: its file hashes to ${hash.slice(0, 16)}, not ${want.slice(0, 16)}`);
  const entry = entryPath.split(/[\\/]/).pop();
  return { files: new Map([[entry, bytes.toString('utf8')]]), entry };
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
export function loadCore({ files, entry }, { callMs = CALL_MS, stepMs = STEP_MS, askMs = ASK_MS, loadMs = LOAD_MS, name = entry } = {}) {
  const ctrl = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./core-host.js', import.meta.url), {
    execArgv: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning'], env: {},
    workerData: { files: [...files], entry, name, port: port2, ctrl: ctrl.buffer }, transferList: [port2],
  });
  worker.unref(); port1.unref();
  worker.on('error', () => { /* said by the deadline or the answer */ });
  let ended = null;
  const end = (why) => { ended = why; worker.terminate().catch(() => {}); };
  /** Wait for the core thread's next answer, or end it at the deadline. */
  const wait = (ms, what) => {
    const r = Atomics.wait(ctrl, 0, 0, ms);
    if (r === 'timed-out') {
      end(`the core did not stop within ${ms} ms (${what}): its thread was ended, and it is not run again`);
      throw new Error(ended);
    }
    Atomics.store(ctrl, 0, 0);
    const got = receiveMessageOnPort(port1);
    if (!got) { end('the core thread answered nothing'); throw new Error(ended); }
    return got.message;
  };
  const loaded = wait(loadMs, 'loading');
  if (!loaded.ok) { end(loaded.why); throw new Error(loaded.why); }

  const call = (op, input = {}) => {
    if (ended) throw new Error(ended);
    port1.postMessage({ op: String(op), json: plain(input) });
    const ms = { callMs, stepMs, askMs }[DEADLINE[op] || 'askMs'];
    const a = wait(ms, op);
    if (!a.ok) throw new Error(a.why);
    return revive(a.json);
  };
  const meta = call('meta');
  return Object.freeze({ call, meta, end: () => end('ended by the node') });
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
    catch (e) { s = { refused: e.message }; }
    cache.set(key, s);
  }
  if (s.refused) throw new Error(s.refused);
  return s;
}
