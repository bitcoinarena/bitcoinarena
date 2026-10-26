#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The one-time owner sign-in page of `bitcoinarena open` (src/owner-handoff.js), run apart so the command (and the app's button) returns at
// once: its address on the first line of stdout; it ends once the key is handed over, or after 3 minutes.
// ARENA_HANDOFF_ALL=1 (kanban #713, `bitcoinarena sign-in-all`): every node's key on this machine at once, each kept under its node, and
// the page lists a link to every owner page
import { ownerKeyOf, serveHandoff, allOwnerKeys } from '../src/owner-handoff.js';

const home = process.env.ARENA_HANDOFF_HOME, target = process.env.ARENA_HANDOFF_TARGET;
let key = null, links = [], homes = null;
if (home && target && process.env.ARENA_HANDOFF_ALL === '1') {
  const { nodesHere } = await import('../src/machine-nodes.js');
  const all = allOwnerKeys(nodesHere({ extra: [home] }), target.split('#')[0]);
  if (all.keys.length) { key = { keys: all.keys }; links = all.links; homes = all.homes; }
} else if (home && target) key = ownerKeyOf(home);
if (!key) { process.stdout.write('none\n'); process.exit(1); }
const { url, done } = await serveHandoff({ home, key, target, links, homes });
process.stdout.write(`${url}\n`);
process.exit((await done) ? 0 : 3);
