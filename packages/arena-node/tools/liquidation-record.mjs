#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LIQUIDATION PAID BEFORE THE ARBITER KEPT EVERY STEP, COMPLETED IN ITS STATE ONCE (kanban #723): T2's liquidation (9919a571, rehearsal 17)
// was paid on 2026-10-24/26 by an arbiter that kept only the remainder's payee count ("44") and no times. Its event (arbitration-events.js)
// names every payee and every step, so this writes into the arbiter's state file what was measured then: the remainder's payees from
// who-got (its census rebuilt at the payment's height and checked against the guardians' contract ids, one JSON line
// { height, payees: [{ part, key, msat, contractId, outIdx }] }), the escrow's amount and the times of its steps. Only what the state lacks
// is written; with --dry it prints the result and writes nothing. Run it while the arbiter is stopped: the arbiter writes its state from memory.
//
//   node tools/liquidation-record.mjs <state.json> <federation hex> <who-got JSON file> [--escrow-sats N] [--first ISO] [--escrow-at ISO]
//        [--claimed-at ISO] [--paid-at ISO] [--remainder-at ISO] [--dry]
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function completeLiquidation(state, fid, got, { escrowSats = null, first = null, escrowAt = null, claimedAt = null, paidAt = null, remainderAt = null } = {}) {
  const v = state.liquidations && state.liquidations[fid];
  if (!v) throw new Error(`the state keeps no liquidation of ${fid}`);
  const ms = (iso) => { if (!iso) return null; const t = Date.parse(iso); if (!Number.isFinite(t)) throw new Error(`not a time: ${iso}`); return t; };
  const did = [];
  if (got && !v.remainderPayouts) {
    if (!v.remainderTxid) throw new Error('that liquidation paid no remainder');
    const payees = got.payees || [];
    const sum = payees.reduce((t, p) => t + BigInt(p.msat), 0n);
    if (String(sum) !== String(v.remainderMsat)) throw new Error(`the payees come to ${sum} msat, and the remainder paid was ${v.remainderMsat}`);
    if (v.remainderPayees !== undefined && payees.length !== Number(v.remainderPayees)) throw new Error(`${payees.length} payees, and the state says ${v.remainderPayees}`);
    v.remainderPayouts = payees.map((p) => ({ part: p.part, payoutPk: String(p.key).toLowerCase(), msat: String(p.msat), outIdx: Number.isInteger(p.outIdx) && p.outIdx >= 0 ? p.outIdx : null,
      txid: v.remainderTxid }));
    did.push(`remainderPayouts: ${payees.length}`);
  }
  if (escrowSats !== null && v.escrowSats === undefined) { v.escrowSats = String(BigInt(escrowSats)); did.push(`escrowSats: ${v.escrowSats}`); }
  for (const [k, iso] of [['escrowAtMs', escrowAt], ['claimedAtMs', claimedAt], ['remainderAtMs', remainderAt]]) {
    if (iso && v[k] === undefined) { v[k] = ms(iso); did.push(`${k}: ${iso}`); }
  }
  if (paidAt) for (const p of v.payouts || []) if (p.atMs === undefined) { p.atMs = ms(paidAt); did.push(`payout ${String(p.txid).slice(0, 8)} atMs: ${paidAt}`); }
  if (first) {
    state.events = state.events || {};
    const e = state.events[`liquidation:${fid}`] = state.events[`liquidation:${fid}`] || {};
    if (!Number.isFinite(e.firstMs)) { e.firstMs = ms(first); did.push(`firstMs: ${first}`); }
  }
  return did;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, fid, gotFile] = process.argv.slice(2);
  if (!file || !/^[0-9a-f]{64}$/.test(String(fid))) { console.error('node tools/liquidation-record.mjs <state.json> <federation hex> <who-got JSON file> [options]'); process.exit(2); }
  const opt = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const got = gotFile && !gotFile.startsWith('--') ? JSON.parse(readFileSync(gotFile, 'utf8').split('\n').find((l) => l.startsWith('{'))) : null;
  const did = completeLiquidation(state, fid, got, { escrowSats: opt('escrow-sats'), first: opt('first'), escrowAt: opt('escrow-at'), claimedAt: opt('claimed-at'),
    paidAt: opt('paid-at'), remainderAt: opt('remainder-at') });
  console.log(JSON.stringify({ federation: fid, did }));
  if (process.argv.includes('--dry')) { console.log(JSON.stringify(state.liquidations[fid], null, 1)); process.exit(0); }
  if (did.length) { writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1)); renameSync(`${file}.tmp`, file); }
}
