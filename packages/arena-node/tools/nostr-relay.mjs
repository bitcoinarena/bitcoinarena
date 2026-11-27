#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The game's own Nostr relay (src/nostr-relay.js): node tools/nostr-relay.mjs <port> <db file>
import { startRelay } from '../src/nostr-relay.js';
const [port = '29700', dbPath = 'nostr-relay.db'] = process.argv.slice(2);
// kanban #2146, #2214: ARENA_RELAY_KEEP (comma list of 64-hex node keys, the seats') - a full relay never pushes their events out for another author
const keep = String(process.env.ARENA_RELAY_KEEP || '').split(',').map((k) => k.trim()).filter(Boolean);
// kanban #2847: STANDING - the identities the seats' season counts (an entry whose round key is not its player, its amount settled), read from the
// host's own seats (ARENA_RELAY_STANDING_SEATS, comma list of seat base URLs; ARENA_RELAY_STANDING_GAMES, comma list of game names) every 10 min
const standingSeats = String(process.env.ARENA_RELAY_STANDING_SEATS || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
const standingGames = String(process.env.ARENA_RELAY_STANDING_GAMES || 'rock-paper-scissors,nextblock,btc-updown-15m').split(',').map((g) => g.trim()).filter(Boolean);
let standing = new Set();
export async function readStanding(seats = standingSeats, games = standingGames, fetcher = fetch) {
  const got = new Set();
  for (const game of games) {
    for (const base of seats) {
      try {
        let after = '';
        for (let page = 0; page < 200; page++) {
          const j = await (await fetcher(`${base}/season-rounds?game=${encodeURIComponent(game)}&days=90&page=1${after ? `&after=${after}` : ''}`, { signal: AbortSignal.timeout(30000) })).json();
          // A PAID, SETTLED ENTRY ONLY (kanban #3034, audit nostr r3-2): a free round's entry reads payoutMsat '0' and an ENTRY_VOID or no-quorum
          // one a result too, so fresh identities joining free rounds got standing (unevictable keys) without staking anything. An entry counts
          // when its round is not void, it staked (stakeMsat > 0), its amount is settled and its outcome is a played one
          const staked = (v) => typeof v === 'string' && /^[0-9]{1,30}$/.test(v) && BigInt(v) > 0n;
          for (const r of j.rounds || []) { if (r.void) continue; for (const e of r.entries || []) {
            const p = String(e.player || '').toLowerCase(), k = String(e.roundKey || '').toLowerCase();
            if (/^[0-9a-f]{64}$/.test(p) && /^[0-9a-f]{64}$/.test(k) && k !== p && e.payoutMsat !== null && e.payoutMsat !== undefined && e.bot !== true
              && staked(String(e.stakeMsat)) && !/VOID|NO_QUORUM/i.test(String(e.outcome || ''))) got.add(p);
          } }
          if (!j.next) break;
          after = j.next;
        }
        // EVERY LISTED SEAT (kanban #3866, audit r41-nostr-1): one seat's /season-rounds holds only the rounds of the committees it sat on,
        // so stopping at the first seat that answered left every identity staked only in another seat's rounds without standing (evictable
        // by a fresh-key flood). Standing is the union of the staked, settled identities all listed seats serve - no seat drops one alone
      } catch { /* the next seat */ }
    }
  }
  return got;
}
const refresh = async () => { if (!standingSeats.length) return; try { const s = await readStanding(); if (s.size || !standing.size) standing = s;
  console.log(JSON.stringify({ at: new Date().toISOString(), step: 'standing', identities: standing.size })); } catch (e) { console.log(JSON.stringify({ step: 'standing not read', why: String(e.message).slice(0, 120) })); } };
refresh().catch(() => {});   // not awaited: the relay serves at once, standing fills in
setInterval(() => { refresh().catch(() => {}); }, 600000).unref();
const r = await startRelay({ port: Number(port), host: process.env.RELAY_HOST || '127.0.0.1', dbPath, keep, standing: () => standing, pow: process.env.ARENA_RELAY_POW !== '0' });
console.log(JSON.stringify({ at: new Date().toISOString(), step: 'up', port: r.port, db: dbPath }));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await r.close(); process.exit(0); });
