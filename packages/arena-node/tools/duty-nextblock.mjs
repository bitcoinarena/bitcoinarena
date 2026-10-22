// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TICK TOCK VERSION A DAILY DUTY POSTS (kanban #523, 2026-10-22): run-testnet4-paid.mjs knew one switch, DUTY_NEXTBLOCK_V3=1 (version
// 3 on core f0cc7b7b). DUTY_NEXTBLOCK_PLUGIN names a registration module in packages/nextblock/plugin (nextblock-v5.js), and
// DUTY_NEXTBLOCK_CORE the core its rounds run on, by hash or prefix - one the registration installs; a registration with one core needs none.
// Its rounds are drawn only from census entries whose advertisement names the game id (census.js eligibleFor): a version no
// advertisement names yet posts rounds no committee can serve.
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** The round fields for a registration: { gameId, simCoreHash } - or why not. */
export function nextblockDutyFields(game, core = '') {
  if (!game || !(game.gameId instanceof Uint8Array) || !(game.cores instanceof Map)) return { ok: false, why: 'not a registration (gameId, cores)' };
  const hashes = [...game.cores.keys()].map((h) => (typeof h === 'string' ? h : toHex(h)).toLowerCase());
  const want = String(core || '').toLowerCase();
  const picked = want ? hashes.filter((h) => h.startsWith(want)) : hashes.length === 1 ? hashes : [];
  if (picked.length !== 1) return { ok: false, why: want ? `core ${want} is ${picked.length ? 'not one core' : 'none'} of ${hashes.map((h) => h.slice(0, 8)).join(', ')}` : `this registration installs ${hashes.length} cores (${hashes.map((h) => h.slice(0, 8)).join(', ')}): name one in DUTY_NEXTBLOCK_CORE` };
  return { ok: true, fields: { gameId: game.gameId, simCoreHash: fromHex(picked[0]) } };
}

/** The registration DUTY_NEXTBLOCK_PLUGIN names, loaded from packages/nextblock/plugin. */
export async function loadNextblockPlugin(file) {
  if (!/^nextblock(-v\d+)?\.js$/.test(String(file || ''))) throw new Error(`DUTY_NEXTBLOCK_PLUGIN names a nextblock plugin file, not ${file}`);
  return (await import(`../../nextblock/plugin/${file}`)).GAME;
}
