// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3778 (feedback #505): "Order submitted in 1.54 s · placing …" stayed on screen into the next window after the order was
// refused ("the stake lock was not accepted"): src/arena-ui/index.html set that note with no hide timer and the refused path returned
// without touching it. Every exit after the submitted note must end it (the refusal shown, then hidden).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf('        let early = null;');
const TAIL = "window.ARENA_JOIN_REFUSED = 'the seats refused the pick: ' + sent.why; return;\n        }";
const END = HTML.indexOf(TAIL, START);
const SRC = HTML.slice(START, END + TAIL.length);

async function run(submitPick, handout) {
  const el = { id: 'arena-order-took', style: {}, textContent: '', setAttribute() {} };
  let made = false;
  const timers = [];
  const window = { ARENA_HANDOUT_DONE: handout, sessionStorage: { setItem() {} } };
  const ctx = vm.createContext({
    window, console: { log() {}, warn() {} }, performance: { now: () => 1000 },
    document: { getElementById: () => (made ? el : null), createElement: () => { made = true; return el; }, body: { appendChild() {} } },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
    ARENACLIENT: { submitPick, toHex: (x) => x, entryId: () => 'e' },
    named: { roundIdHex: 'ab'.repeat(32), nodes: [] }, chosen: { pick: 1 }, entry: {}, stakeLock: {}, t0: 0,
    placedIds: new Set(), rememberPick() {}, recordOf: () => ({}), readPicks: () => [],
  });
  vm.runInContext('globalThis.go = async () => {\n' + SRC + '\n};', ctx);
  let threw = null;
  try { await ctx.go(); } catch (e) { threw = e; }
  for (const t of timers.filter((t) => t.ms === 6000)) t.f();   // the note's hide timers run
  return { el, threw };
}

const submitted = (ok, why) => async ({ onSubmitted }) => { onSubmitted({ entryId: 'e1' }); return { ok, why, entryId: 'e1', entries: [{ status: ok ? 201 : 409 }] }; };

test('#3778 a refused order does not leave "submitted · placing …" on screen', async () => {
  assert.ok(START > 0 && END > START, 'the order code is found in index.html');
  const { el } = await run(submitted(false, 'the stake lock was not accepted'), Promise.resolve({ ok: true }));
  assert.equal(el.style.display, 'none', 'the note is hidden: ' + el.textContent);
});

test('#3778 an order the handout then refuses does not leave the note either', async () => {
  const { el } = await run(submitted(true), Promise.resolve({ ok: false, why: 'stake not held' }));
  assert.equal(el.style.display, 'none', 'the note is hidden: ' + el.textContent);
});

test('#3778 a submit that throws after the submitted note hides it', async () => {
  const { el, threw } = await run(async ({ onSubmitted }) => { onSubmitted({ entryId: 'e1' }); throw new Error('boom'); }, Promise.resolve({ ok: true }));
  assert.ok(threw);
  assert.equal(el.style.display, 'none', 'the note is hidden: ' + el.textContent);
});
