// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW LONG THIS NODE WAS UP (kanban #756, a tester in Arena Chat 1385: "Show the 24h uptime that is important for node inclusion ...
// and also when it is not reached. Also display 7d uptime and 30d uptime and all time uptime").
//
// WHAT IS KEPT: before this the node kept no record of its own running - no start or stop mark, no heartbeat of its own on this line.
// So from this release on it keeps one: `uptime_spans`, one row per stretch it ran, (start_ms, end_ms). While it runs it moves the
// newest row's end to now every UPTIME_TICK_MS; a start within UPTIME_GAP_MS of the newest row's end continues that row (a restart of
// seconds is not an outage), a later start opens a new row. A crash loses at most one tick. Nothing older than the first row is known,
// and nothing is estimated for it: a window that reaches back past the first row is the share of the time since the first row, and
// says so ("since <date>").
//
// WHAT THE 24 H MEANS FOR THE DRAW (multiplayer_p2p.md §5A.3 "Absent from its seatings", protocol 22, kanban #727): from protocol 22
// only nodes seen in the 24 h before the census are drawn. A node is seen when it is listed at one seating or one heartbeat slot (one per
// round, every 15 min on a 15-min grid); it is left out only when certificates prove it missed 3 of them at least 1 h apart and it was
// seen at none. In uptime terms: a node that ran without a break for one heartbeat interval (UPTIME_SLOT_MS) in the last 24 h was up at
// a slot's close and is kept; one that did not was seen nowhere and is left out of the next census (its bond untouched) until it is.
// Before protocol 22 (2026.1.9.x) uptime decides no draw (§5A.3 "Deliberately NOT eligibility criteria"): a drawn node that is down
// only loses that seat to a reserve and its fee share - the figure is shown with the rule it will meet from 2.0.
export const UPTIME_TICK_MS = 60000;
export const UPTIME_GAP_MS = 3 * 60000;
/** One heartbeat interval: a 15-min grid closes a heartbeat slot every 15 min (heartbeat.js, HEARTBEAT_SLOTS_PER_ROUND = 1). */
export const UPTIME_SLOT_MS = 15 * 60000;
const DAY = 86400000;
/** The four figures: key, label, length (null: all the time kept). */
export const UPTIME_WINDOWS = Object.freeze([['24h', '24 h', DAY], ['7d', '7 days', 7 * DAY], ['30d', '30 days', 30 * DAY], ['all', 'All time', null]]);

/** The time `spans` [{ startMs, endMs }] cover inside (fromMs, toMs], each span clipped. */
export function upWithin(spans, fromMs, toMs) {
  let up = 0;
  for (const s of spans || []) {
    const a = Math.max(Number(s.startMs), fromMs), b = Math.min(Number(s.endMs), toMs);
    if (b > a) up += b - a;
  }
  return up;
}

/**
 * THE FIGURES off the spans at `nowMs`: for each window its start, the time it is read over (from the first span on when the record is
 * younger than the window: `partial`), the time up and the share (null while nothing is kept).
 */
export function uptimeFigures(spans, nowMs) {
  const list = [...(spans || [])].map((s) => ({ startMs: Number(s.startMs), endMs: Math.min(Number(s.endMs), nowMs) })).filter((s) => s.endMs >= s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const sinceMs = list.length ? list[0].startMs : null;
  const windows = UPTIME_WINDOWS.map(([key, label, len]) => {
    const fromMs = len === null ? (sinceMs ?? nowMs) : nowMs - len;
    const readFromMs = sinceMs === null ? nowMs : Math.max(fromMs, sinceMs);
    const ofMs = Math.max(0, nowMs - readFromMs);
    const upMs = upWithin(list, readFromMs, nowMs);
    return { key, label, fromMs, readFromMs, ofMs, upMs, share: ofMs > 0 ? Math.min(1, upMs / ofMs) : null, partial: len !== null && sinceMs !== null && sinceMs > fromMs };
  });
  return { nowMs, sinceMs, spans: list.length, windows };
}

/**
 * THE 24 H THE DRAW READS, in uptime terms (above): met when a span ran unbroken for UPTIME_SLOT_MS inside the last 24 h. When it is not
 * met and the node runs now (`runningSinceMs`), it is met again UPTIME_SLOT_MS after this run started; `lastMetMs` the newest moment
 * the 24 h was met (the end of the newest long enough span), and `lapsesAtMs` when, without a further run, it stops being met.
 */
export function inclusionByUptime(spans, nowMs, { slotMs = UPTIME_SLOT_MS, runningSinceMs = null } = {}) {
  const from = nowMs - DAY;
  let best = 0, lastMetMs = null;
  for (const s of spans || []) {
    const a = Math.max(Number(s.startMs), from), b = Math.min(Number(s.endMs), nowMs);
    if (b - a > best) best = b - a;
    if (Number(s.endMs) - Number(s.startMs) >= slotMs) lastMetMs = Math.max(lastMetMs ?? 0, Math.min(Number(s.endMs), nowMs));
  }
  const met = best >= slotMs;
  const metAgainAtMs = met ? null : runningSinceMs !== null ? Math.max(nowMs, Number(runningSinceMs) + slotMs) : null;
  return { met, needMs: slotMs, longestRunMs: best, metAgainAtMs, lastMetMs, lapsesAtMs: lastMetMs === null ? null : lastMetMs + DAY };
}

/**
 * THE RECORD in this node's store: `db` a better-sqlite3 handle. `start()` opens (or continues) the run and ticks; `figures()` reads
 * the four windows and the 24 h test at now. `inForce` says whether this line's draw reads the 24 h (protocol 22 on).
 */
export function createUptime({ db, nowMs = () => Date.now(), tickMs = UPTIME_TICK_MS, gapMs = UPTIME_GAP_MS, inForce = false, rule = null }) {
  db.exec('CREATE TABLE IF NOT EXISTS uptime_spans (start_ms INTEGER PRIMARY KEY, end_ms INTEGER NOT NULL)');
  const newest = db.prepare('SELECT start_ms, end_ms FROM uptime_spans ORDER BY start_ms DESC LIMIT 1');
  const open = db.prepare('INSERT OR REPLACE INTO uptime_spans (start_ms, end_ms) VALUES (?, ?)');
  const move = db.prepare('UPDATE uptime_spans SET end_ms = ? WHERE start_ms = ?');
  const all = db.prepare('SELECT start_ms, end_ms FROM uptime_spans ORDER BY start_ms');
  let runStartMs = null, spanStartMs = null, timer = null;
  const tick = () => {
    if (spanStartMs === null) return;
    try { move.run(nowMs(), spanStartMs); } catch { /* the store closed under a stopping node */ }
  };
  return {
    start() {
      const now = nowMs();
      const last = newest.get();
      runStartMs = now;
      if (last && now - Number(last.end_ms) <= gapMs && now >= Number(last.end_ms)) { spanStartMs = Number(last.start_ms); move.run(now, spanStartMs); runStartMs = spanStartMs; }
      else { spanStartMs = now; open.run(now, now); }
      if (tickMs > 0) { timer = setInterval(tick, tickMs); if (timer.unref) timer.unref(); }
      return this;
    },
    stop() { tick(); if (timer) clearInterval(timer); timer = null; },
    tick,
    spans() { return all.all().map((r) => ({ startMs: Number(r.start_ms), endMs: Number(r.end_ms) })); },
    /** The figures at now, the running span counted to now. `seen` (protocol 22): what the presence book says of this node's 24 h. */
    figures({ seen = null } = {}) {
      const now = nowMs();
      const spans = this.spans().map((s) => (s.startMs === spanStartMs ? { ...s, endMs: Math.max(s.endMs, now) } : s));
      const f = uptimeFigures(spans, now);
      const inc = inclusionByUptime(spans, now, { runningSinceMs: runStartMs });
      // A CERTIFICATE THAT LISTS THIS NODE in the 24 h is the rule's own proof that it was seen: met, whatever the uptime says
      const met = inc.met || seen === true;
      return { ...f, runningSinceMs: runStartMs, inclusion: { ...inc, met, metAgainAtMs: met ? null : inc.metAgainAtMs, seen, inForce, rule } };
    },
  };
}
