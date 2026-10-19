#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// IS THE PAGE YOU WERE SERVED A KNOWN-GOOD CLIENT? Checked OUTSIDE the page
// (§24, v4.6.2; F2's second clause).
//
//   node packages/arena-node/tools/client-hash.mjs <served page URL | build dir>
//
// A compromised web host can serve scripts that enters a player under the wrong
// key or on the wrong core, and any check those scripts run on themselves
// passes. So the player - or anyone - hashes what the page ACTUALLY serves,
// here, and compares it with the repo's list (`arena-client/known-good-clients.json`),
// which the page never supplies. Same shape as `refund-key.mjs`: local code,
// public inputs, one line per thing checked. Exits 0 only if every pinned file
// matches.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const LIST = JSON.parse(readFileSync(new URL('../../arena-client/known-good-clients.json', import.meta.url), 'utf8'));
const where = process.argv[2];
if (!where) {
  console.error('usage: node client-hash.mjs <served page URL | build directory>');
  process.exit(2);
}
const remote = /^https?:\/\//.test(where);

async function served(name) {
  if (remote) {
    const r = await fetch(new URL(name, where.endsWith('/') ? where : where + '/'));
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  }
  try { return readFileSync(join(where, name)); } catch { return null; }
}

// THE ENGINE'S SCRIPTS AND EACH GAME'S (kanban #202: one list per game): a page serves both, and both decide money.
const PINNED = [...Object.entries(LIST.pinned), ...Object.values(LIST.games || {}).flatMap((g) => Object.entries(g.pinned))];
let good = true;
for (const [name, hashes] of PINNED) {
  const bytes = await served(name);
  if (!bytes) { console.log(`${name.padEnd(15)} missing`); good = false; continue; }
  const got = createHash('sha256').update(bytes).digest('hex');
  const ok = hashes.includes(got);
  if (!ok) good = false;
  console.log(`${name.padEnd(15)} ${ok ? 'match' : 'MISMATCH'}  ${got}`);
}
for (const [name, why] of Object.entries(LIST.notPinned || {}))
  console.log(`${name.padEnd(15)} not pinned  (${why})`);
process.exit(good ? 0 : 1);
