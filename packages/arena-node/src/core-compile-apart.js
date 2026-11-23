// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3389: A CORE IS COMPILED IN A PROCESS OF ITS OWN FIRST, so a heap overrun while V8 compiles it ends that process, not the seat.
//
// V8 cannot stop partway through generating bytecode: a heap overrun inside CompileModule goes to FatalProcessOutOfMemory and node's
// handler calls abort() on the WHOLE process - the core thread's resourceLimits end JavaScript, not a compile (#3067, #3386; ending the
// worker after the compile has begun does not help). core-depth.js bounds the input (bytes, functions) as the cheap first check, but
// those bounds are measured guesses. Here every file loadCore is about to hand a core thread - instrumented, exactly the text the thread
// compiles - is compiled first in a child node process whose old generation is SMALLER than the core thread's (APART_MARGIN): a core
// whose compile fits the child fits the thread, and one that does not kills only the child, and is refused by name.
//
// The child gets source text on stdin and nothing else (no env, no argument from the core); it compiles, never links or evaluates.
// A verdict is kept per (files, heap), so a core is compiled apart once per process, not at each thread loadCore starts. A child that
// cannot be started at all is not the core's fault: the load goes on as before (said once in the log).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./core-compile-child.js', import.meta.url));
/** The child's old generation is this many MB below the core thread's (a quarter of it, at most 16): the thread also holds its
 *  lockdown and the driver, the child only the compile. */
export const apartMb = (threadMb) => Math.max(4, Math.round(threadMb - Math.min(16, threadMb / 4)));
const VERDICTS_MAX = 256;
const verdicts = new Map();
let saidNoChild = false;

/** Compiles `files` (Map rel -> text) in a child with the heap `heap` names (HEAP_LIMITS' shape) less APART margin, within `ms`.
 *  Answers { ok: true } or { ok: false, why }; `ok: true, unchecked: true` when no child could be started. */
export function compileApart(files, heap, ms) {
  const mb = apartMb(Number(heap && heap.maxOldGenerationSizeMb) || 128);
  const h = createHash('sha256').update(String(mb));
  for (const [rel, text] of files) h.update('\0').update(rel).update('\0').update(text);
  const key = h.digest('hex');
  if (verdicts.has(key)) return verdicts.get(key);
  const input = JSON.stringify([...files]);
  const r = spawnSync(process.execPath, [`--max-old-space-size=${mb}`, '--experimental-vm-modules', '--no-warnings', CHILD],
    { input, env: {}, encoding: 'utf8', timeout: Math.max(1, ms), maxBuffer: 1 << 16, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let verdict;
  const out = String(r.stdout || '');
  // NOT STARTED AT ALL (no status, no signal): not the core's fault. A child that died while it was still reading the core gives
  // EPIPE here too, with its signal - that is a death, judged below.
  if (r.error && r.error.code !== 'ETIMEDOUT' && r.status === null && r.signal === null) {
    if (!saidNoChild) { saidNoChild = true; console.log(`[sandbox] a core could not be compiled apart (${r.error.code || r.error.message}): loaded without it`); }
    return { ok: true, unchecked: true };
  }
  if (/^COMPILED$/m.test(out)) verdict = { ok: true };
  else if (r.error && r.error.code === 'ETIMEDOUT') verdict = { ok: false, why: `the core did not compile within ${ms} ms in a process of its own` };
  else if (r.signal || r.status !== 0 || /heap out of memory|Reached heap limit/i.test(String(r.stderr || ''))) {
    verdict = { ok: false, why: `the core runs out of heap while it compiles (${mb} MB, in a process of its own: ${r.signal || `exit ${r.status}`})` };
  } else verdict = { ok: true };   // a compile error of the core's own: the core thread names it as before
  if (verdicts.size >= VERDICTS_MAX) verdicts.clear();
  if (!(r.error && r.error.code === 'ETIMEDOUT')) verdicts.set(key, verdict);   // a timeout may be the machine's load: asked again
  return verdict;
}
