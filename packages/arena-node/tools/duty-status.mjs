#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * WHERE THE NEXT TWO DAYS OF ROUNDS STAND, PER GAME (kanban #689, 2026-10-26: "Make sure that we always post rounds properly for the next
 * day"): for today and tomorrow (UTC) and each duty app - Up/Down, Rock Paper Scissors, Tick Tock - whether the day was posted, which
 * version, on how many of the seats asked its rounds are drawn, and the first drawn window. Read-only: GET /games and GET
 * /rounds?next=1&ahead=50h of the seats, and the duty runners' status files (status-<item>.json, run-testnet4-paid.mjs) when they are there.
 * An operator - or a cron - sees a dead day hours before it starts: the exit code is 2 when a day that starts within --warn-hours (4), or
 * runs now, has no drawn round of a game on a majority of the seats.
 *
 *   node tools/duty-status.mjs [--seats http://127.0.0.1:31221,...] [--dir ~/blwp-testnet4/paid/duty-day] [--warn-hours 4] [--json]
 *
 * Without --seats: the seven test host testnet4 seats, 127.0.0.1:31221..31281.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { catalogOf, drawCount, DUTY_APP_NAMES } from '../src/duty-guard.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt; };
const seats = String(arg('seats', [31221, 31231, 31241, 31251, 31261, 31271, 31281].map((p) => `http://127.0.0.1:${p}`).join(','))).split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const dir = arg('dir', join(process.env.ARENA_TESTNET4_DIR || `${process.env.HOME}/blwp-testnet4`, 'paid', 'duty-day'));
const warnMs = Number(arg('warn-hours', 4)) * 3600000;
const asJson = process.argv.includes('--json');
const DAY = 86400000;

const get = async (url, ms) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const [games, rounds, expected] = await Promise.all([Promise.all(seats.map((s) => get(`${s}/games`, 20000))), Promise.all(seats.map((s) => get(`${s}/rounds?next=1&ahead=50h`, 90000))),
  get(`${seats[0]}/expected`, 20000)]);
// THE GRIDS ANNOUNCED TO THE SEATS (POST /expected, every grid at its publication): posted before any round of it is listed
const announced = ((expected && expected.expected) || []).map((e) => ({ ...e, firstCloseMs: Number(e.firstCloseMs), lastCloseMs: Number(e.lastCloseMs) }));
const catalog = catalogOf(games.filter(Boolean), { decode: decodeManifest, idOf: gameIdOf });
// THE RUNNERS' OWN WORD, when this machine runs them: status-<item>.json per game
const runner = {};
try { for (const f of readdirSync(dir).filter((x) => /^status-.*\.json$/.test(x))) { try { const s = JSON.parse(readFileSync(join(dir, f), 'utf8')); runner[s.game] = s; } catch { /* half written */ } } } catch { /* not here */ }

const nowMs = Date.now();
const today = Math.floor(nowMs / DAY) * DAY;
const out = [];
let alarm = false;
for (const startMs of [today, today + DAY]) {
  const day = new Date(startMs).toISOString().slice(0, 10), endMs = startMs + DAY;
  for (const [game, name] of Object.entries(DUTY_APP_NAMES)) {
    const versions = [...catalog.values()].filter((g) => g.name === name).sort((a, b) => b.version - a.version);
    let best = null;
    for (const v of versions) {
      const d = drawCount(rounds, { gameId: v.id, fromMs: Math.max(startMs, nowMs), toMs: endMs });
      if (!d.of) continue;
      const first = rounds.flatMap((l) => (l && l.rounds) || []).filter((r) => r.game && r.game.id === v.id && r.committee && r.committee.drawn
        && Date.parse(r.startTime) >= Math.max(startMs, nowMs) && Date.parse(r.startTime) < endMs).map((r) => r.startTime).sort()[0] || null;
      if (!best || d.drawn > best.drawn) best = { version: v.version, gameId: v.id.slice(0, 16), ...d, firstWindow: first };
    }
    const r = runner[game] && runner[game].days && runner[game].days[day];
    const drawable = !!best && best.drawn * 2 > best.of;
    const urgent = startMs <= nowMs + warnMs;
    if (!drawable && urgent) alarm = true;
    const ann = announced.filter((e) => e.game === name && e.firstCloseMs < endMs && e.lastCloseMs > startMs)
      .map((e) => ({ version: (catalog.get(String(e.gameId).toLowerCase()) || {}).version ?? null, txid: String((e.publication || {}).txid || '').slice(0, 16), height: (e.publication || {}).height ?? null,
        firstWindow: new Date(e.firstCloseMs).toISOString() }));
    out.push({ game, day, posted: r ? (r.postings || []).length > 0 : ann.length ? true : null, announced: ann, runnerState: r ? r.state : null, runnerWhy: r ? r.why || null : null,
      version: best ? best.version : null, gameId: best ? best.gameId : null, drawnOn: best ? `${best.drawn}/${best.of}` : `0/${rounds.filter(Boolean).length}`,
      firstWindow: best ? best.firstWindow : null, why: !drawable && best ? best.why || null : null, ok: drawable, ...(urgent && !drawable ? { alarm: 'NO DRAWABLE ROUNDS' } : {}) });
  }
}
if (asJson) console.log(JSON.stringify({ at: new Date(nowMs).toISOString(), seats: `${games.filter(Boolean).length}/${seats.length}`, days: out }, null, 1));
else {
  console.log(`duty status ${new Date(nowMs).toISOString()} - seats answering: ${games.filter(Boolean).length}/${seats.length} (games), ${rounds.filter(Boolean).length}/${seats.length} (rounds)`);
  for (const x of out) console.log([x.day, x.game.padEnd(9), x.ok ? 'OK   ' : x.alarm ? 'ALARM' : 'wait ', `v${x.version ?? '-'}`.padEnd(4), `drawn ${x.drawnOn}`.padEnd(11),
    `first ${x.firstWindow || '-'}`, `posted ${x.posted === null ? '?' : x.posted ? 'yes' : 'no'}`,
    x.announced.length ? `announced ${[...new Set(x.announced.map((a) => `v${a.version ?? '?'} ${a.txid}${a.height === null ? '' : ` @${a.height}`}`))].join(', ')}` : '',
    x.runnerState ? `runner ${x.runnerState}` : '', x.why || x.runnerWhy || ''].filter(Boolean).join('  '));
}
process.exit(alarm ? 2 : 0);
