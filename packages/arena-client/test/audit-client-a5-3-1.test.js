// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit client r3 finding 1: a reload of a held join (round=..&play=1 in the address) goes through heldRoundLink, which takes the round's start
// time from the FIRST of the link's first three seats that lists the round in GET /rounds?next=12 - an unsigned field of one seat's listing - and
// holds the join (and Unity's run) until then: ARENA_LOBBY_ACT.join(id, { holdUntilMs: startMs, ... }). The lobby's own row carries the start of the
// round's hash-bound contract. SAFE: the hold is the contract's start (the lobby row's), never one seat's word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const SRC = slice('    async function heldRoundLink() {', '      return true;\n    }\n');

const NOW = 1_800_000_000_000;
const ID = 'ab'.repeat(32);
const TRUE_START = NOW + 60_000;              // the round's contract start: one minute ahead
const LIE = TRUE_START + 24 * 3600_000;       // seat A's listing: a day later

test('a reloaded round link is held to the round contract\'s start, not to one seat\'s listed startTimeMs', async () => {
  const joined = [];
  const win = {
    ARENA_LOBBY_ROWS: [{ id: ID, joinable: true, startTimeMs: TRUE_START, entryCloseMs: TRUE_START + 30_000 }],   // lobby.js: from the contract
    ARENA_LOBBY_ACT: { join: (id, o) => { joined.push({ id, ...o }); return true; } },
  };
  const location = { search: `?node=https://a.example/s1,https://b.example/s2,https://c.example/s3&round=${ID}&play=1`, pathname: '/' };
  const history = { replaceState: () => {} };
  const ARENACLIENT = { lobbyQuery: () => ({ nodes: ['https://a.example/s1', 'https://b.example/s2', 'https://c.example/s3'] }) };
  const fetch = async (u) => {
    const lies = String(u).startsWith('https://a.example');
    return { ok: true, json: async () => ({ rounds: [{ id: ID, startTimeMs: lies ? LIE : TRUE_START, committeeTimeMs: NOW - 1000 }] }) };
  };
  const DateS = class extends Date { static now() { return NOW; } };
  const run = new Function('window', 'location', 'history', 'ARENACLIENT', 'fetch', 'Date', 'URLSearchParams', 'AbortSignal', 'console',
    'showTheLobbyIfOneWasNamed', 'gameOnly', 'setTimeout',
    SRC + '\nreturn heldRoundLink();');
  const held = await run(win, location, history, ARENACLIENT, fetch, DateS, URLSearchParams, { timeout: () => undefined }, { log() {}, warn() {}, error() {} },
    async () => true, () => '', (f) => f());
  assert.equal(held, true, 'the link is held');
  assert.equal(joined.length, 1, 'the round is joined from the lobby');
  assert.equal(joined[0].holdUntilMs, TRUE_START,
    `the join is held until ${new Date(joined[0].holdUntilMs).toISOString()}, seat A's word, and the round's contract starts at ${new Date(TRUE_START).toISOString()}`);
});
