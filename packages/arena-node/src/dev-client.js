// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DEV CLIENT BESIDE THIS NODE (2026-10-14: "make sure node 1 and node 2 show it in their dashboard, each node
// can set up a dev client and it would show there"). A node's operator may run a donation recipient's client (arena-donor, one
// directory per dev: `arena-donor init <dir> --label "dev a"`, then `arena-donor loop <dir>`) and name its directory in
// ARENA_DEV_CLIENT_DIR. The dashboard then shows what that client did, read from the files it keeps:
//
//   donor.json      its label, its recipient key, how many seats it asks
//   donations.jsonl the dev's permanent record: every donation it redeemed (round, entry, amount, time, USD/EUR rate)
//   state.json      its balances per federation, its withdrawals to its LND, its last pass
//
// Never key.json: the secret stays where the client keeps it. Read at most every 30 s (the dashboard's own cache).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/** The dev client's figures from its directory; `{ error }` when it cannot be read, null when no directory is named. */
export function devClientSnapshot(dir, { recent = 12 } = {}) {
  if (!dir) return null;
  try {
    const cfg = readJson(join(dir, 'donor.json'));
    if (!cfg) return { dir, error: 'no donor.json: run arena-donor init there' };
    const state = readJson(join(dir, 'state.json')) || {};
    const rows = existsSync(join(dir, 'donations.jsonl'))
      ? readFileSync(join(dir, 'donations.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const byFed = new Map();
    for (const r of rows) {
      const f = String(r.federationId || '');
      const x = byFed.get(f) || { federation: f, donations: 0, msat: 0n };
      x.donations++; x.msat += BigInt(r.amountMsat || 0); byFed.set(f, x);
    }
    const withdrawals = (state.withdrawals || []).slice(-5).reverse();
    return {
      label: String(cfg.label || ''), recipientPk: String(cfg.recipientPkHex || ''), seats: (cfg.seats || []).length,
      donations: rows.length, receivedMsat: String(rows.reduce((t, r) => t + BigInt(r.amountMsat || 0), 0n)),
      byFederation: [...byFed.values()].map((x) => ({ ...x, msat: String(x.msat),
        balanceMsat: state.balances && state.balances[x.federation] ? String(state.balances[x.federation].msat) : null })),
      balances: Object.entries(state.balances || {}).map(([federation, b]) => ({ federation, msat: String(b.msat), at: b.at })),
      recent: rows.slice(-recent).reverse().map((r) => ({ round: String(r.roundId || ''), entry: String(r.entryId || ''), federation: String(r.federationId || ''),
        amountMsat: String(r.amountMsat || '0'), contract: String(r.contractId || ''), atMs: Number(r.verifiedMs || r.recordedAt || 0), player: String(r.playerKey || ''), item: r.item ? String(r.item) : null, outpoint: String(r.outpoint || ''), player: String(r.playerKey || ''),
        usdPerBtc: r.usdPerBtc ? Number(r.usdPerBtc) : null })),
      withdrawals: withdrawals.map((w) => ({ at: w.at, federation: String(w.federation || ''), msat: String(w.msat || '0'), state: w.state || null, paid: !!w.preimage })),
      withdrawnMsat: String((state.withdrawals || []).filter((w) => w.preimage).reduce((t, w) => t + BigInt(w.msat || 0), 0n)),
      lastPass: state.lastPass || null,
      // UNCLAIMED E-CASH AND ITS RECOVERY: what waits a pass to be recovered, and the last recovery
      unclaimed: Object.entries(state.unclaimed || {}).map(([federation, u]) => ({ federation, msat: String(u.msat || '0'), outputs: (u.nonces || []).length, since: u.since || null })),
      lastRecovery: (state.recoveries || []).length ? (({ at, federation, unclaimedMsat, recoveredMsat, ok, backup, why }) => ({ at, federation, unclaimedMsat, recoveredMsat, ok, backup: backup ? String(backup).split('/').pop() : null, why }))(state.recoveries[state.recoveries.length - 1]) : null,
    };
  } catch (e) { return { dir, error: e.message }; }
}
