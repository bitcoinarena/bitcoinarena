// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PLANNED DOWNTIME (kanban #2773, the owner 2026-11-21): a seat roll or a restart we do ourselves is not an outage. The health watcher
// reads the announced windows (HW_PLANNED_DOWNTIME, default ops/planned-downtime.json: [{ what, fromMs, untilMs, why }], written by
// tools/planned-downtime.mjs) and, where cheap, sees one by itself: a running roll*.service / restart*.service unit or a roll*.sh,
// roll*.mjs, restart*.sh process makes a "seats" window while it runs and HW_PLANNED_AUTO_GRACE_MIN (10) after.
// During a window the "down" problems of the targets it covers stay in the log, titled "planned: ...", with no alert, no Signal and
// no seat restart by the watcher; past untilMs + HW_PLANNED_GRACE_MIN (5) they alert as usual. Money at risk, the load, a failed fix
// and the tip are never covered.
//
// what: "seat 3" (a test-host seat), "mac seat 3" / "fed2 seat 3" (a second-host seat), "seats" (every seat and what the seats
// answer: rounds, duty, seating), "host" or "beelink" (the test-host seats), "fed2" or "mac" (the second-host seats), a gateway's name
// ("gw-c": not read), "gateways", "minerc", "all", or a problem key itself ("seat-down:http://127.0.0.1:31241").

const SEATS_WIDE = /^(seating|not-open|rounds-unread|duty-unread|partly:|posting:)/;

/** The names that cover a problem key (lower case). */
export function coverNames(key, cfg = {}) {
  const k = String(key), out = [k.toLowerCase()];
  const mac = (cfg.mac || []).map(String);
  let m;
  if ((m = /^seat-down:(.+)$/.exec(k))) {
    const base = m[1], port = Number((/:(\d+)(\/|$)/.exec(base.replace(/^https?:\/\//, '')) || [])[1]) || 0;
    const isMac = mac.includes(base) || (port > 6211 && port < 6300);
    if (!isMac && port > 31211 && (port - 31211) % 10 === 0) out.push(`seat ${(port - 31211) / 10}`);
    if (isMac && (port - 6211) % 10 === 0) { const n = (port - 6211) / 10; out.push(`mac seat ${n}`, `fed2 seat ${n}`, `second-host seat ${n}`); }
    out.push('seats', 'all', ...(isMac ? ['fed2', 'mac'] : ['host', 'beelink']));
  } else if ((m = /^flapping:.*@(\d+)/.exec(k))) {
    out.push(`seat ${m[1]}`, 'seats', 'host', 'beelink', 'all');
  } else if (SEATS_WIDE.test(k)) {
    out.push('seats', 'host', 'beelink', 'fed2', 'mac', 'all');
  } else if ((m = /^gateway-unread:(.+)$/.exec(k))) {
    out.push(m[1].toLowerCase(), 'gateways', 'all');
  } else if (/^minerc-unreachable$/.test(k)) {
    out.push('minerc', 'all');
  } else return [];   // never covered: gateway money, load, fix-failed, tip, pending, publications ...
  return out;
}

/** The windows open at `nowMs` (grace included). `list` may be anything the file held. */
export function openWindows(list, nowMs, { graceMs = 5 * 60000 } = {}) {
  return (Array.isArray(list) ? list : []).filter((w) => w && w.what && Number.isFinite(Number(w.untilMs))
    && Number(w.fromMs ?? 0) <= nowMs && nowMs <= Number(w.untilMs) + graceMs);
}

const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);

/**
 * Applies the open windows to one pass's judgement, in place: a covered problem gets alert false, `planned` (the window) and its
 * title "planned: ..."; a covered seat's restart fix is held ("planned downtime"). Answers the problems it covered.
 */
export function applyPlanned(problems, fixes, windows, cfg = {}) {
  const covered = [];
  if (!windows.length) return covered;
  const byWhat = windows.map((w) => ({ w, what: String(w.what).trim().toLowerCase() }));
  const find = (key) => { const names = coverNames(key, cfg); return names.length ? (byWhat.find((x) => names.includes(x.what)) || {}).w : null; };
  for (const p of problems) {
    const w = find(p.key);
    if (!w) continue;
    p.alert = false; p.planned = w;
    p.title = `planned: ${p.title} (${w.what}${w.why ? `, ${w.why}` : ''}, until ${hm(w.untilMs)} UTC)`;
    covered.push(p);
  }
  for (const x of fixes || []) {
    if (x.kind !== 'restart-seat' || !x.base) continue;
    if (find(`seat-down:${x.base}`)) { x.allowed = false; x.blocked = [...(x.blocked || []), 'planned downtime']; }
  }
  return covered;
}

/** The roll or restart jobs running now, from `systemctl --user list-units` lines and `pgrep -af` lines: their names. */
export function rollsIn(unitLines, procLines) {
  const out = [];
  for (const l of String(unitLines || '').split('\n')) { const u = l.trim().replace(/^●\s*/, '').split(/\s+/)[0]; if (/^(roll|restart)[^ ]*\.service$/.test(u)) out.push(u); }
  for (const l of String(procLines || '').split('\n')) { const m = /(?:^|[\s/])((?:roll|restart)[\w.-]*\.(?:sh|mjs))(?:\s|$)/.exec(l); if (m) out.push(m[1]); }
  return [...new Set(out)];
}

/** The automatic window kept in the state: a roll seen this pass opens (or stretches) a "seats" window `graceMs` past now. */
export function autoWindow(prevAuto, rolls, nowMs, { graceMs = 10 * 60000 } = {}) {
  if (rolls && rolls.length) return { what: 'seats', fromMs: prevAuto && prevAuto.untilMs >= nowMs ? prevAuto.fromMs : nowMs, untilMs: nowMs + graceMs, why: `running: ${rolls.join(', ')}`, auto: true };
  return prevAuto && prevAuto.untilMs >= nowMs ? prevAuto : null;
}
