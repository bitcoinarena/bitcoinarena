// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REFERENCE NODE LAUNCHER (§0A.4: "the reference node hosts nextblock by default; the operator may remove it"). The
// engine's node (src/main.js) names no app and hosts the registrations ARENA_APPS lists; this launcher names Next Block
// there unless the operator already set the list, then runs the engine's node with the same arguments. It is the Arena's
// (kanban #568/#569: it was packages/nextblock/bin/node.mjs - a node ships its apps preinstalled, an app does not start nodes):
//
//   node packages/arena-node/bin/node.mjs <port> <db>      (as node packages/arena-node/src/main.js <port> <db>)
//
// An operator who wants another set of games sets ARENA_APPS and runs either.
import { fileURLToPath } from 'node:url';

if (!process.env.ARENA_APPS) process.env.ARENA_APPS = fileURLToPath(new URL('../../nextblock/plugin/nextblock.js', import.meta.url));
await import('../src/main.js');
