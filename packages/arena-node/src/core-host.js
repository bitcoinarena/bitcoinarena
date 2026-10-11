// THE THREAD A CORE RUNS IN (spec §0A.6, kanban #328). Started only by core-sandbox.js, one per core, with the core's files
// already read and checked by the node: it builds the sandbox - an empty vm context, code generation off, the clocks, the
// randomness and the generated code taken out of its own realm, its modules linked to its own files only - and answers
// the node's calls, a JSON string in and a JSON string out. It has no timeout of its own: the node waits for each answer
// against a deadline and ends this whole thread when one is missed. A core that does not stop is ended with its thread,
// never interrupted inside the node's (a vm timeout in a busy node thread was measured aborting the process).
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { workerData } from 'node:worker_threads';

const { files: fileList, entry, name, port, ctrl: ctrlBuffer } = workerData;
const files = new Map(fileList);
const ctrl = new Int32Array(ctrlBuffer);
const DRIVER = readFileSync(new URL('./core-driver.js', import.meta.url), 'utf8');
const REMOVED = ['Date', 'Intl', 'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'Function', 'WeakRef', 'FinalizationRegistry', 'console'];
// run in the context before any core code: what the core must not have is taken out of its own realm
const LOCKDOWN = `'use strict';
for (const k of ${JSON.stringify(REMOVED)}) delete globalThis[k];
delete Math.random;
Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
void 0;`;

/** Answer the node: the message first, then the flag it waits on. */
function answer(m) {
  port.postMessage(m);
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}
const said = (e) => (e && typeof e.message === 'string' ? e.message : String(e));

function load() {
  if (typeof vm.SourceTextModule !== 'function') throw new Error('the core thread was started without --experimental-vm-modules');
  // DONT_CONTEXTIFY: the context's global is its own ordinary object, not one of this thread's behind interceptors -
  // nothing of the node stands behind it, and a core's global reads run at full speed (measured 4x slower behind them)
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    name: `core ${name}`, codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  new vm.Script(LOCKDOWN, { filename: 'arena:lockdown' }).runInContext(context);
  const modules = new Map();
  const moduleOf = (rel) => {
    if (!modules.has(rel)) modules.set(rel, new vm.SourceTextModule(files.get(rel), { context, identifier: `core:/${rel}` }));
    return modules.get(rel);
  };
  // THE GATE: a relative path inside the hashed files, and nothing else
  const resolve = (specifier, fromRel) => {
    if (!/^\.\.?\//.test(specifier)) throw new Error(`the core imports "${specifier}", and a core may import only its own files`);
    const rel = posix.normalize(posix.join(posix.dirname(fromRel), specifier));
    if (rel.startsWith('../') || !files.has(rel)) throw new Error(`the core imports "${specifier}", which is not one of its hashed files`);
    return rel;
  };
  const linked = new Set();
  const link = (rel) => {
    if (linked.has(rel)) return;
    linked.add(rel);
    const m = moduleOf(rel);
    const deps = m.moduleRequests.map((r) => resolve(r.specifier, rel));
    m.linkRequests(deps.map(moduleOf));
    for (const d of deps) link(d);
  };
  link(entry);
  const driver = new vm.SourceTextModule(DRIVER, { context, identifier: 'arena:driver' });
  for (const r of driver.moduleRequests) if (r.specifier !== 'arena:core') throw new Error('the driver imports only the core');
  driver.linkRequests([moduleOf(entry)]);
  driver.instantiate();
  const evaluated = driver.evaluate();
  if (evaluated && typeof evaluated.catch === 'function') evaluated.catch(() => { /* said below, by status */ });
  if (driver.status === 'errored') throw new Error(`the core failed while loading: ${said(driver.error)}`);
  if (driver.status !== 'evaluated') throw new Error('the core did not finish loading (a core may not wait on anything)');
  // EVERY CALL IS A SCRIPT RUN IN THE CONTEXT, so its microtasks run after it, inside the node's deadline (microtaskMode
  // afterEvaluate) - the driver's door and the two strings it is handed sit on the context's own global
  Object.defineProperty(context, '__arenaCall', { value: driver.namespace.call, writable: false, configurable: false, enumerable: false });
  const script = new vm.Script('__arenaCall(__arenaOp, __arenaIn)', { filename: 'arena:call' });
  return (op, json) => { context.__arenaOp = op; context.__arenaIn = json; return script.runInContext(context); };
}

let call = null;
try { call = load(); answer({ ok: true }); } catch (e) { answer({ ok: false, why: said(e) }); }

port.on('message', ({ op, json }) => {
  if (!call) return answer({ ok: false, why: 'the core did not load' });
  let out;
  try { out = call(String(op), String(json)); } catch (e) { return answer({ ok: false, why: `the core failed in ${op}: ${said(e)}` }); }
  if (typeof out !== 'string') return answer({ ok: false, why: `the core answered ${op} with something other than JSON` });
  answer({ ok: true, json: out });
});
