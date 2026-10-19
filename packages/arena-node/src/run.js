// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLED NODE'S START: node src/run.js <home>/arena.conf - the one argument its service names. The file's settings
// become the seat's (arena-conf.js confToRun), then the seat starts as `main.js <port> <database>` would. A file that does not read
// stops the start with the line that is wrong.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConf, confToRun, unknownKeys } from './arena-conf.js';

const file = resolve(process.argv[2] || 'arena.conf');
let text;
try { text = readFileSync(file, 'utf8'); } catch (e) { console.error(`[arena.conf] cannot read ${file}: ${e.code || e.message}`); process.exit(2); }
const { values, errors } = parseConf(text);
if (errors.length) { console.error(`[arena.conf] ${file}:\n  ${errors.join('\n  ')}`); process.exit(2); }
const run = confToRun(values, { home: dirname(file) });
for (const [k, v] of Object.entries(run.env)) process.env[k] = v;
// the node's home: what the owner area's service overview (arena-installer node-services.js, instance.js) reads this node from
process.env.ARENA_HOME = dirname(file);
const other = unknownKeys(values);
console.log(`[arena.conf] ${file}: ${Object.keys(values).length} settings, seat on port ${run.port}${other.length ? `; not listed by this release (passed on): ${other.join(', ')}` : ''}`);
process.argv = [process.argv[0], fileURLToPath(new URL('./main.js', import.meta.url)), String(run.port), run.database];
await import('./main.js');
