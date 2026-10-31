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
const D = M.DECIDE || null;
const states = new Map();
let nextId = 1;

/** A value out: bigints and byte arrays tagged, so the node reads back what the core said and not a lossy copy. */
const out = (v) => JSON.stringify(v === undefined ? null : v, (k, x) => {
  if (typeof x === 'bigint') return { $big: x.toString() };
  if (x instanceof Uint8Array) { let s = ''; for (const b of x) s += b.toString(16).padStart(2, '0'); return { $u8: s }; }
  return x;
});

function meta() {
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

/** THE ONE DOOR IN: an operation's name and its JSON; the answer as JSON. */
export function call(op, json) {
  const f = OPS[op];
  if (!f) throw new Error(`no operation ${op}`);
  return out(f(JSON.parse(json)));
}
