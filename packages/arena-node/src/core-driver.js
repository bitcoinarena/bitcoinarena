// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DRIVER INSIDE THE SANDBOX (spec §0A.6). This file is never imported by the node: core-sandbox.js reads
// its text and evaluates it INSIDE a core's sandbox, as the one module that imports the core ('arena:core'). It is the loop
// replay.js and the warm ghost ran on the core's adapter before, moved to where the core is: the node hands it a JSON
// string and reads a JSON string back, so no object of the node's is ever within the core's reach, and the core's own
// objects (its state, its arrays) never leave the sandbox.
//
// It imports nothing else and names no global the sandbox lacks: JSON, Map and arrays are the language's own.
import * as M from 'arena:core';

const A = M.CORE || null;
// A DECIDE ADAPTER IS READ ONCE, AT LOAD, ON EVERY THREAD ALIKE (kanban #2730, #1489 r5-hosting-1): meta read D.name on the trial's kept
// thread before its decides, and the seat runs each decide on a fresh thread with no meta first - an adapter whose `name` getter set a flag its
// decide read answered good verdicts in the trial and nothing at the seat. Now its name and its decide function are taken here, when the
// module loads, on whichever thread that is - a getter (or a Proxy's trap) runs at the same point on the trial's thread and the seat's - and
// meta and decide only read what was taken. One that cannot be read is no adapter.
const D0 = M.DECIDE || null;
let D = null;
try {
  if (D0 && (typeof D0 === 'object' || typeof D0 === 'function')) {
    const name = D0.name, fn = D0.decide;
    D = { name: typeof name === 'string' ? name : name == null ? null : String(name), decide: typeof fn === 'function' ? (moves, config) => fn.call(D0, moves, config) : null };
  }
} catch { D = null; }
const states = new Map();
let nextId = 1;

/** A value out: bigints and byte arrays tagged, so the node reads back what the core said and not a lossy copy. */
const out = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => {
  if (typeof x === 'bigint') return { $big: x.toString() };
  if (x instanceof Uint8Array) { let s = ''; for (const b of x) s += b.toString(16).padStart(2, '0'); return { $u8: s }; }
  return x;
});

// THE CORE'S FIELDS TOO (kanban #2808, #1489 r21-hosting-1; #2730 did not hold): meta read CORE's fields (name, RUN_TICKS, ...) only when meta
// was asked - on the trial's kept thread before any decide, never on the seat's fresh decide thread - so a CORE `name` getter still told the
// two apart. Everything meta answers is now read here, at load, on every thread alike; meta only hands back what was read (a read that threw
// throws again from meta, as before).
let META = null, META_ERROR = null;
try { META = readMeta(); } catch (e) { META_ERROR = e; }
function meta() {
  if (META_ERROR) throw META_ERROR;
  return { ...META };
}
function readMeta() {
  return {
    core: !!A, decide: !!(D && typeof D.decide === 'function'),
    name: A ? A.name : D ? D.name : null,
    RUN_TICKS: A && Number.isInteger(A.RUN_TICKS) ? A.RUN_TICKS : null,
    INPUT_WORDS: A && Number.isInteger(A.INPUT_WORDS) ? A.INPUT_WORDS : null,
    runTicks: !!(A && typeof A.runTicks === 'function'),
    runTicksFits: !!(A && typeof A.runTicksFits === 'function'),
    picture: !!(A && typeof A.picture === 'function'),
    start: !!(A && typeof A.start === 'function'),
  };
}

/** A RUN'S START OPTIONS: its length, the unlocks of the items its entry plays with only when it names some, and its place in a
 * shared world only when it has one (kanban #828) - so a core that sells nothing is started exactly as before, and a core older
 * than the slot never reads it. */
const startOptions = (runTicks, items, slot) => ({ runTicks, ...(Array.isArray(items) && items.length ? { items } : {}), ...(Number.isInteger(slot) ? { slot } : {}) });

/** REPLAY ONE RUN: the loop replay.js describes, here and nowhere else. The node checked the transcript before. */
function replay({ seedWord, config, runTicks, items, slot, start, words, events: ev, marks, pictures }) {
  const want = new Map(marks);
  const wanted = new Set(pictures);
  const taken = [];
  const events = A.eventsOf(ev);
  const st = A.start(seedWord, config, startOptions(runTicks, items, slot));
  let checked = 0;
  let divergedAt = null;
  const atStart = want.get(start);
  if (atStart !== undefined) { checked++; if (A.stateHash(st) !== atStart) divergedAt = start; }
  for (let i = 0; i < words.length; i++) {
    const tick = start + i;
    events.before(st, tick);
    A.step(st, words[i]);
    if (wanted.has(tick) && typeof A.picture === 'function') taken.push({ tick, ...A.picture(st) });
    const at = want.get(tick + 1);
    if (at !== undefined) {
      checked++;
      if (A.stateHash(st) !== at && divergedAt === null) divergedAt = tick + 1;
    }
  }
  const ran = A.result(st);
  return { outcome: ran.outcome, score: ran.score, heat: ran.heat, stateHash: A.stateHash(st), taken, count: events.count, checked, divergedAt };
}

/** THE WARM GHOST: a run kept here and stepped forward a slice at a time; the node holds only its number. */
function open({ seedWord, config, runTicks, items, slot }) {
  const id = nextId++;
  states.set(id, A.start(seedWord, config, startOptions(runTicks, items, slot)));
  return id;
}
function pose(id) {
  const st = states.get(id);
  return st && typeof A.picture === 'function' ? A.picture(st) : {};
}
function stepTo({ id, events: ev, from, words }) {
  const st = states.get(id);
  if (!st) throw new Error('no such run in this sandbox');
  const events = A.eventsOf(ev);
  for (let i = 0; i < words.length; i++) {
    events.before(st, from + i);
    A.step(st, words[i]);
  }
  return pose(id);
}

const OPS = {
  meta: () => meta(),
  runTicks: ({ config }) => A.runTicks(config),
  runTicksFits: ({ ticks }) => !!A.runTicksFits(ticks),
  replay,
  open,
  pose: ({ id }) => pose(id),
  stepTo,
  drop: ({ id }) => states.delete(id),
  decide: ({ moves, config }) => D.decide(moves, config),
};

/** kanban #3558: read by core-host.js right after the load - a binding the driver's body reaches only when the core's top level finished
 *  (one awaiting a promise that never settles left the module 'evaluated' and the driver's body never run) */
export const LOADED = true;

/** THE ONE DOOR IN: an operation's name and its JSON; the answer as JSON. */
export function call(op, json) {
  const f = OPS[op];
  if (!f) throw new Error(`no operation ${op}`);
  return out(f(JSON.parse(json)));
}
