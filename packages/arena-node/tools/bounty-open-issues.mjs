#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PUBLIC OPEN-ISSUES LIST (kanban #2623): the board's open bug tickets as area names and ticket numbers only - never a title or a word of a
// ticket - written to the file the faucet serves at GET /feedback/open-issues (FAUCET_OPEN_ISSUES) and the static /kanban page shows.
//   KANBAN_URL=http://127.0.0.1:18850 KANBAN_KEY_FILE=~/.config/blwp/kanban-key node tools/bounty-open-issues.mjs <out.json>
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { openIssueAreas } from '../src/bounty-season.js';

const out = process.argv[2];
if (!out) { console.error('usage: bounty-open-issues.mjs <out.json>'); process.exit(2); }
const key = readFileSync(process.env.KANBAN_KEY_FILE || `${process.env.HOME}/.config/blwp/kanban-key`, 'utf8').trim();
const r = await fetch(`${process.env.KANBAN_URL || 'http://127.0.0.1:18850'}/api/tasks`, { headers: { authorization: `Bearer ${key}` } });
const body = await r.json();
const list = openIssueAreas(Array.isArray(body) ? body : body.tasks);
writeFileSync(`${out}.next`, `${JSON.stringify(list, null, 1)}\n`);
renameSync(`${out}.next`, out);
console.log(`${list.areas.length} areas, ${list.areas.reduce((s, a) => s + a.tickets.length, 0)} tickets`);
