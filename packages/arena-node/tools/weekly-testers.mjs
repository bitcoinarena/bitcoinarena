#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * WEEKLY ACTIVE TESTERS (kanban #926, the main metric of #922): distinct players who finished a round in the last DAYS, by game and in all,
 * from the network's own signed results (GET /season?scope=network: a round counts when SEASON_NETWORK_AGREE seats hand in the same account),
 * so anyone can check the number. Team and bot keys are left out by a kept list, one 64-hex player key per line, `#` starts a comment.
 *
 *   SEAT=<seat url> [DAYS=7] [TEAM=<file>] [GAMES=nextblock,rock-paper-scissors,btc-updown-15m] [JSON=1] node tools/weekly-testers.mjs
 *
 * A seat that answers too few other seats says so in `seats`: printed, because a low count may then be the seats and not the testers.
 */
import { readFileSync, existsSync } from 'node:fs';

export const teamKeys = (text) => new Set(String(text).split('\n').map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter((l) => /^[0-9a-f]{64}$/.test(l)));

/** The count over one reading per game: each player once, however many games they played; team keys left out and counted apart. */
export function weeklyTesters(boards, team = new Set()) {
  const everyone = new Map(); const left = new Set(); const games = [];
  for (const b of boards) {
    const players = (b.rows || []).filter((r) => Number(r.rounds) > 0);
    const outside = players.filter((r) => !team.has(String(r.player).toLowerCase()));
    for (const r of players) if (team.has(String(r.player).toLowerCase())) left.add(String(r.player).toLowerCase());
    for (const r of outside) { const k = String(r.player).toLowerCase(); everyone.set(k, (everyone.get(k) || 0) + Number(r.rounds)); }
    games.push({ game: b.game, testers: outside.length, teamLeftOut: players.length - outside.length, rounds: outside.reduce((n, r) => n + Number(r.rounds), 0), seats: b.seats || null, agree: b.agree ?? null });
  }
  return { testers: everyone.size, teamLeftOut: left.size, rounds: [...everyone.values()].reduce((a, b) => a + b, 0), games };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const seat = String(env.SEAT || 'http://127.0.0.1:31231').replace(/\/+$/, ''), days = Number(env.DAYS || 7);
  const games = String(env.GAMES || 'nextblock,rock-paper-scissors,btc-updown-15m').split(',').filter(Boolean);
  const team = env.TEAM && existsSync(env.TEAM) ? teamKeys(readFileSync(env.TEAM, 'utf8')) : new Set();
  const boards = [];
  for (const game of games) {
    const r = await fetch(`${seat}/season?game=${encodeURIComponent(game)}&days=${days}&scope=network`, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error(`${game}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    boards.push({ ...(await r.json()), game });
  }
  const c = weeklyTesters(boards, team);
  if (env.JSON) console.log(JSON.stringify({ days, teamKeys: team.size, ...c }));
  else {
    console.log(`weekly testers, ${days} days: ${c.testers} players, ${c.rounds} rounds, ${c.teamLeftOut} team keys left out (${team.size} on the list)`);
    for (const g of c.games) console.log(`  ${g.game}: ${g.testers} players, ${g.rounds} rounds, ${g.teamLeftOut} team, seats ${g.seats ? `${g.seats.answered} of ${g.seats.asked}` : '?'}`);
  }
}
