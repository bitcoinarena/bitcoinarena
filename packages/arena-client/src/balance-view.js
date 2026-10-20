// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BALANCE, FEDERATION BY FEDERATION (kanban #545, 2026-10-19 ~22:20Z: "A click on the balance in the ui opens a popup where the user
// can see on what federations the funds are, also if the federation is healthy. If the federation is offline it displays the approx time
// till the user will be reimbursed, in both blocks and estimated time. For debug purposes (advanced settings has a toggle for that) the
// modal shows all federations, its capacity, and a button to deposit into that exact federation"). What the page's balance popup says
// about each federation, from the status the page verified (federations.js federationStatuses): its health, and for a HALTED one when
// its notes are paid - §23A.5: liquidated `abandon_blocks` after the halt, paid at the end of the `claim_blocks` window
// (federation-slash.js liquidationSchedule) - in blocks, and in time at the chain's recent pace.
import { liquidationSchedule, clocksFor, MAINNET_CLOCKS } from '../../arena-protocol/src/federation-slash.js';

/** A federation's health for the popup: { level: 'ok' | 'warn' | 'bad' | 'idle', label, note }. */
export function federationHealth(st) {
  const status = st && st.status;
  const succ = st && st.successorId ? `federation ${String(st.successorId).slice(0, 8)}…` : 'a healthy federation';
  if (status === 'OPEN') return { level: 'ok', label: 'Healthy', note: '' };
  if (status === 'DRAINING') return { level: 'warn', label: 'Draining', note: `A guardian left. Your funds move to ${succ} by themselves.` };
  if (status === 'CRITICAL') return { level: 'warn', label: 'Critical', note: `One more guardian lost halts it. Your funds move to ${succ} by themselves.` };
  if (status === 'HALTED') return { level: 'bad', label: 'Offline (halted)', note: 'Every note is frozen until its guardians return or it is liquidated.' };
  if (status === 'CLOSED') return { level: 'idle', label: 'Closed', note: `Its successor holds everything: ${succ}.` };
  return { level: 'idle', label: 'Not checked yet', note: '' };
}

/** Seconds as the popup says them: minutes under 90, hours under 48, else days. */
export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

/**
 * THE CHAIN'S RECENT PACE: the median gap between consecutive blocks of an Esplora `/blocks` answer (newest first, each with
 * `timestamp`), held between 30 s and 2 h; 600 s when there is nothing to measure. Block times can run out of order, so the median.
 */
export function medianBlockSeconds(blocks) {
  const t = (Array.isArray(blocks) ? blocks : []).map((b) => Number(b && b.timestamp)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a);
  const gaps = [];
  for (let i = 1; i < t.length; i++) gaps.push(t[i - 1] - t[i]);
  if (!gaps.length) return 600;
  gaps.sort((a, b) => a - b);
  const m = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  return Math.min(7200, Math.max(30, m));
}

/**
 * WHEN A HALTED FEDERATION'S PLAYERS ARE PAID BACK: { ok, paysAt (height), blocks (left), seconds, line }, or { ok: false } for a
 * federation that is not HALTED. The halt is the height of its HALTED record; `tip` the chain's height now; `network` names its clocks.
 */
export function reimbursementOf({ status, tip, network = 'mainnet', secondsPerBlock = 600 }) {
  if (!status || status.status !== 'HALTED') return { ok: false, why: 'only a halted federation is paid back' };
  const haltHeight = Number(status.height);
  if (!Number.isInteger(haltHeight) || tip === null || tip === undefined || tip === '' || !Number.isInteger(Number(tip))) return { ok: false, why: 'the halt height or the tip is not known yet' };
  const c = clocksFor(network);
  const s = liquidationSchedule({ haltHeight, clocks: c.ok ? c.clocks : MAINNET_CLOCKS });
  if (!s.ok) return { ok: false, why: s.why };
  const paysAt = Number(s.claimWindowCloses);
  const blocks = Math.max(0, paysAt - Number(tip));
  const seconds = blocks * secondsPerBlock;
  return { ok: true, paysAt, blocks, seconds,
    line: blocks === 0 ? `Paid back now: the claim window closed at block ${paysAt.toLocaleString('en-US')}.`
      : `Paid back in about ${blocks.toLocaleString('en-US')} blocks (~${humanDuration(seconds)}), at block ${paysAt.toLocaleString('en-US')}.` };
}

/** A federation's capacity for the debug rows: its signed reserve and exposure cap, the room left, and the load. */
export function capacityOf(st) {
  const reserve = Number(st && st.reserveSats || 0), cap = Number(st && st.exposureCapSats || 0);
  return { reserve, cap, headroom: Math.max(0, cap - reserve), load: typeof (st && st.load) === 'number' ? st.load : null };
}

/** The Esplora base this browser reads a network's chain from: `arena.explorer` when it names one (or `off`), else mempool.space. */
export function explorerBaseFor(network, said = null) {
  if (said === 'off') return null;
  if (said && /^https:\/\//.test(said)) return said.replace(/\/+$/, '');
  return network === 'testnet4' ? 'https://mempool.space/testnet4/api' : network === 'mainnet' ? 'https://mempool.space/api' : null;
}
