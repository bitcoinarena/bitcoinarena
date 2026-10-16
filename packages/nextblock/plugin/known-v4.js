// WHAT A CLIENT LISTS OF NEXTBLOCK VERSION 4 (kanban #397 slice 5): the manifest that sells the larger truck on the reserves' terms - its signed bytes and the
// configs it plays as one world per round, as known-v3.js lists version 3.
//
//   node packages/arena-protocol/tools/known-games.js packages/nextblock/plugin/known.js packages/nextblock/plugin/known-v4.js
import { MANIFEST_V4_HEX } from './nextblock-v4.js';
import { NEXTBLOCK_CORES_V3 } from './truck-cores.js';

export const KNOWN_GAME = Object.freeze({
  manifestHex: MANIFEST_V4_HEX,
  sharedWorld: [...new Set([...NEXTBLOCK_CORES_V3.values()].flatMap((c) => [...c.configs].filter(([, cfg]) => cfg && cfg.worldShared).map(([h]) => h)))],
});
