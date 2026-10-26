// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH COPY FROM A MACHINE OF OURS (2026-10-26, the owner: "Health should update every 5 minutes, atm it's 20 minutes old"): the
// Worker's plan lets one run ask about 50 doors, the copy needs about 340, so it filled over many runs and its oldest answer was 20 min
// old. Here the same read (health.js readHealth) runs with no such limit - every door asked each time - and the copy goes to the
// Worker's KV key 'health' with wrangler; the page reads it from GET /api/health as before. Run every 3 min by a systemd timer.
// Usage: node health-push.mjs <copy file> <KV namespace id>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readHealth } from './health.js';

const [file, ns] = process.argv.slice(2);
if (!file || !ns) { console.error('usage: node health-push.mjs <copy file> <KV namespace id>'); process.exit(2); }
const env = {
  HEALTH_BUDGET: 5000, HEALTH_AT_ONCE: 32,   // a machine of ours, not a Worker's six connections
  EXPLORER: {
    get: async () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    put: async (_k, v) => { writeFileSync(file, v); },
  },
};
const n = await readHealth(env);
execFileSync('npx', ['wrangler', 'kv', 'key', 'put', 'health', '--path', file, '--namespace-id', ns, '--remote'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 120000 });
console.log(JSON.stringify({ at: new Date().toISOString(), pushed: n }));
