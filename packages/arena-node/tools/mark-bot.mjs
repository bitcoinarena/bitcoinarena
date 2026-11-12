// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HARNESS'S ENTRY, TOLD TO THE EXPLORER AS A BOT'S THE MOMENT IT IS MADE (kanban #2035, measured 2026-11-12: the #1479 paid probe's entry de5c4209
// from tn4-live-run.mjs counted as a real player's - no KEYS_FILE in ops/, so the 10-minute marker never saw it). Every harness that posts an entry to
// the live seats calls markBot with the entry id and the player key, before or right after the entry goes out.
//
// BY THE ADMIN CODE, NOT BY ADDRESS: POST /api/mark { kind: 'bot', keys, code }. The explorer marks any key it is given that way, held yet or not, and
// the code never expires; mark-ip works only while the address sent the code within the last 48 hours (worker.js ADMIN_IP_HOURS) and only for entry
// ids, never a player key. The code is read from ADMIN_CODE_FILE (default ~/.config/blwp/arena-admin-code) and goes nowhere but the request body:
// never a log line, an error, a file or a return value. MARK_BOT=off skips it (a regtest run's entries are not the live explorer's).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const hex64 = /^[0-9a-f]{64}$/;
const hexOf = (k) => (k instanceof Uint8Array ? [...k].map((b) => b.toString(16).padStart(2, '0')).join('') : String(k || '').toLowerCase());
export const markUrl = (env = process.env) => env.EXPLORER_MARK_URL || 'https://explorer.bitcoinarena.io/api/mark';
export const adminCodeFile = (env = process.env) => env.ADMIN_CODE_FILE || join(homedir(), '.config', 'blwp', 'arena-admin-code');

// keys: entry ids and player keys, hex or bytes. Answers { ok, marked } or { ok: false, why } - never throws, never names the code
export async function markBot(keys, { env = process.env, fetcher = fetch, read = readFileSync, tries = 3, waitMs = 2000 } = {}) {
  const list = [...new Set((Array.isArray(keys) ? keys : [keys]).map(hexOf).filter((k) => hex64.test(k)))].slice(0, 500);
  if (!list.length) return { ok: false, why: 'no entry id or player key to mark' };
  if (/^(off|0|no)$/i.test(String(env.MARK_BOT || ''))) return { ok: false, why: 'MARK_BOT=off' };
  let code;
  try { code = String(read(adminCodeFile(env), 'utf8')).trim(); } catch { return { ok: false, why: 'no admin code file - the entry is NOT marked bot' }; }
  if (!code) return { ok: false, why: 'the admin code file is empty - the entry is NOT marked bot' };
  let why = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetcher(markUrl(env), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'bot', keys: list, code }), signal: AbortSignal.timeout(20000) });
      let j = {}; try { j = await r.json(); } catch { j = {}; }
      if (r.ok && j && j.ok) return { ok: true, marked: Number(j.marked) || list.length };
      why = `the explorer said ${r.status} ${String((j && j.why) || '').slice(0, 80)}`.trim();
      if (r.status === 403 || r.status === 400) break;   // a wrong code or body is not fixed by asking again
    } catch (e) { why = `the explorer did not answer: ${String((e && e.name) || 'error')}`; }
    if (i < tries) await new Promise((ok) => setTimeout(ok, waitMs));
  }
  return { ok: false, why };
}

// the keys of one entry: its id and its player's key
export const entryKeys = (eid, entry) => [eid, entry && entry.playerPubkey].filter(Boolean);
