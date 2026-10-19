// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS AS A TEST PLUGIN (kanban #233): the game's own decide adapter (packages/rock-paper-scissors), registered
// under a test developer key, as a node's launcher would hand it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DECIDE } from '../../../../rock-paper-scissors/plugin/decide.js';
import { testHeadToHeadGame } from '../sign.js';
import { toHex } from '../../../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest();
const SRC = new URL('../../../../rock-paper-scissors/plugin/decide.js', import.meta.url);
export const RPS_CORE_HASH = sha(readFileSync(SRC));
export const RPS_CONFIG_HASH = sha('rock-paper-scissors-config:v1');
export const RPS_CORE = Object.freeze({ name: DECIDE.name, hash: toHex(RPS_CORE_HASH), url: SRC.href, adapter: DECIDE,
  configs: new Map([[toHex(RPS_CONFIG_HASH), {}]]) });
export const RPS = testHeadToHeadGame({ name: 'rock-paper-scissors', core: RPS_CORE });
export const RPS_GAME_ID = RPS.gameId;
