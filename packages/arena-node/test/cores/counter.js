// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SECOND TITLE ON THE SAME SIGNER NODES - THE ACCEPTANCE FOR M3 R1 (2026-09-15 08:07: "several
// games at once, and several rule sets at once ... two titles and two configs can run on the same
// nodes in the same window").
//
// Deliberately nothing like the truck: a run adds its first input word each tick, for its config's
// number of ticks, and delivers when the sum reaches its config's target. It is here to show the
// signer nodes replay whatever core a round names, under whatever config it names, and that the truck is
// not special to them: the same adapter face (core/src/adapter.js), its own hash, its own configs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { testGame } from '../plugins/sign.js';
import { CORE } from './counter-core.js';

const sha = (s) => createHash('sha256').update(s).digest();

export { CORE };

/** Its sim_wasm_hash: sha256 over its own source, as the truck's is over its sources. */
export const COUNTER_HASH = sha(readFileSync(new URL('./counter-core.js', import.meta.url))).toString('hex');

/** Two rule sets for it - a low bar and a high one - each named by the hash of its own bytes. */
export const CONFIGS = [{ target: 1000, ticks: 120 }, { target: 2000000000, ticks: 120 }]
  .map((c) => ({ config: c, hash: sha(`counter-config:${c.target}:${c.ticks}`) }));

/** The core as its game installs it (a core is installed for a game, never beside one). */
export const COUNTER = Object.freeze({
  name: CORE.name, hash: COUNTER_HASH, url: new URL('./counter-core.js', import.meta.url).href, adapter: CORE,
  configs: new Map(CONFIGS.map(({ config, hash }) => [hash.toString('hex'), config])),
});

/** THE COUNTER AS A GAME OF ITS OWN: its manifest, signed by a test key, and the core above. */
export const COUNTER_GAME = testGame({ name: 'counter', cores: new Map([[COUNTER_HASH, COUNTER]]), runTicksMax: 120 });
export const COUNTER_GAME_ID = COUNTER_GAME.gameId;
