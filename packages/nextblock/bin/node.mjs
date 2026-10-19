// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NEXTBLOCK'S REFERENCE NODE LAUNCHER (§0A.4: "the reference node hosts nextblock by default; the operator
// may remove it"). The engine's node (arena-node/src/main.js) names no game and hosts the registrations ARENA_GAMES lists;
// this launcher - the game's, on the game's side of the line - names nextblock there unless the operator already set
// the list, then runs the engine's node with the same arguments:
//
//   node packages/nextblock/bin/node.mjs <port> <db>      (as node packages/arena-node/src/main.js <port> <db>)
//
// An operator who wants another set of games sets ARENA_GAMES and runs either.
import { fileURLToPath } from 'node:url';

if (!process.env.ARENA_GAMES) process.env.ARENA_GAMES = fileURLToPath(new URL('../plugin/nextblock.js', import.meta.url));
await import('../../arena-node/src/main.js');
