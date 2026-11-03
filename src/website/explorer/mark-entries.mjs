#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// OUR BOTS' ENTRIES, TOLD TO THE EXPLORER (kanban #1090, the owner 2026-11-03: played rounds "ohne deine Bots"): the entry ids - each the id of
// its transaction in the explorer - that our own bots made, read from the files they keep, posted to POST /api/mark as kind "bot" with the admin
// code. Only the ids leave this machine: never a secret, a seed or a wallet.
//
//   ADMIN_CODE_FILE=<file holding the admin code> node mark-entries.mjs <file> [<file> ...]
//
// A file is read as JSON (an array of records, each with "entry" - market-bot.mjs orders.json) or, failing that, as JSON lines (each with "entry"
// - rps-opponent.mjs keys.jsonl). Each run posts every id it finds; the explorer keeps one row per id, so posting again changes nothing.
import { readFileSync } from 'node:fs';

const URL_MARK = process.env.EXPLORER_MARK_URL || 'https://explorer.bitcoinarena.io/api/mark';
const hex64 = /^[0-9a-f]{64}$/;

export function entryIdsOf(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { rows = text.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }); }
  if (!Array.isArray(rows)) rows = [rows];
  return [...new Set(rows.filter((r) => r && typeof r === 'object').map((r) => String(r.entry || '').toLowerCase()).filter((x) => hex64.test(x)))];
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length || !process.env.ADMIN_CODE_FILE) { console.error('usage: ADMIN_CODE_FILE=<file> node mark-entries.mjs <file> [<file> ...]'); process.exit(2); }
  const code = readFileSync(process.env.ADMIN_CODE_FILE, 'utf8').trim();
  const ids = new Set();
  for (const f of files) { try { for (const x of entryIdsOf(readFileSync(f, 'utf8'))) ids.add(x); } catch (e) { console.error(`${f}: ${e.message}`); } }
  const all = [...ids];
  let marked = 0;
  for (let i = 0; i < all.length; i += 500) {
    const r = await fetch(URL_MARK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'bot', keys: all.slice(i, i + 500), code }), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { console.error(`the explorer refused: ${r.status} ${j.why || ''}`); process.exit(1); }
    marked += j.marked;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), files: files.length, entries: all.length, marked }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
