// WHAT A CLIENT LISTS OF NEXTBLOCK VERSION 3 (kanban #369): the manifest that sells the larger truck - its signed bytes and the
// configs it plays as one world per round, as known.js lists version 1. Without it a page took a v3 round's game for one it does
// not know: no Unity for it, and an entry naming a world secret where the seats want none.
//
//   node packages/arena-protocol/tools/known-games.js packages/nextblock/plugin/known.js packages/nextblock/plugin/known-v3.js
import { MANIFEST_V3_HEX } from './nextblock-v3.js';
import { NEXTBLOCK_CORES_V3 } from './truck-cores.js';

export const KNOWN_GAME = Object.freeze({
  manifestHex: MANIFEST_V3_HEX,
  sharedWorld: [...new Set([...NEXTBLOCK_CORES_V3.values()].flatMap((c) => [...c.configs].filter(([, cfg]) => cfg && cfg.worldShared).map(([h]) => h)))],
});
