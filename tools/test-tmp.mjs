#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST RUN KEEPS ITS TEMP FILES TO ITSELF (kanban #3071): about 250 arena-node test files make a folder with mkdtemp(tmpdir()) and leave it
// behind, a relay store of 200-500 MB among them, so a few full runs filled a 15 GB /tmp and the run after them broke on "disk quota
// exceeded". This runs node with the given arguments and TMPDIR set to a fresh folder of its own, and removes that folder when node ends -
// passed, failed or stopped - so every test's os.tmpdir() lands in it without each file cleaning up after itself.
//
//     node ../../tools/test-tmp.mjs --test --test-timeout=120000 test/*.test.js        (the arena-node and arena-client `npm test`)
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'arena-test-'));
const tidy = () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
// Ctrl-C reaches the child through the terminal; a signal sent to this process alone is passed on, and the folder goes once node ends
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (e) => { tidy(); console.error(e.message); process.exit(1); });
child.on('exit', (code, signal) => { tidy(); process.exit(code ?? (signal ? 1 : 0)); });
