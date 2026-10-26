// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN UPDATE'S PROGRESS, 0 TO 100 % (kanban #706: the macOS app showed "Updating your node..." with a bar that moved and meant nothing).
// update.js and auto-update.js report { pct, step, detail } at each real step - the download by its bytes - and once at the end
// { done } or { failed, why }. One line says it, the same everywhere:
//
//     [#####-----]  45 %  Unpacking 2026.1.9.9
//
// In a terminal the line is redrawn in place (\r); anywhere else (the auto update service's log, the desktop apps, which read the update's
// output) one line per step, and within a step one per 5 %. The macOS app and the Windows window read these lines (progressOf).

/** The line of one report: the bar of `width`, the percent, the step and what it is at. */
export function progressLine({ pct = 0, step = '', detail = '', failed = false, why = '' }, width = 10) {
  const p = Math.max(0, Math.min(100, Math.floor(pct)));
  const full = Math.round((p / 100) * width);
  const text = failed ? `Failed at "${step}": ${why || 'no reason given'}` : detail ? `${step} (${detail})` : step;
  return `[${'#'.repeat(full)}${'-'.repeat(width - full)}] ${String(p).padStart(3)} %  ${text}`;
}

/** A progress line read back: { pct, text } or null (the desktop apps parse the same). */
export function progressOf(line) {
  const m = /^\[[#-]+\]\s+(\d{1,3}) %  (.*)$/.exec(String(line).replace(/^\r/, '').trimEnd());
  return m ? { pct: Number(m[1]), text: m[2] } : null;
}

/** Megabytes for a download's line: "12 of 48 MB". */
export const mbOf = (got, total) => `${Math.floor(got / 1e6)} of ${Math.max(1, Math.round(total / 1e6))} MB`;

/**
 * The reporter: `report(p)` takes each report and writes it. `tty` redraws one line with `write` (no newline until the end); otherwise
 * each new step, every 5 % within one, and the end go to `line`. `line(text)` also prints a plain line between them (in a terminal the
 * bar is cleared first and drawn again under it).
 */
export function progressBar({ tty = false, write = (t) => process.stdout.write(t), line = (l) => console.log(l), everyPct = 5 } = {}) {
  let last = null, shown = null, drawn = false;
  const report = (p) => {
    if (!p) return;
    const end = !!(p.done || p.failed);
    const pct = end && p.done ? 100 : Math.max(last ? last.pct : 0, Math.floor(p.pct ?? 0));
    const now = { ...p, pct, ...(p.done ? { step: 'Done', detail: '' } : {}) };
    last = now;
    const text = progressLine(now);
    if (tty) { write(`\r\x1b[K${text}${end ? '\n' : ''}`); drawn = !end; return; }
    if (!shown || end || now.step !== shown.step || now.pct >= shown.pct + everyPct) { line(text); shown = now; }
  };
  return {
    report,
    line: (l) => { if (tty && drawn) write(`\r\x1b[K${l}\n${progressLine(last)}`); else line(l); },
    get last() { return last; },
  };
}

/** Reports of a part of the whole: its 0..100 laid onto from..to (an update's node move is 60-100 % of a download's whole). */
export const within = (report, from, to) => (p) => report({ ...p, pct: from + ((p.pct ?? 0) / 100) * (to - from) });
