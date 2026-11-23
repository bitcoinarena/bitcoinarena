#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OPEN PUBLIC BUGS WITH NO SUMMARY YET (kanban #2641, the owner 2026-11-14: "Die neuen Tickets alle 4 Stunden nachtragen"): [{ id, title, area }] as
// JSON for whoever writes the one-line summaries; they go back with bounty-open-issues.mjs --apply-summaries. Internal only (titles are not public).
//   node tools/open-issues-pending.mjs [--summaries <map.json>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPublicBug, areaOf } from '../src/bounty-season.js';

const i = process.argv.indexOf('--summaries');
const MAP = i > 0 ? process.argv[i + 1] : fileURLToPath(new URL('../data/open-issue-summaries.json', import.meta.url));
let map = {}; try { map = JSON.parse(readFileSync(MAP, 'utf8')); } catch { map = {}; }
const key = readFileSync(process.env.KANBAN_KEY_FILE || `${process.env.HOME}/.config/blwp/kanban-key`, 'utf8').trim();
const body = await (await fetch(`${process.env.KANBAN_URL || 'http://127.0.0.1:18850'}/api/tasks`, { headers: { authorization: `Bearer ${key}` } })).json();
const tasks = Array.isArray(body) ? body : body.tasks;
const pending = tasks.filter((x) => isPublicBug(x, map) && !(map[String(x.id)] && (typeof map[String(x.id)] === 'string' || map[String(x.id)].text)))
  .map((x) => ({ id: Number(x.id), title: String(x.title || ''), area: areaOf(x.title) })).sort((p, q) => p.id - q.id);
console.log(JSON.stringify(pending, null, 1));
