// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY STEP OF AN ORDER, WITH ITS TIME, IN THE SEAT'S LOG (kanban #618, 2026-10-24: "Bei der Node musst du jeden logischen Step mit
// Timestamps dokumentieren im Log damit wir Delays in zukunft besser analysieren können - bei jeder Order (bzw Lock)"). One line per
// request, written when its answer leaves - every return path, refusals too:
//
//   [steps] lock 3dd014ad8c1e2f40 at 2026-10-24T14:59:01.123Z: body +0, entry +1, port +2, status +412, contract +413 -> 201 in 415 ms
//
// `at` the request's arrival (UTC), each step's offset from it in ms, then the answer's status and the whole time.
// `keep` (kanban #624): handed the same line as data - { kind, id, t0, steps, status, ms } - so the seat keeps it per transaction (tx-record.js)
export function stepLog(kind, id, { log = console.log, now = () => Date.now(), keep = null } = {}) {
  const t0 = now();
  const steps = [];
  let name = String(id);
  let said = false;
  const s = {
    /** The request's id once it is known (an entry's, after its body is read). */
    named(x) { name = String(x); return s; },
    /** A step reached: its name and its offset now. */
    at(name) { steps.push([name, now() - t0]); return s; },
    /** Steps measured elsewhere ({ name: ms } as verifyStakeLock's `timing`), added by name. */
    took(timing) { for (const [k, v] of Object.entries(timing || {})) steps.push([`${k}`, `${v}ms`]); return s; },
    /** The line, once: `status` the answer's. */
    done(status, why = '') {
      if (said) return; said = true;
      const ms = now() - t0;
      log(`[steps] ${kind} ${name.slice(0, 16)} at ${new Date(t0).toISOString()}: ${steps.map(([k, v]) => `${k} ${typeof v === 'number' ? '+' + v : v}`).join(', ') || '-'}`
        + ` -> ${status} in ${ms} ms${why ? ` (${String(why).slice(0, 80)})` : ''}`);
      if (typeof keep === 'function') keep({ kind, id: name, t0, steps: steps.map(([k, v]) => ({ step: k, ms: v })), status, ms });
    },
    /** Said when this response is sent, whatever path sent it. */
    on(res) { if (res && typeof res.once === 'function') res.once('finish', () => s.done(res.statusCode)); return s; },
  };
  return s;
}
