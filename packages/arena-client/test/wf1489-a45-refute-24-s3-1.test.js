// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a45 refute of #1864 / #2259 / #2342, skeptic 3 (second copy): THE PAGE'S "PLAYERS" CHIP RUNS checkedNames OVER
// ONE SEAT'S /rounds ANSWER WITH NONE OF THE LOBBY'S BOUNDS.
//
// The fix chain bounded the names one seat costs in lobby.js (NAMES_PER_SEAT per seat per round, one entry per round per
// answer, LOBBY_NAME_CHECKS_PER_READ for the whole read, a share per seat). src/arena-ui/index.html window.ARENA_CHIP_LIST
// (kind 'players') is a second copy of the same job: it takes the FIRST of the game's nodes that answers GET
// /rounds?ahead=900000 (Promise.any - the fastest seat, which an attacker seat can be) and for EVERY round in that answer runs
//     ARENACLIENT.checkedNames(r.names || [], String(r.id), verify)
// with no budget, no NAMES_PER_SEAT cut and no per-answer dedup of a repeated round. Each round costs up to NAME_CHECKS_MAX
// (512) BIP-340 checks, synchronously on the main thread, and the number of rounds is the seat's choice.
//
// Safe behaviour: one click on the chip costs at most what one lobby read may (LOBBY_NAME_CHECKS_PER_READ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { checkedNames } from '../src/identity.js';
import { LOBBY_NAME_CHECKS_PER_READ } from '../src/lobby.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const HTML = fs.readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const START = HTML.indexOf("    (function () {\n      const pop = document.getElementById('arena-pop');");
const END = HTML.indexOf('    })();', START);
const CHIP_SRC = HTML.slice(START, END + '    })();'.length);

const GAME = 'ab'.repeat(32);
const NOW = Date.now();
const idOf = (i) => (i.toString(16).padStart(8, '0')).repeat(8);
const forged = (roundHex, j) => {
  const pk = new Uint8Array(32); pk[0] = 2; pk[1] = j & 0xff; pk[2] = (j >> 8) & 0xff;
  const rid = Uint8Array.from(Buffer.from(roundHex, 'hex'));
  return { record: toHex(encodeLobbyName({ roundId: rid, playerPubkey: pk, identityPubkey: pk, name: 'x', atMs: 1000n })), sig: '00'.repeat(64) };
};
const round = (id, names) => ({ id, game: { id: GAME }, startTime: new Date(NOW - 1000).toISOString(), endTime: new Date(NOW + 600000).toISOString(), joined: 1, names });

function runChip(rounds) {
  let checks = 0;
  const el = () => ({ querySelector: () => el(), addEventListener() {}, classList: { add() {}, remove() {}, contains: () => false } });
  const window = {
    ARENA_CURVE: { verify: () => { checks++; return false; } },
    ArenaChips: { draw() {} }, ArenaText: { say() {} },
  };
  const ctx = vm.createContext({
    window, document: { getElementById: () => el(), addEventListener() {} },
    ARENACLIENT: { checkedNames },
    fetch: async () => ({ ok: true, json: async () => ({ nowMs: NOW, rounds }) }),
    AbortSignal, URL, Promise, Date, Math, Number, String, BigInt, Map, Set, Array, Object,
  });
  vm.runInContext(CHIP_SRC, ctx);
  return window.ARENA_CHIP_LIST({ nodes: ['https://evil.example/seat'], id: GAME, name: 'g' }, 'players').then(() => checks);
}

test('wf1489-a45-refute-24-s3-1a: one seat\'s many made-up rounds cost the players chip no more than one lobby read', async () => {
  assert.ok(START > 0 && END > START, 'the chip code is found in index.html');
  const rounds = [];
  for (let i = 1; i <= 40; i++) { const id = idOf(i); rounds.push(round(id, Array.from({ length: 200 }, (_, j) => forged(id, j)))); }
  const checks = await runChip(rounds);
  console.log(`  FACTS: one seat's /rounds answer, 40 rounds x 200 forged names -> ${checks} BIP-340 checks on one chip click (lobby read cap ${LOBBY_NAME_CHECKS_PER_READ})`);
  assert.ok(checks <= LOBBY_NAME_CHECKS_PER_READ, `players chip ran ${checks} checks`);
});

test('wf1489-a45-refute-24-s3-1b: one seat repeating one round in its answer costs the chip one listing\'s names', async () => {
  const id = idOf(7);
  const names = Array.from({ length: 512 }, (_, j) => forged(id, j));
  const rounds = Array.from({ length: 20 }, () => round(id, names));
  const checks = await runChip(rounds);
  console.log(`  FACTS: one round repeated 20 times with 512 forged names -> ${checks} BIP-340 checks (NAMES_PER_SEAT 128)`);
  assert.ok(checks <= 128, `players chip ran ${checks} checks for one seat's one round`);
});
