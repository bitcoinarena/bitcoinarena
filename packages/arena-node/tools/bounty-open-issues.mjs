#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PUBLIC OPEN-ISSUES LIST (kanban #2623, #2641): the board's open public bugs (isPublicBug) by area, each ticket with its reviewed one-line summary
// (data/open-issue-summaries.json; a ticket not in it yet shows "<area>: issue under review", never its title), written to the file the faucet
// serves at GET /feedback/open-issues (FAUCET_OPEN_ISSUES). One log line a run; nothing is deployed.
//   node tools/bounty-open-issues.mjs <out.json> [--summaries <map.json>] [--apply-summaries <new.json>]
//   --apply-summaries merges { "<id>": "<line>" | { "text", "kind": "bug"|"task" } } into the map first (the 4-hourly refill), then writes the list.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openIssueAreas } from '../src/bounty-season.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const out = process.argv[2];
if (!out || out.startsWith('--')) { console.error('usage: bounty-open-issues.mjs <out.json> [--summaries <map.json>] [--apply-summaries <new.json>]'); process.exit(2); }
const MAP = arg('--summaries') || fileURLToPath(new URL('../data/open-issue-summaries.json', import.meta.url));
const put = (f, text) => { writeFileSync(`${f}.next`, text); renameSync(`${f}.next`, f); };
let map = {}; try { map = JSON.parse(readFileSync(MAP, 'utf8')); } catch { map = {}; }
const add = arg('--apply-summaries');
if (add) {
  const more = JSON.parse(readFileSync(add, 'utf8')); let n = 0;
  for (const [id, v] of Object.entries(more)) {
    if (!/^\d{1,6}$/.test(id)) continue;
    const e = typeof v === 'string' ? { text: v, kind: 'bug' } : { text: String((v && v.text) || ''), kind: v && v.kind === 'task' ? 'task' : 'bug' };
    if (!e.text.trim()) continue;
    map[id] = { text: e.text.trim().slice(0, 120), kind: e.kind }; n++;
  }
  put(MAP, `${JSON.stringify(map, null, 1)}\n`);
  console.log(`${new Date().toISOString()} summaries: ${n} added or changed, ${Object.keys(map).length} in the map`);
}
const key = readFileSync(process.env.KANBAN_KEY_FILE || `${process.env.HOME}/.config/blwp/kanban-key`, 'utf8').trim();
const r = await fetch(`${process.env.KANBAN_URL || 'http://127.0.0.1:18850'}/api/tasks`, { headers: { authorization: `Bearer ${key}` } });
const body = await r.json();
const { missing, ...list } = openIssueAreas(Array.isArray(body) ? body : body.tasks, { summaries: map });
// ONE LINE A RUN (kanban #2641): changed or not, the counts, added and removed, and the ids that still need a summary
const ids = (l) => new Set(((l && l.areas) || []).flatMap((a) => a.tickets));
let before = null; try { before = JSON.parse(readFileSync(out, 'utf8')); } catch { before = null; }
const [was, now] = [ids(before), ids(list)];
const added = [...now].filter((t) => !was.has(t)).length, removed = [...was].filter((t) => !now.has(t)).length;
put(out, `${JSON.stringify(list, null, 1)}\n`);
console.log(`${new Date().toISOString()} open issues: ${added || removed ? 'changed' : 'unchanged'}, ${list.areas.length} areas, ${now.size} tickets (+${added} -${removed}); need a summary: ${missing.length ? missing.join(' ') : 'none'}; served live by the faucet, no deploy`);
