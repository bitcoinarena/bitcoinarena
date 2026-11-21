// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY MONEY-LOSS WATCH (kanban #2773, the owner 2026-11-14: "Koennen wir das im Code bei uns fixen dass sowas schneller auffaellt
// und wir eine Warnung im owner dashboard anzeigen?"). Why: gateway C lost the use of ~112M sat between 11-08 and 11-14 and nobody saw
// it for six days (#2771). Its database had been rolled back 13 hours by a copy (10-31), so it still held notes the federation had seen
// spent; every incoming payment funded with one was rejected "The note is already spent", and the stock mintv2 refund of that rejected
// spend - all inputs at once - was rejected too, stranding every other note of it (upstream PR fedimint#9497). The signs were all
// there: ten `incoming-payment-failed` events with that error, a balance that dropped with no payment to explain it, and notes in the
// wallet the guardians count as spent. This file reads and judges them - read-only, nothing here pays, moves or restarts anything:
//   1. the gateway's payment log (POST /v1/payment_log, per federation): failed payments in the last 24 h, "already spent" by name,
//      e-cash receives the federation rejected, and what the failed incoming payments were worth
//   2. the balance against the payments: between two readings the e-cash balance must move by what the payments explain - an incoming
//      payment funds its contract (-), a failed one is refunded (+), an outgoing one is claimed (+), e-cash sent (-) and received (+);
//      a drop beyond that, over `dropMsat`, is money that left with no payment
//   3. dead notes: the wallet's spendable notes against the guardians' spent set (deadNotes, run by tools/gateway-dead-notes.mjs on a
//      copy of the gateway's database - the gateway API lists no notes)
// and `gatewayWarning` turns them into one line per gateway, red when any of them is above zero.

const DAY = 86400000;
export const WATCH_WINDOW_MS = DAY;
export const DROP_MSAT = 1000000n;   // 1,000 sat: a drop the payments do not explain, beyond the federation's per-transaction fees

const big = (x) => { try { return BigInt(x ?? 0); } catch { return 0n; } };
const imageOf = (p) => { const i = p && (p.payment_image || (p.incoming_contract_commitment && p.incoming_contract_commitment.payment_image) || (p.outgoing_contract && p.outgoing_contract.payment_image));
  return i ? JSON.stringify(i) : null; };
const msOf = (e) => Math.floor(Number(e.ts_usecs || 0) / 1000);
export const ALREADY_SPENT = /already spent/i;

/**
 * The gateway's payment log of one federation, newest first, back to `sinceMs` (or `maxPages` pages). `post(path, body)` is the
 * gateway's authenticated POST. Each page ends where the last one stopped (end_position = its oldest id); ids are kept once.
 */
export async function readPaymentLog(post, federationId, { sinceMs, pageSize = 200, maxPages = 10 } = {}) {
  const out = [], seen = new Set();
  let end = null;
  for (let page = 0; page < maxPages; page++) {
    const got = await post('/v1/payment_log', { federation_id: federationId, pagination_size: pageSize, end_position: end, event_kinds: [] });
    const evs = Array.isArray(got) ? got : [];
    let fresh = 0, oldest = null;
    for (const e of evs) {
      if (e == null || e.id == null || seen.has(String(e.id))) continue;
      seen.add(String(e.id)); out.push(e); fresh++;
      if (oldest === null || Number(e.id) < Number(oldest)) oldest = e.id;
    }
    if (!fresh || evs.length < pageSize || oldest === null) break;
    if (sinceMs != null && evs.some((e) => msOf(e) < sinceMs)) break;
    end = oldest;
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}

/**
 * 1. WHAT FAILED in the window: { failed, alreadySpent, rejectedReceives, failedMsat, lastAtMs, lastError } - `failedMsat` is what the
 * failed incoming payments were worth (their contracts, from the matching `incoming-payment-started`).
 */
export function failuresOf(events, { nowMs = Date.now(), windowMs = WATCH_WINDOW_MS } = {}) {
  const started = new Map();
  for (const e of events) if (e.kind === 'incoming-payment-started') { const k = imageOf(e.payload); if (k) started.set(k, big(e.payload.incoming_contract_commitment && e.payload.incoming_contract_commitment.amount)); }
  const r = { failed: 0, alreadySpent: 0, rejectedReceives: 0, failedMsat: '0', lastAtMs: null, lastError: null };
  let msat = 0n;
  for (const e of events) {
    const at = msOf(e);
    if (at < nowMs - windowMs || at > nowMs + 60000) continue;
    const p = e.payload || {};
    const failed = /-failed$/.test(e.kind || '') || (e.kind === 'payment-receive-update' && p.status === 'Rejected');
    if (!failed) continue;
    r.failed++;
    if (e.kind === 'payment-receive-update') r.rejectedReceives++;
    if (ALREADY_SPENT.test(String(p.error || ''))) r.alreadySpent++;
    if (e.kind === 'incoming-payment-failed') msat += started.get(imageOf(p)) || 0n;
    if (r.lastAtMs === null || at > r.lastAtMs) { r.lastAtMs = at; r.lastError = p.error ? String(p.error).slice(0, 160) : (p.status || e.kind); }
  }
  r.failedMsat = String(msat);
  return r;
}

/**
 * 2. WHAT THE PAYMENTS EXPLAIN between two readings (fromMs, toMs]: the e-cash the balance should have moved by. `events` must reach
 * back to the starts of the payments that end in the interval (the log read covers the window).
 */
export function explainedMsat(events, fromMs, toMs) {
  const startIn = new Map(), startOut = new Map(), recv = new Map();
  for (const e of events) {
    const p = e.payload || {};
    if (e.kind === 'incoming-payment-started') startIn.set(imageOf(p), big(p.incoming_contract_commitment && p.incoming_contract_commitment.amount));
    if (e.kind === 'outgoing-payment-started') startOut.set(imageOf(p), big(p.outgoing_contract && p.outgoing_contract.amount));
    if (e.kind === 'payment-receive') recv.set(String(p.operation_id), big(p.amount));
  }
  let d = 0n;
  for (const e of events) {
    const at = msOf(e); if (!(at > fromMs && at <= toMs)) continue;
    const p = e.payload || {};
    switch (e.kind) {
      case 'incoming-payment-started': d -= big(p.incoming_contract_commitment && p.incoming_contract_commitment.amount); break;
      case 'incoming-payment-failed': d += startIn.get(imageOf(p)) || 0n; break;          // the funding refunded - when the refund works
      case 'outgoing-payment-succeeded': d += startOut.get(imageOf(p)) || 0n; break;      // the contract claimed
      case 'payment-send': d -= big(p.amount); break;
      case 'payment-receive-update': if (p.status === 'Success') d += recv.get(String(p.operation_id)) || 0n; break;
      default: break;
    }
  }
  return d;
}

/**
 * The balance check of one federation: `prev` and `cur` are { atMs, ecashMsat } readings. Answers { dropMsat, unexplainedMsat, over }:
 * the drop beyond what the payments explain (0 when the balance rose or moved as explained), `over` when it is above `dropMsat`.
 */
export function balanceCheck(prev, cur, events, { dropMsat = DROP_MSAT } = {}) {
  if (!prev || !cur || prev.atMs == null || cur.atMs <= prev.atMs) return { unexplainedMsat: '0', over: false };
  const moved = big(cur.ecashMsat) - big(prev.ecashMsat);
  const unexplained = explainedMsat(events, prev.atMs, cur.atMs) - moved;   // > 0: less e-cash than the payments explain
  const u = unexplained > 0n ? unexplained : 0n;
  // kanban #2865: more e-cash than the payments explain - e-cash coming back (a spend_ecash received again, change of a payment) - is
  // answered too, so the caller can net it against the drops it still holds for the window
  return { unexplainedMsat: String(u), returnedMsat: String(unexplained < 0n ? -unexplained : 0n), over: u > big(dropMsat), fromMs: prev.atMs, toMs: cur.atMs };
}

/**
 * 3. DEAD NOTES: the spendable notes of a gateway's mintv2 client against the guardians' spent set. `notes` are { d, sk } (denomination
 * as a power of two in msat, the spend key in hex); `spent` a Set of the guardians' input nonce hashes (hex); `nonceOf(sk)` the note's
 * nonce hash (hash160 of its compressed public key, as the mintv2 server keys its spent set). Answers { notes, dead, deadMsat }.
 */
export function deadNotes(notes, spent, nonceOf) {
  let dead = 0, msat = 0n;
  for (const n of notes) if (spent.has(nonceOf(n.sk))) { dead++; msat += 1n << BigInt(n.d); }
  return { notes: notes.length, dead, deadMsat: String(msat) };
}

/**
 * The mintv2 spendable notes in a fedimint-dbtool dump (`list --prefix ""`, one "<key hex> <value hex>" line each) of a gateway or
 * client database: key = 0x10 <federation id> 0xff <module instance> 0x20 <denomination> <sk 32> <signature 48>.
 */
export function notesInDump(lines, federationIdHex, moduleInstance = 2) {
  const pre = `10${federationIdHex.toLowerCase()}ff${moduleInstance.toString(16).padStart(2, '0')}20`;
  const out = [];
  for (const line of lines) {
    const k = String(line).split(' ')[0].toLowerCase();
    if (!k.startsWith(pre) || k.length !== pre.length + 2 * (1 + 32 + 48)) continue;
    const r = k.slice(pre.length);
    out.push({ d: parseInt(r.slice(0, 2), 16), sk: r.slice(2, 66) });
  }
  return out;
}

const satOf = (msat) => { const m = big(msat); return `${(m / 1000n).toLocaleString('en-US')} sat`; };

/**
 * One gateway's warning: { level: 'bad' | 'ok', text, parts } from its `failures` (failuresOf), `drop` (balanceCheck, per federation,
 * any over), `dead` (deadNotes, may be null: not checked yet). 'bad' when anything is above zero.
 */
export function gatewayWarning(name, { failures, drops = [], dead = null } = {}) {
  const parts = [];
  if (failures && failures.failed > 0) {
    parts.push(`${failures.failed} failed payment${failures.failed === 1 ? '' : 's'} in 24 h${failures.alreadySpent ? ` (${failures.alreadySpent} "note already spent")` : ''}${big(failures.failedMsat) > 0n ? `, ${satOf(failures.failedMsat)} at stake` : ''}`);
  }
  const over = drops.filter((d) => d && d.over && !d.pending);
  if (over.length) parts.push(`${satOf(over.reduce((s, d) => s + big(d.unexplainedMsat), 0n))} left the e-cash balance with no payment to explain it`);
  // kanban #2773: a fresh drop the other gateways have not answered yet waits one pass (the receive may land in the next reading)
  const pending = drops.filter((d) => d && d.over && d.pending);
  if (pending.length) parts.push(`${satOf(pending.reduce((s, d) => s + big(d.unexplainedMsat), 0n))} left the e-cash balance, no payment explains it yet (one pass for a matching receive)`);
  if (dead && dead.dead > 0) parts.push(`${dead.dead} dead note${dead.dead === 1 ? '' : 's'} (${satOf(dead.deadMsat)}) the federation counts as spent`);
  // a failed payment alone is red only with "already spent" or a drop: a payer's expired invoice is not money lost
  const bad = (failures && failures.alreadySpent > 0) || over.length > 0 || (dead && dead.dead > 0);
  const moves = drops.filter((d) => d && d.moved).map(moveLine);
  return { level: bad ? 'bad' : parts.length ? 'warn' : 'ok', text: parts.length ? `${name}: ${parts.join('; ')}` : `${name}: no failed payments, balance explained${moves.length ? ` (${moves.join('; ')})` : ''}`, parts, ...(moves.length ? { moves } : {}) };
}

const moveLine = (d) => `moved ${satOf(d.moved.msat)} ${d.moved.from} -> ${d.moved.to}${d.moved.by === 'announced' ? ' (announced)' : ''}`;

/**
 * kanban #2773 (2026-11-21 13:15Z: 100,000,256 msat sent as e-cash from gw-c to gw-b in 337ae01a, by gateway-cli ecash send / receive -
 * neither gateway's payment log records that, so gw-c showed a drop nothing explained and stayed red for hours): OUR OWN MOVES ARE NOT
 * LOSSES. `gateways` are the readings of one pass (readGateway: { name, readAtMs, warning, watch: { failures, drops, rises, dead,
 * error } }); each kept drop not yet explained is netted against
 *   - an unexplained rise on ANOTHER of our gateways, same federation, intervals overlapping or within `nearMs`, the amounts equal
 *     within `tolMsat` (the federation's fees: the drop threshold), or
 *   - an announced move (`announced`: the operator's ops/gateway-moves.json, [{ from, to, federation, msat, atMs }], federation a
 *     prefix of the id), from this gateway, the amount within `tolMsat`, `atMs` in the drop's interval give or take `nearMs`.
 * A matched drop keeps `moved` { from, to, msat, by } and only what is left beyond the match (normally 0) is judged; each rise and each
 * announcement explains one drop. A drop of this very reading not matched waits one pass (`pending`, a warning, not red): the receive
 * may land in the other gateway's next reading. Changes the readings in place and answers the moves found, each { from, to, ... }.
 */
export const MOVE_NEAR_MS = 10 * 60000;
export function netMoves(gateways, { announced = [], tolMsat = DROP_MSAT, nearMs = MOVE_NEAR_MS } = {}) {
  const live = gateways.filter((g) => g && !g.error && g.watch);
  const near = (a, b) => a.toMs + nearMs >= b.fromMs && b.toMs + nearMs >= a.fromMs;
  const close = (x, y) => { const d = big(x) - big(y); return (d < 0n ? -d : d) <= big(tolMsat); };
  const usedAnn = new Set(live.flatMap((g) => (g.watch.drops || []).filter((d) => d.moved && d.moved.key).map((d) => d.moved.key)));
  const annList = (Array.isArray(announced) ? announced : []).filter((m) => m && m.from && m.federation && m.msat != null && m.atMs != null);
  const out = [];
  for (const g of live) {
    let changed = false;
    for (const d of g.watch.drops || []) {
      if (d.moved) { out.push(d.moved); continue; }
      if (!(big(d.unexplainedMsat) > 0n)) continue;
      let hit = null;
      for (const o of live) {
        if (o === g || hit) continue;
        for (const r of o.watch.rises || []) {
          if (r.movedFrom || r.federation !== d.federation || !near(d, r) || !close(r.msat, d.unexplainedMsat)) continue;
          r.movedFrom = g.name; hit = { from: g.name, to: o.name, federation: d.federation, msat: d.unexplainedMsat, by: 'rise', riseMsat: String(r.msat) }; break;
        }
      }
      if (!hit) {
        for (let i = 0; i < annList.length; i++) {
          const m = annList[i], key = `${m.from}>${m.to}@${m.atMs}:${m.msat}`;
          if (usedAnn.has(key) || m.from !== g.name || !String(d.federation).startsWith(String(m.federation)) || !close(m.msat, d.unexplainedMsat)
            || !(Number(m.atMs) >= d.fromMs - nearMs && Number(m.atMs) <= d.toMs + nearMs)) continue;
          usedAnn.add(key); hit = { from: g.name, to: m.to || '?', federation: d.federation, msat: d.unexplainedMsat, by: 'announced', key };
          // the receive the announcement names is ours too: it explains nothing else
          for (const o of live) if (o.name === m.to) for (const r of o.watch.rises || []) if (!r.movedFrom && r.federation === d.federation && near(d, r) && close(r.msat, d.unexplainedMsat)) { r.movedFrom = g.name; break; }
          break;
        }
      }
      if (hit) {
        const left = big(d.unexplainedMsat) - big(hit.riseMsat ?? hit.msat);
        d.moved = hit; d.unexplainedMsat = String(left > big(tolMsat) ? left : 0n); d.over = big(d.unexplainedMsat) > DROP_MSAT; d.pending = false;
        out.push(hit); changed = true;
      } else if (d.over) {
        const p = d.toMs >= g.readAtMs;
        if (p !== !!d.pending) { d.pending = p; changed = true; }
      }
    }
    if (changed) {
      const w = gatewayWarning(g.name, { failures: g.watch.failures, drops: g.watch.drops || [], dead: g.watch.dead || null });
      if (g.watch.error && w.level === 'ok') { w.level = 'warn'; w.text = `${g.name}: the payment log was not read (${g.watch.error})`; }
      g.warning = w;
    }
  }
  return out;
}
