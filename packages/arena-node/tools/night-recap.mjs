#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE TESTNET NIGHT RECAP (kanban #926 item 12): after a night, its players, rounds and top 3, and a text ready for Nostr. Read from the seats' signed rounds and merged as
 * the network board merges them (a round counts when SEASON_NETWORK_AGREE seats hand in the same account), then counted by season() over the night's window alone.
 * Team and bot keys are left out of the players and of the top 3 (a kept list as tools/weekly-testers.mjs reads). A name goes in the text only with that player's consent:
 * CONSENT is one 64-hex key per line, `#` starts a comment; everybody else in the top 3 is "a tester". Nobody is tagged.
 *
 *   FROM=<ISO time> TO=<ISO time> SEATS=<url,url,...> [GAMES=a,b,c] [TEAM=<file>] [CONSENT=<file>] [LINK=<url>] [JSON=1] node tools/night-recap.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { season, mergeSeasonAccounts, seasonRoundsFromJson, SEASON_NETWORK_AGREE, DAY_MS } from '../../arena-protocol/src/season.js';
import { teamKeys } from './weekly-testers.mjs';

const GAME_TITLE = { nextblock: 'Tick Tock, Next Block', 'rock-paper-scissors': 'Rock Paper Scissors', 'btc-updown-15m': 'Bitcoin Up or Down' };

/** The night out of the agreed rounds of each game: its counts and the top 3 by wins, then net, as the board ranks. */
export function recapOf(games, { fromMs, toMs, team = new Set(), consent = new Set() }) {
  const everyone = new Set(), out = [];
  let rounds = 0; const best = [];
  for (const g of games) {
    const s = season(g.rounds, { games: g.ids, fromMs, toMs });
    if (!s.ok) throw new Error(s.why);
    const rows = s.rows.filter((r) => !team.has(String(r.player).toLowerCase()));
    for (const r of rows) { everyone.add(String(r.player).toLowerCase()); best.push({ ...r, game: g.game }); }
    const count = (s.rounds ?? 0);
    rounds += count; out.push({ game: g.game, rounds: count, players: rows.length });
  }
  const byPlayer = new Map();
  for (const r of best) { const k = String(r.player).toLowerCase(); const x = byPlayer.get(k) || { player: k, name: r.name, wins: 0, rounds: 0, netMsat: 0n }; x.wins += r.wins; x.rounds += r.rounds; x.netMsat += BigInt(r.netMsat); byPlayer.set(k, x); }
  const top = [...byPlayer.values()].sort((a, b) => b.wins - a.wins || (b.netMsat > a.netMsat ? 1 : b.netMsat < a.netMsat ? -1 : 0) || (a.player < b.player ? -1 : 1)).slice(0, 3)
    .map((x, i) => ({ place: i + 1, wins: x.wins, rounds: x.rounds, named: consent.has(x.player) && x.name ? x.name : 'a tester' }));
  return { players: everyone.size, rounds, games: out, top };
}

/** The note, in plain words; nothing it cannot back: no top 3 line with no winner. */
export function recapText(r, { link = 'https://bitcoinarena.io/night' } = {}) {
  const games = r.games.filter((g) => g.rounds).map((g) => `${GAME_TITLE[g.game] || g.game}: ${g.rounds}`).join(', ');
  const lines = [`Testnet Night recap: ${r.players} ${r.players === 1 ? 'player' : 'players'}, ${r.rounds} ${r.rounds === 1 ? 'round' : 'rounds'}.`];
  if (games) lines.push(`Rounds by game. ${games}.`);
  const won = r.top.filter((t) => t.wins > 0);
  if (won.length) lines.push(`Top ${won.length}: ${won.map((t) => `${t.place}. ${t.named} (${t.wins} ${t.wins === 1 ? 'win' : 'wins'})`).join(', ')}.`);
  lines.push('Every result was signed 5 of 7, on testnet4, for test sats.', `Next one: ${link}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const fromMs = Date.parse(env.FROM), toMs = Date.parse(env.TO);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) { console.error('FROM and TO: the night, as ISO times'); process.exit(2); }
  const seats = String(env.SEATS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const names = String(env.GAMES || 'nextblock,rock-paper-scissors,btc-updown-15m').split(',').filter(Boolean);
  const list = (f) => (f && existsSync(f) ? teamKeys(readFileSync(f, 'utf8')) : new Set());
  const days = Math.min(90, Math.ceil((Date.now() - fromMs) / DAY_MS) + 1);
  const games = [];
  for (const game of names) {
    const bySeat = new Map(); const ids = new Set();
    await Promise.all(seats.map(async (seat) => {
      try {
        const r = await fetch(`${seat}/season-rounds?game=${encodeURIComponent(game)}&days=${days}`, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) return;
        const j = await r.json();
        for (const x of (j.game && j.game.ids) || []) ids.add(String(x).toLowerCase());
        bySeat.set(seat, seasonRoundsFromJson(j.rounds));
      } catch { /* a seat that does not answer adds nothing */ }
    }));
    const m = mergeSeasonAccounts(bySeat, { agree: SEASON_NETWORK_AGREE });
    if (!m.ok) throw new Error(m.why);
    games.push({ game, ids: [...ids], rounds: m.rounds, seats: bySeat.size });
  }
  const r = recapOf(games.filter((g) => g.ids.length), { fromMs, toMs, team: list(env.TEAM), consent: list(env.CONSENT) });
  const text = recapText(r, env.LINK ? { link: env.LINK } : {});
  console.log(env.JSON ? JSON.stringify({ ...r, seats: games.map((g) => [g.game, g.seats]), text }) : text);
}
