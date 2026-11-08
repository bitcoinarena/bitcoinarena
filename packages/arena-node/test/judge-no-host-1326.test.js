// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1326 (§5A.3B RULED 2026-11-07, #1303): "A holder judges a proof whether or not it hosts the game: it fetches the core by the proof's
// sim_wasm_hash and replays in its sandbox". A seat that hosts no game takes the package from a seat that lists it, checks it as an install
// is checked, and keeps it apart: the game is never hosted there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';

test('#1326 a seat that hosts no game fetches it to judge with, checked, and does not host it', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const A = `http://127.0.0.1:${a.port}`;
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-1326-'));
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, peers: [A] });
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const gameId = gameIdOf(ROCK_PAPER_SCISSORS.manifest);
    const games = await b.judge.gameOf({ gameId });
    const entry = games && games.get(toHex(gameId));
    const hostedAtB = (await (await fetch(`${B}/games`)).json()).games.length;
    const got = { fetched: !!entry, coreHashes: entry ? entry.manifest.cores.map((c) => toHex(c.hash).slice(0, 16)) : [], hostedAtB, judgeHeld: b.judge.held().length,
      keptApart: existsSync(join(`${dir}-judge`, toHex(gameId))), notInPlugins: !existsSync(join(dir, toHex(gameId))) };
    console.log('  MEASURED #1326 no-host fetch:', JSON.stringify(got));
    assert.equal(got.fetched, true);
    assert.deepEqual(got.coreHashes, ROCK_PAPER_SCISSORS.manifest.cores.map((c) => toHex(c.hash).slice(0, 16)));
    assert.equal(hostedAtB, 0, 'the judged game is hosted');
    assert.equal(got.judgeHeld, 1);
    assert.equal(got.keptApart && got.notInPlugins, true);
    // a game no seat lists: nothing to judge with, asked again next time
    assert.equal(await b.judge.gameOf({ gameId: new Uint8Array(32).fill(0xee) }), null);
  } finally { await new Promise((r) => b.http.close(r)); await new Promise((r) => a.http.close(r)); }
});
