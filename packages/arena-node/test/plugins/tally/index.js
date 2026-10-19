// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TALLY AS A PLUGIN (kanban #202): its core, its one config, and its manifest - signed by a test developer key
// (../sign.js) - as a node's launcher would register it. Its sim_wasm_hash is sha256 over its core's source, as the
// truck's is over its sources.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CORE, TALLY_RUN_TICKS } from './core.js';
import { testGame } from '../sign.js';
import { toHex } from '../../../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest();

export const TALLY_CORE_HASH = sha(readFileSync(new URL('./core.js', import.meta.url)));
/** Its one rule set: tally has no rules to vary, so the config is the hash of its name. */
export const TALLY_CONFIG_HASH = sha('tally-config:v1');

export const TALLY_CORE = Object.freeze({
  name: CORE.name, hash: toHex(TALLY_CORE_HASH), url: new URL('./core.js', import.meta.url).href, adapter: CORE,
  configs: new Map([[toHex(TALLY_CONFIG_HASH), {}]]),
});

export const TALLY = testGame({ name: 'tally', cores: new Map([[TALLY_CORE.hash, TALLY_CORE]]), runTicksMax: TALLY_RUN_TICKS });
export const TALLY_GAME_ID = TALLY.gameId;
