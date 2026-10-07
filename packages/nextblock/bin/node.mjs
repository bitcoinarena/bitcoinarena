// NEXTBLOCK'S REFERENCE NODE LAUNCHER (kanban #203, §0A.4: "the reference node hosts nextblock by default; the operator
// may remove it"). The engine's node (blwp-node/src/main.js) names no game and hosts the registrations BLWP_GAMES lists;
// this launcher - the game's, on the game's side of the line - names nextblock there unless the operator already set
// the list, then runs the engine's node with the same arguments:
//
//   node packages/nextblock/bin/node.mjs <port> <db>      (as node packages/blwp-node/src/main.js <port> <db>)
//
// An operator who wants another set of games sets BLWP_GAMES and runs either.
import { fileURLToPath } from 'node:url';

if (!process.env.BLWP_GAMES) process.env.BLWP_GAMES = fileURLToPath(new URL('../plugin/nextblock.js', import.meta.url));
await import('../../blwp-node/src/main.js');
