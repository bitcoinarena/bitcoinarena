#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * WHAT A HEADLESS PAID RUN LEFT BEHIND, COLLECTED (kanban #803). tn4-rps-paid.mjs and tn4-live-run.mjs keep each entry's player key in a
 * keys file and exit; the money of a round that settled late, or was held VOID, then has no player to collect it. This is that player:
 *
 *   MODE=payout  a settled round's qualifier payout, and the winner's stake by the committee's forfeit
 *   MODE=refund  a lock's refund to its player: a VOID entry's stake and fee, which the guardians take from its expiry on
 *   MODE=withdraw  what WALLET holds, out over Lightning to INVOICE
 *
 *   KEYS=<keys.jsonl,...> ROUNDS=<id prefix,...> DB=<a seat's store> NODES=<seat url,...> INVITE_FILE=<invite> WASM_PKG=<dir>
 *   WALLET=<json file> [ONLY=<entry prefix>] [LOCKS=stake,fee] [STAKE_ONLY=1] node tools/tn4-collect.mjs
 *
 * WALLET keeps the client secret and its notes across runs, because a refund lands in this client, not in the player's old one.
 * No secret is printed. The seat store is only read.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { routeGuardianSockets } from './guardian-ws-local.mjs';
import { forfeitOf } from '../../arena-client/src/page-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const MODE = env.MODE || 'payout';
const wanted = new Set(String(env.ROUNDS || '').split(',').filter(Boolean));
const only = env.ONLY || '';
const kinds = String(env.LOCKS || 'stake,fee').split(',');
const nodes = String(env.NODES || '').split(',').filter(Boolean);
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

const rows = String(env.KEYS).split(',').flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)))
  .filter((r) => wanted.has(r.round.slice(0, 8)) && r.entry.startsWith(only));
const db = new DatabaseSync(env.DB, { readOnly: true });
const lockOf = (kind, entry) => db.prepare(`SELECT outpoint, fields FROM ${kind === 'fee' ? 'fee_locks' : 'stake_locks'} WHERE entry_id = ?`).get(fromHex(entry));

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
routeGuardianSockets();
const esm = join(tmpdir(), `blwp-lock-client-${process.pid}.mjs`);
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasmMod = await import(esm);
await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasmMod;

const invite = readFileSync(env.INVITE_FILE, 'utf8').trim();
const kept = existsSync(env.WALLET) ? JSON.parse(readFileSync(env.WALLET, 'utf8')) : { secret: toHex(randomBytes(32)), notes: [] };
const held = new Map(kept.notes);
const flush = () => writeFileSync(env.WALLET, JSON.stringify({ secret: kept.secret, notes: [...held] }), { mode: 0o600 });
const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); flush(); }, remove: (k) => { held.delete(k); flush(); } };
const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), kept.secret, store);
flush();
log({ step: 'wallet', balanceMsat: String(await lc.balanceMsat()) });

// MODE=withdraw: INVOICE=<bolt11> [GATEWAY=<url>]: what this wallet collected, out over Lightning
if (MODE === 'withdraw') {
  const w = JSON.parse(await lc.withdraw(env.INVOICE, env.GATEWAY || undefined));
  log({ step: 'withdraw', state: w.state, before: w.balance_before, after: w.balance_after });
  process.exit(w.state === 'Success' ? 0 : 2);
}
let accepted = 0, refused = 0;
const said = (step, r, s) => { const ok = s.accepted === true; if (ok) accepted += 1; else refused += 1;
  log({ step, round: r.round.slice(0, 8), entry: r.entry.slice(0, 8), player: r.player, accepted: ok, ...(ok ? {} : { said: JSON.stringify(s).slice(0, 240) }) }); };

for (const r of rows) {
  // THE KEY THE ROUND PAYS IS THE ONE ITS STAKE LOCK REFUNDS TO: read off the verified lock, not derived again
  const stake = lockOf('stake', r.entry);
  const mine = stake ? String(JSON.parse(stake.fields).refundPk).toLowerCase() : '';
  if (MODE === 'payout') {
    let st = null;
    for (const n of nodes) { try { const j = await (await fetch(`${n}/lock-settlement?round=${r.round}`, { signal: AbortSignal.timeout(8000) })).json(); if (j.state === 'ACCEPTED' && j.moved) { st = j; break; } } catch { /* the next seat */ } }
    if (!st) { log({ step: 'no settlement', round: r.round.slice(0, 8) }); continue; }
    const at = st.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === mine);
    if (at < 0) { log({ step: 'no payout to this key', round: r.round.slice(0, 8), entry: r.entry.slice(0, 8), player: r.player }); continue; }
    const x = st.moved.payouts[at];
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(x.msat), claimPk: mine, refundPk: mine, expiration: 0 };
    if (!env.STAKE_ONLY) said(`payout ${x.msat} msat`, r, JSON.parse(await lc.refund(st.txid, at, JSON.stringify(fields), r.secret)));
    const l = lockOf('stake', r.entry);
    const f = await forfeitOf({ roundId: fromHex(r.round), entryId: r.entry, nodes, lock: 'stake' });
    if (!f.ok) { log({ step: 'no forfeit', round: r.round.slice(0, 8), why: f.why.slice(0, 200) }); continue; }
    const [txid, idx] = l.outpoint.split(':');
    said('stake back', r, JSON.parse(await lc.redeem(txid, Number(idx), l.fields, f.signature, r.secret)));
  } else {
    for (const kind of kinds) {
      const l = lockOf(kind, r.entry);
      if (!l) { log({ step: `no ${kind} lock`, entry: r.entry.slice(0, 8) }); continue; }
      const [txid, idx] = l.outpoint.split(':');
      let s;
      try { s = JSON.parse(await lc.refund(txid, Number(idx), l.fields, r.secret)); } catch (e) { s = { error: String(e.message || e) }; }
      said(`refund ${kind}`, r, s);
    }
  }
}
log({ step: 'done', accepted, refused, balanceMsat: String(await lc.balanceMsat()) });
process.exit(refused ? 2 : 0);
