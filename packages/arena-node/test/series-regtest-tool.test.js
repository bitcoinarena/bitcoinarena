// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE REFUSES WHAT A SERIES DOES NOT DERIVE, AS A PROCESS: tools/series-regtest.mjs run as it is run (kanban #148 hole A,
// plan comment 238, Go 2026-10-05). No chain (CHAIN=0), a temp dir, its two `node src/main.js` seats on 23421/23431. Every
// line it prints is checked: both seats start with the series; the genuine round is stored at both; a moved window,
// index 960 and a round of a series not held are refused at /round; the handout and the entry are taken while the series
// is held; with seat 1 started again on the same store without the series, an entry, a stake lock and a settlement commit
// for the round it took are refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL = new URL('../tools/series-regtest.mjs', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;

test('series-regtest.mjs: the genuine round at both seats, every round and door that is not the series refused by name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'series-regtest-'));
  const r = await new Promise((done) => execFile(process.execPath, [TOOL], { cwd: CWD, timeout: 110000,
    env: { ...process.env, CHAIN: '0', RT: dir, SERIES_DIR: dir } }, (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr })));
  assert.equal(r.code, 0, r.stderr.slice(-600));
  const lines = Object.fromEntries(r.stdout.trim().split('\n').map((l) => JSON.parse(l)).map((o) => [o.step, o]));
  assert.deepEqual(lines['two processes'].ports, [23421, 23431], 'below the ephemeral range');

  const door = lines['round door'];
  assert.deepEqual(door.genuine.statuses, [201, 201], `the genuine round: ${door.genuine.texts.join(' | ')}`);
  assert.equal(door.genuine.idIsTheHash, true);
  for (const [name, why] of [['movedWindow', /series round refused: round \d+ of series [0-9a-f]+ opens and closes its entry at \d+\.\.\d+, and that contract names/],
    ['index960', /series round refused: round 960 is outside series [0-9a-f]+'s 0 \.\. 959/],
    ['idNotTheHashOfAHeldSeries', /series round refused: that round names series [0-9a-f]+, and this node holds no such series/]]) {
    assert.equal(door[name].status, 409, `${name}: ${door[name].text}`);
    assert.match(door[name].text, why, name);
  }

  assert.equal(lines.handout.status, 201);
  assert.equal(lines['entry while held'].status, 201, lines['entry while held'].text);

  const again = lines['node 1 again, same store, without the series'];
  for (const name of ['entry', 'lock', 'settleCommit']) {
    assert.ok(again[name].status >= 400, `${name}: ${again[name].status} ${again[name].text}`);
    assert.match(again[name].text, /names series [0-9a-f]+.*this node holds no such series/, name);
  }
  assert.ok(lines.stopped, 'the tool stopped its seats');
});
