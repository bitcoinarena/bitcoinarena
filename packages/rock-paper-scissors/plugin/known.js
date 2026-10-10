// WHAT A CLIENT LISTS OF ROCK PAPER SCISSORS (kanban #293, the owner 2026-10-10: paid head-to-head rounds, 100 sats, no series):
// its signed manifest's bytes - read by the engine's generator, arena-protocol/tools/known-games.js, given this file as an
// argument. Without it a paying round of it is refused at the page ("not on this client's known-good list of games").
//
//   node packages/arena-protocol/tools/known-games.js packages/rock-paper-scissors/plugin/known.js
import { RPS_MANIFEST_HEX } from './rps-manifest.js';

export const KNOWN_GAME = Object.freeze({ manifestHex: RPS_MANIFEST_HEX, sharedWorld: [] });
