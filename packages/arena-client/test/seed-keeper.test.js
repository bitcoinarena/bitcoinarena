// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PHRASE IS KEPT IN THE BROWSER (2026-10-01: "safe even if the user closes the browser and loads it again"):
// the page's own arenaSeedKeeper, run on fake storages and a fake clock - a browser opened again gets its phrase back,
// a second open tab is still a second player, a reload keeps its own, an imported phrase is kept too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tabSeed, importSeed } from '../src/join.js';
import { pageFunction } from './page-script.js';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const from = html.indexOf('function arenaSeedKeeper(');
const to = html.indexOf('\n    try {\n      window.ARENA_SEED_KEEPER', from);
const Keeper = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), [], html.slice(from, to), '; return arenaSeedKeeper;')();

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m }; };
let clock = 1_000_000;
const rnd = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (clock * 7 + i * 13 + n) & 255; clock += 1; return b; };
let tabs = 0;
function openTab(L, T = store()) {
  const handlers = {}; const beats = [];
  const k = Keeper({ L, T, now: () => clock, every: (fn) => beats.push(fn), on: (n, fn) => { handlers[n] = fn; }, random: () => `tab${++tabs}` });
  const seed = Buffer.from(tabSeed({ storage: T, random: rnd })).toString('hex');   // what the page then reads (or mints)
  k.beat();
  return { T, seed, tick: () => beats.forEach((f) => f()), close: () => handlers.pagehide && handlers.pagehide(), k };
}

test('a browser closed and opened again gets the same phrase back', () => {
  const L = store();
  const a = openTab(L);
  a.close();                                   // the browser is closed: the tab's session storage is gone
  clock += 60_000;
  const b = openTab(L);                        // a fresh tab, no session storage
  assert.equal(b.seed, a.seed, 'the phrase was lost when the browser closed');
});

test('even with no clean close (a crash), the phrase comes back once its heartbeat is old', () => {
  const L = store();
  const a = openTab(L);
  clock += 13_000;
  assert.equal(openTab(L).seed, a.seed);
});

test('two open tabs stay two players: a second tab does not take a phrase another live tab holds', () => {
  const L = store();
  const a = openTab(L);
  clock += 2_000; a.tick();
  const b = openTab(L);
  assert.notEqual(b.seed, a.seed);
  assert.equal(JSON.parse(L.getItem('arena.seeds')).length, 2, 'both phrases are kept');
});

test('a reload keeps the tab\'s own phrase; an imported phrase is kept, and so is the one it replaced', () => {
  const L = store();
  const a = openTab(L);
  assert.equal(openTab(L, a.T).seed, a.seed, 'a reload changed the phrase');
  const mine = 'ab'.repeat(32);
  importSeed(mine, { storage: a.T }); a.k.beat();
  const kept = JSON.parse(L.getItem('arena.seeds'));
  assert.ok(kept.some((x) => x.hex === mine && x.from === 'imported'));
  assert.ok(kept.some((x) => x.hex === a.seed));
  a.close(); clock += 60_000;
  const c = openTab(L);
  assert.ok([mine, a.seed].includes(c.seed), 'an opened-again browser got neither kept phrase');
});

// ONE TAB PER PHRASE (2026-10-01): a duplicated tab - its session storage copied, phrase and tab id - finds the
// phrase's lock held by the first tab, drops the phrase and starts again as its own player.
test('a duplicated tab does not run the same wallet: it finds the phrase locked, drops it and reloads as another player', async () => {
  const held = new Set();
  // the browser answers a lock request later, as this does
  const locks = { request: (name, opts, cb) => { queueMicrotask(() => { if (held.has(name)) { cb(null); return; } held.add(name); cb({ name }); }); } };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const L = store();
  const open = (T) => {
    let reloaded = false;
    const k = Keeper({ L, T, now: () => clock, every: () => {}, on: () => {}, random: () => `tab${++tabs}`, locks, reload: () => { reloaded = true; } });
    const seed = Buffer.from(tabSeed({ storage: T, random: rnd })).toString('hex');
    k.beat();
    return { seed, reloaded: () => reloaded };
  };
  const tA = store(); const a = open(tA); await settle();
  assert.equal(a.reloaded(), false, 'the first tab holds its phrase');
  // DUPLICATE: the browser copies the first tab's session storage, phrase and tab id
  const tB = store(); for (const [k, v] of tA.map) tB.setItem(k, v);
  const dup = open(tB);
  assert.equal(dup.seed, a.seed, 'precondition: the copy starts on the same phrase');
  await settle();
  assert.equal(dup.reloaded(), true, 'the duplicate ran the same wallet on');
  assert.equal(tB.getItem('arena.player.seed'), null, 'the duplicate kept the phrase');
  assert.notEqual(tB.getItem('arena.tab.id'), tA.getItem('arena.tab.id'), 'the duplicate kept the copied tab id');
  // ITS RELOAD: a phrase no other tab holds - here a new one
  const b = open(tB); await settle();
  assert.notEqual(b.seed, a.seed, 'after the reload the duplicate is still the first tab\'s player');
  assert.equal(b.reloaded(), false);
});

// A NEW TAB THAT FINDS A KEPT PHRASE'S LOCK TAKEN BY ANOTHER TAB'S COLLECT DOES NOT MINT ((b), 2026-10-07):
// measured on 0.0.2842 (comment 695), tab B took the free kept phrase adddd868 while tab A was collecting its record under
// arena.phrase.adddd868..., found the lock taken, dropped the phrase, reloaded and minted a new one (13ea16be). It now waits
// for the collect to let go and keeps the phrase; a phrase a LIVE tab holds is still dropped (two tabs, two players).
function fakeLocks(taken) {
  const asked = [];
  return { asked, request: (name, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } asked.push({ name, wait: !opts.ifAvailable });
    if (taken.has(name) && opts.ifAvailable) return Promise.resolve(cb(null)); return Promise.resolve(cb({ name })); } };
}

test('a kept phrase whose lock a collect holds: the new tab keeps it and waits, no reload, no new phrase', () => {
  const L = store();
  const a = openTab(L); const p = a.seed; a.close(); clock += 60_000;      // a kept phrase, no tab on it
  L.setItem('arena.seed.collecting.' + p.slice(0, 16), JSON.stringify({ at: clock }));   // another tab is collecting its record
  const locks = fakeLocks(new Set(['arena.phrase.' + p.slice(0, 16)]));
  let reloads = 0; const T = store();
  const k = Keeper({ L, T, now: () => clock, every: () => {}, on: () => {}, random: () => `tab${++tabs}`, locks, reload: () => { reloads++; } });
  k.beat();
  assert.equal(T.getItem('arena.player.seed'), p, 'the tab dropped the kept phrase');
  assert.equal(reloads, 0, 'the tab reloaded to take a new phrase');
  assert.equal(JSON.parse(L.getItem('arena.seeds')).length, 1, 'a phrase was minted for a collision');
  assert.ok(locks.asked.some((x) => x.name === 'arena.phrase.' + p.slice(0, 16) && x.wait), 'it waits for the lock');
});

test('a kept phrase a live tab holds (a duplicated tab): still dropped, as before', () => {
  const L = store();
  const a = openTab(L); const p = a.seed;
  const locks = fakeLocks(new Set(['arena.phrase.' + p.slice(0, 16)]));
  let reloads = 0; const T = store(); T.setItem('arena.player.seed', p); T.setItem('arena.tab.id', 'dup');
  const k = Keeper({ L, T, now: () => clock, every: () => {}, on: () => {}, random: () => `tab${++tabs}`, locks, reload: () => { reloads++; } });
  k.beat();
  assert.equal(reloads, 1);
  assert.equal(T.getItem('arena.player.seed'), null);
});
