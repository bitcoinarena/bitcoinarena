// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RELEASE'S PERFORMANCE GATE (kanban #928: "performance test ob sich die performance verschlechtert hat. Vergleiche mit alten releases und messe aktiv CPU, disk und
// Memory"). tools/perf-gate.mjs samples a devnet while it plays the same rounds; this reads those samples into one record and holds two records against each other.

/** `ps` cpu time, "[[dd-]hh:]mm:ss[.ss]", in seconds. */
export function cpuSeconds(text) {
  const [days, rest] = String(text).trim().includes('-') ? String(text).trim().split('-') : ['0', String(text).trim()];
  const parts = rest.replace(',', '.').split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return Number(days) * 86400 + parts.reduce((t, n) => t * 60 + n, 0);
}

/**
 * ONE RECORD FROM A RUN'S SAMPLES. A sample: { atMs, storeKb, procs: [{ pid, program, cpuS, rssKb }] }. The cpu of a process is what it used between its first and its last
 * sample, so a process that ended in between still counts what it used; memory is the highest sum seen at one moment.
 */
export function perfRecord({ label, commit = null, plays, samples }) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('a record needs at least two samples');
  if (!(plays > 0)) throw new Error('a record needs at least one play');
  const first = new Map(), last = new Map();
  let rssMaxKb = 0;
  for (const s of samples) {
    rssMaxKb = Math.max(rssMaxKb, s.procs.reduce((t, p) => t + p.rssKb, 0));
    for (const p of s.procs) { if (!first.has(p.pid)) first.set(p.pid, p); last.set(p.pid, p); }
  }
  const cpuByProgram = {};
  for (const [pid, p] of last) { const used = p.cpuS - first.get(pid).cpuS; cpuByProgram[p.program] = (cpuByProgram[p.program] || 0) + used; }
  const round2 = (n) => Math.round(n * 100) / 100;
  const cpuS = Object.values(cpuByProgram).reduce((t, n) => t + n, 0);
  const seconds = (samples.at(-1).atMs - samples[0].atMs) / 1000;
  return { label, commit, plays, seconds: round2(seconds), cpuSeconds: round2(cpuS), cpuPerPlay: round2(cpuS / plays), cores: round2(cpuS / seconds),
    cpuByProgram: Object.fromEntries(Object.entries(cpuByProgram).map(([k, v]) => [k, round2(v)]).sort((a, b) => b[1] - a[1])),
    rssMaxMb: round2(rssMaxKb / 1024), diskGrowthMb: round2((samples.at(-1).storeKb - samples[0].storeKb) / 1024), diskPerPlayMb: round2((samples.at(-1).storeKb - samples[0].storeKb) / 1024 / plays) };
}

export const PERF_MEASURES = Object.freeze({ cpuPerPlay: 'CPU per play', rssMaxMb: 'memory', diskPerPlayMb: 'disk per play' });
/** Allowed growth against the older release: 15 %, past what two runs of one build differ by. Under `floor` a measure says nothing: a few MB or a tenth of a second is noise. */
export const PERF_LIMIT = 1.15;
const FLOORS = { cpuPerPlay: 1, rssMaxMb: 64, diskPerPlayMb: 1 };

/** THE GATE: { ok, rows: [{ measure, name, before, now, ratio, worse }] }. A release passes when no measure grew past the limit. */
export function comparePerf(before, now, { limit = PERF_LIMIT } = {}) {
  const rows = Object.entries(PERF_MEASURES).map(([measure, name]) => {
    const a = Number(before[measure]), b = Number(now[measure]);
    const ratio = a > 0 ? Math.round((b / a) * 100) / 100 : null;
    return { measure, name, before: a, now: b, ratio, worse: Math.max(a, b) >= FLOORS[measure] && (a > 0 ? b / a > limit : b > 0) };
  });
  return { ok: !rows.some((r) => r.worse), rows };
}
