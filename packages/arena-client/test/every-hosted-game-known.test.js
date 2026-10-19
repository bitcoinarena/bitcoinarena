// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY GAME A SEAT CAN HOST IS ONE THE PAGE KNOWS (the live break of 2026-10-16 05:19Z): once the seats
// listed nextblock v3's rounds the page found v3 (b8b88e23) nowhere in KNOWN_GOOD_GAMES and showed "Tick Tock, Next Block cannot be
// loaded". Every module under the seats' game packages' plugin/ that exports a GAME with a manifest - what a seat's ARENA_GAMES loads - must be
// listed by its game id, under its manifest's name, with every core its manifest names; a new version that is not fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';

const ROOT = new URL('../../', import.meta.url);
// THE PACKAGES THE SEATS' ARENA_GAMES LOAD (hello-world is the developer sample, hosted by no seat)
const HOSTED_PACKAGES = ['nextblock', 'rock-paper-scissors', 'btc-updown'];

test('every hosted game version is known to the page, by id, name and cores', async () => {
  const seen = [];
  for (const pkg of readdirSync(ROOT).filter((p) => HOSTED_PACKAGES.includes(p))) {
    const dir = new URL(`${pkg}/plugin/`, ROOT);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      let mod; try { mod = await import(new URL(f, dir).href); } catch { continue; }
      const g = mod.GAME;
      if (!g || !g.manifest) continue;
      const id = toHex(gameIdOf(g.manifest));
      seen.push(`${pkg}/${f} ${id.slice(0, 8)}`);
      const k = KNOWN_GOOD_GAMES[id];
      assert.ok(k, `${pkg}/plugin/${f}: game ${id} (${g.manifest.gameName} v${g.manifest.version}) is not in KNOWN_GOOD_GAMES - a page shown its rounds cannot load it`);
      assert.equal(k.name, g.manifest.gameName, `${pkg}/plugin/${f}: listed under another name`);
      for (const c of g.manifest.cores || []) assert.ok(k.cores[toHex(c.hash)], `${pkg}/plugin/${f}: core ${toHex(c.hash).slice(0, 8)} not listed`);
    }
  }
  assert.ok(seen.length >= 3, `found ${seen.length} hosted games`);
  console.log('  FACTS:', seen.join(', '));
});
