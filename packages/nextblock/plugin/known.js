// WHAT A CLIENT LISTS OF NEXTBLOCK (kanban #203): its signed manifest's bytes and the configs it plays as one world per
// round - read by the engine's generator, arena-protocol/tools/known-games.js, given this file as an argument; the engine
// imports no game:
//
//   node packages/arena-protocol/tools/known-games.js packages/nextblock/plugin/known.js
import { NEXTBLOCK_MANIFEST_HEX } from './nextblock-manifest.js';
import { NEXTBLOCK_CORES } from './truck-cores.js';

export const KNOWN_GAME = Object.freeze({
  manifestHex: NEXTBLOCK_MANIFEST_HEX,
  sharedWorld: [...new Set([...NEXTBLOCK_CORES.values()].flatMap((c) => [...c.configs].filter(([, cfg]) => cfg && cfg.worldShared).map(([h]) => h)))],
});
