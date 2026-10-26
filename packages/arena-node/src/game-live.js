// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW MANY PLAY EACH GAME HERE NOW (2026-10-11: "Anzeigen wieviele nodes das haben und wieviele spieler
// insgesamt drin sind"): per game this seat hosts, the rounds that are live now - open for entries or running - and the
// players entered in them, from this seat's own round store - live from the seating close (start - 120 s) to the end. Each round's contract is read once (by rowid), the entries
// counted with one query; the answer is kept 10 s, so GET /games stays cheap however often the chooser asks.
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { SEATING_LEAD_MS } from '../../arena-protocol/src/seating.js';

const KEPT_MS = 10000;

// A ROUND NO COMMITTEE CAN BE DRAWN FOR IS NOT LIVE (kanban #685, 2026-10-26 08:3xZ, the owner: "Why are no rounds open?"): Up/Down's
// version 24 day grid named a census root of the branch the chain left, so none of its 8 windows could be drawn, yet they counted as
// live; the chooser shows the newest version with a live round, so the page opened version 24 - "No window is open" - while version
// 13's emergency grid had a drawn window every 15 min. `drawable(roundHex)` answers whether its committee is drawn; a no is asked
// again after a minute, a yes is kept.
const UNDRAWN_ASK_MS = 60000;

export function gameLive(round, { nowMs = () => Date.now(), windowOf = () => null, drawable = null } = {}) {
  const db = round.db;
  const rounds = new Map();        // round id hex -> { game, open: bigint, end: bigint }
  let lastRow = 0;
  let kept = null;
  const index = () => {
    // a round live now was stored at most a series' lead before it (72 h): older rows are not read at all
    for (const r of db.prepare('SELECT rowid, round_id, contract FROM rounds WHERE rowid > ? AND opened_ms > ? ORDER BY rowid').all(lastRow, nowMs() - 4 * 86400000)) {
      lastRow = r.rowid;
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      const run = BigInt(c.blockTicks || 0) * 1000n / 60n;
      // LIVE from its seating close (start - 120 s, §5A.7: the first moment it takes an entry), not from its committee time:
      // a series is drawn up to 72 h ahead, and counting from there showed 1,266 "live" Tick Tock rounds
      // A MARKET from its window's start (2026-10-11): it takes no order before it
      const w = windowOf(c);
      const open = w ? w.startMs : c.startTimeMs - SEATING_LEAD_MS > c.committeeTimeMs ? c.startTimeMs - SEATING_LEAD_MS : c.committeeTimeMs;
      // TO ITS LAST ENTRY'S RUN (2026-10-14 ~08:45Z: Tick Tock "shows no open round"): a round taking entries after its
      // start - the late join, a Tick Tock round's six hours - is live until its entry close plus one run, not its start plus one
      const lastRunEnd = c.entryCloseMs > c.startTimeMs ? c.entryCloseMs + run : c.startTimeMs + run;
      rounds.set(toHex(new Uint8Array(r.round_id)), { game: toHex(c.gameId), open, end: lastRunEnd + 30000n });
    }
  };
  /** { [gameId hex]: { rounds, players } } - the rounds live now and the players entered in them. */
  return function live() {
    const now = BigInt(nowMs());
    if (kept && Number(now) - kept.at < KEPT_MS) return kept.by;
    index();
    const by = {};
    for (const [id, r] of rounds) {
      if (r.end < now - 3600000n) { rounds.delete(id); continue; }      // long over: never live again
      if (now < r.open || now > r.end) continue;
      if (drawable && r.drawn !== true) {
        if (r.drawn === undefined || Number(now) - r.askedAt >= UNDRAWN_ASK_MS) {
          let ok = false; try { ok = !!drawable(id); } catch { ok = false; }
          r.drawn = ok; r.askedAt = Number(now);
        }
        if (!r.drawn) continue;
      }
      (by[r.game] = by[r.game] || { rounds: 0, players: 0 }).rounds++;
    }
    for (const e of db.prepare('SELECT e.round_id, COUNT(*) AS n FROM entries e JOIN rounds r ON r.round_id = e.round_id WHERE r.closed_ms IS NULL AND e.joined_ms > ? GROUP BY e.round_id').all(Number(now) - 3 * 3600000)) {
      const r = rounds.get(toHex(new Uint8Array(e.round_id)));
      if (!r || now < r.open || now > r.end || (drawable && r.drawn !== true)) continue;
      (by[r.game] = by[r.game] || { rounds: 0, players: 0 }).players += Number(e.n);
    }
    kept = { at: Number(now), by };
    return by;
  };
}
