#!/usr/bin/env node
/**
 * A PUBLISHED RPS GRID'S SEATING, READ LIVE (kanban #345): for every round of the grid file, at its start (+2 s), each seat
 * is asked by GET /seating-batch whether it holds both roles' certificates; at the end one line per minute of starts and a
 * total: rounds certified on every seat at their start, on at least 5, on none.
 *
 *   GRID=<rps-grid-*.json> PORTS=31221,31231,... node tools/grid-seating-live.mjs
 */
import { readFileSync } from 'node:fs';
import { decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const grid = JSON.parse(readFileSync(env.GRID, 'utf8'));
const seats = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const rounds = grid.contracts.map((h) => { const c = decodeRoundContract(fromHex(h)); return { id: toHex(roundId(c)), start: Number(c.startTimeMs) }; }).sort((a, b) => a.start - b.start);
const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
log({ step: 'grid', rounds: rounds.length, firstStart: new Date(rounds[0].start).toISOString(), lastStart: new Date(rounds[rounds.length - 1].start).toISOString() });
const read = async (batch) => {
  const held = new Map(batch.map((r) => [r.id, 0]));
  await Promise.all(seats.map(async (s) => {
    try {
      const r = await fetch(`${s}/seating-batch?rounds=${batch.map((x) => x.id).join(',')}`, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      for (const [id, x] of Object.entries(j.rounds || {})) if (x.cert && x.cert.game && x.cert.settlement) held.set(id, held.get(id) + 1);
    } catch { /* that seat answered nothing: counts as none */ }
  }));
  return held;
};
const out = [];
for (let i = 0; i < rounds.length;) {
  const start = rounds[i].start;
  await wait(start + 2000 - Date.now());
  const batch = [];
  while (i < rounds.length && rounds[i].start <= Date.now() - 2000 && batch.length < 64) batch.push(rounds[i++]);
  const held = await read(batch);
  for (const r of batch) out.push({ ...r, held: held.get(r.id) });
}
const by = new Map();
for (const r of out) { const m = new Date(r.start).toISOString().slice(11, 16); const b = by.get(m) || { all: 0, five: 0, none: 0, n: 0 }; b.n++; if (r.held === seats.length) b.all++; if (r.held >= 5) b.five++; if (r.held === 0) b.none++; by.set(m, b); }
for (const [m, b] of by) log({ minute: m, ...b });
log({ step: 'total', rounds: out.length, onEverySeat: out.filter((r) => r.held === seats.length).length, onAtLeast5: out.filter((r) => r.held >= 5).length, onNone: out.filter((r) => r.held === 0).length });
