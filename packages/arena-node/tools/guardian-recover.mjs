#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RECOVERY CHECK FOR GUARDIANS NAMED BY HAND (kanban #718): the decision guardian-recover.js makes at a node's guardian start, for a
// set of STOPPED guardians given explicitly - federation A's 7 on one machine (tools/guardian-ram-ops.sh), or every guardian of a
// federation spread over machines when they have to be repaired together (run it on each machine with that machine's guardians, after
// comparing the printed digests). Nothing is deleted without --repair.
//
//   node tools/guardian-recover.mjs [--repair] [--n <federation size>] --dbtool <fedimint-dbtool> \
//     --guardian <data dir>:<RAM dir> [--guardian ...]
//
// <data dir> holds consensus.json, local.json and ram-snaps/ (current, clean); <RAM dir>/database is the RocksDB fedimintd opens. Prints
// one JSON line per guardian ({ id, snap, clean, finished, items, digest }) and then the verdict ({ action, why }). Exit 0: start them
// (clean, consistent, repaired, lone); 3: refused (the reason printed); 4: unchecked (no dbtool); 2: usage.
import { readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decideGroup, federationOf, fedimintDb, digestOf, repairAll } from '../src/guardian-recover.js';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const guardians = argv.flatMap((a, i) => (a === '--guardian' ? [argv[i + 1]] : [])).map((g) => { const i = g.lastIndexOf(':'); return { dataDir: g.slice(0, i), ram: g.slice(i + 1) }; });
const repair = argv.includes('--repair');
const say = (o) => console.log(JSON.stringify(o));
if (!guardians.length || guardians.some((g) => !g.dataDir || !g.ram)) { console.error('usage: guardian-recover.mjs [--repair] [--n N] --dbtool <bin> --guardian <data dir>:<RAM dir> ...'); process.exit(2); }
const db = opt('--dbtool') ? fedimintDb(opt('--dbtool')) : null;

const members = [];
for (const g of guardians) {
  const fed = federationOf(g.dataDir);
  if (!fed) { say({ dataDir: g.dataDir, skip: 'no federation (setup): nothing to recover' }); continue; }
  let snap = null, clean = false;
  try { snap = readlinkSync(join(g.dataDir, 'ram-snaps', 'current')); } catch { /* none */ }
  try { clean = !!snap && readFileSync(join(g.dataDir, 'ram-snaps', 'clean'), 'utf8').trim() === snap; } catch { /* no marker */ }
  const m = { id: fed.id, fed: fed.fed, n: fed.n, dataDir: g.dataDir, ram: g.ram, db: join(g.ram, 'database'), snap, clean, at: Date.now() };
  if (db) { try { m.finished = await db.finished(m.db); m.accepted = await db.accepted(m.db); } catch (e) { m.finished = null; m.accepted = null; m.readError = e.message; } }
  say({ id: m.id, federation: m.fed, snap, clean, finished: m.finished ?? null, items: m.accepted ? m.accepted.length : null, digest: m.accepted ? digestOf(m.accepted) : null, readError: m.readError });
  members.push(m);
}
if (!members.length) { say({ action: 'none', why: 'no guardian with a federation' }); process.exit(0); }
if (new Set(members.map((m) => m.fed)).size > 1) { say({ action: 'refuse', why: 'the guardians named belong to different federations: name one federation\'s at a time' }); process.exit(3); }
const unclean = members.filter((m) => !m.clean);
if (!unclean.length) { say({ action: 'clean', why: 'every guardian restored from its clean stop: started as they are' }); process.exit(0); }
const n = Number(opt('--n')) || members[0].n;
let d = decideGroup({ n, members: unclean });
if (d.action === 'repair') {
  if (!repair) { say({ ...d, action: 'repair-needed', why: `${d.why} - run again with --repair (all ${n} stopped)` }); process.exit(0); }
  try { await repairAll(db, unclean, { log: (l) => console.error(l) }); } catch (e) { d = { action: 'refuse', why: `REFUSED: the repair failed (${e.message})` }; }
}
say({ action: d.action, why: d.why });
process.exit(d.action === 'refuse' ? 3 : d.action === 'unchecked' ? 4 : 0);
