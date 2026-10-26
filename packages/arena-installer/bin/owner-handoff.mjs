#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The one-time owner sign-in page of `bitcoinarena open` (src/owner-handoff.js), run apart so the command (and the app's button) returns at
// once: its address on the first line of stdout; it ends once the key is handed over, or after 3 minutes.
import { ownerKeyOf, serveHandoff } from '../src/owner-handoff.js';

const home = process.env.ARENA_HANDOFF_HOME, target = process.env.ARENA_HANDOFF_TARGET;
const key = home && target ? ownerKeyOf(home) : null;
if (!key) { process.stdout.write('none\n'); process.exit(1); }
const { url, done } = await serveHandoff({ home, key, target });
process.stdout.write(`${url}\n`);
process.exit((await done) ? 0 : 3);
