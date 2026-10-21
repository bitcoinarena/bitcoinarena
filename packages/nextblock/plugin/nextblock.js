// NEXTBLOCK AS A PLUGIN (kanban #202, §0A.2-0A.3; the owner 2026-10-06: the engine is Bitcoin Arena, the game is "Tick
// Tock, Next Block" - `nextblock` in code). The registration a node's launcher hands serve() (arena-node/src/main.js):
// the game's manifest as its developer signed it with the dev client (public bytes, nextblock-manifest.js), its id, and the cores the node installed for it (truck-cores.js, what was
// arena-node/src/cores.js's truck half). The engine imports none of this; it reads a game through its manifest
// (arena-protocol/src/manifest.js) and a core through its adapter, as arena-node/src/plugins.js hands them on.
export * from './truck-cores.js';
import { NEXTBLOCK_CORES, nextblockRoundWarnings } from './truck-cores.js';
import { fromHex } from 'arena-sdk/hash';
import { decodeManifest, gameIdOf } from 'arena-sdk/manifest';
import { NEXTBLOCK_MANIFEST_HEX } from './nextblock-manifest.js';
import { TESTNET4_DONATION_SET_KEYS } from 'arena-sdk/testnet4-donation-set-keys';
import { INFO } from './info.js';

/** THE SIGNED MANIFEST, and its id: what a round of nextblock names as its game_id (§0A.3). */
export const NEXTBLOCK_MANIFEST = decodeManifest(fromHex(NEXTBLOCK_MANIFEST_HEX));
export const NEXTBLOCK_GAME_ID = gameIdOf(NEXTBLOCK_MANIFEST);

/**
 * THE REGISTRATION a node's launcher hands serve() (arena-node/src/plugins.js): the manifest, the cores it installed, and
 * the game's own replay page (kanban #202: a page that draws the truck is nextblock's, never the engine's) - served at
 * /replay for a round of nextblock.
 */
export const NEXTBLOCK = Object.freeze({ name: 'nextblock', manifest: NEXTBLOCK_MANIFEST, gameId: NEXTBLOCK_GAME_ID, cores: NEXTBLOCK_CORES,
  // ITS DESCRIPTION AND WEBSITE, signed by its developer beside the manifest (kanban #276; the id does not move)
  info: INFO,
  replayPage: new URL('./nextblock-replay.html', import.meta.url), roundWarnings: nextblockRoundWarnings,
  // ITS NAME AND MARK AS A PLAYER SEES THEM (kanban #228): the node's pages show them beside its rounds
  title: 'Tick Tock, Next Block', icon: new URL('../brand/nextblock-icon.svg', import.meta.url),
  // ITS DEVELOPER'S DONATION SET (§0A.8, kanban #205): the one its manifest names by id - the testnet4 key set, so on
  // testnet4 nextblock's protocol dev and game dev are the same recipients and are paid once
  donationSet: TESTNET4_DONATION_SET_KEYS.recipients });

/** What a launcher loads from this module (ARENA_GAMES, arena-node/src/main.js): nextblock's registration. */
export const GAME = NEXTBLOCK;
