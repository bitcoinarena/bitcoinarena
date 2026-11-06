// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// REFERRAL PROGRAMS' NAMES, AS A SEAT KEEPS THEM (kanban #675; protocol referral-name.js): the newest signed name of each website key, kept
// when its signature verifies; GET /referral-fees and the explorer and Health name a website by it.
import { decodeReferralName, referralNameStands } from '../../arena-protocol/src/referral-name.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

export const REFERRAL_NAMES_SQL = `CREATE TABLE IF NOT EXISTS referral_names (
  site TEXT PRIMARY KEY, name TEXT NOT NULL, at_ms INTEGER NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

/**
 * WHICH OF TWO NAMES OF ONE SITE STANDS (kanban #1190, the 2026-11-06 state-machine audit): the later one, its date read no later than this seat's clock when
 * it was taken (a name dated ahead of the clock blocked every rename until its date came: the newest name won by `atMs` alone); two names of one date
 * ordered by their record's hash, the lower first (two seats that got them in another order kept other names). `had` and `next` are
 * { atMs (as kept: clamped), hash }. Answers 'new' (next stands), 'held' (the same record) or 'older' (had stands).
 */
export function referralNameStep(had, next) {
  if (!had) return 'new';
  if (had.hash && had.hash === next.hash) return 'held';
  if (next.atMs !== had.atMs) return next.atMs > had.atMs ? 'new' : 'older';
  return had.hash && next.hash < had.hash ? 'new' : 'older';
}

/** Check and keep one record ({ record, signature } in hex). { ok, kept: 'new' | 'held' | 'older', site, name } or { ok: false, status, why }. */
export function keepReferralName(db, body, { verify, nowMs = Date.now() }) {
  let r, sig;
  try { r = decodeReferralName(fromHex(String(body.record || '').toLowerCase())); sig = fromHex(String(body.signature || '').toLowerCase()); }
  catch (e) { return { ok: false, status: 400, why: `that is not a referral name: ${e.message}` }; }
  if (Number(r.atMs) > nowMs + 10 * 60000) return { ok: false, status: 422, why: 'that name is dated ahead of this seat\'s clock' };
  const st = referralNameStands(r, sig, { verify });
  if (!st.ok) return { ok: false, status: 422, why: st.why };
  db.exec(REFERRAL_NAMES_SQL);
  const site = toHex(r.site);
  const bytes = fromHex(String(body.record).toLowerCase());
  // A NAME DATED AHEAD IS READ AS DATED NOW (kanban #1190): it stands until a later name comes, not until its own date
  const next = { atMs: Math.min(Number(r.atMs), Number(nowMs)), hash: toHex(sha256(bytes)) };
  // ONE STEP, READ AND WRITTEN IN ONE TRANSACTION: two posts of one site never both win
  const own = !db.isTransaction;   // inside a caller's transaction this step is part of it
  if (own) db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT at_ms, name, bytes FROM referral_names WHERE site = ?').get(site);
    const had = row ? { atMs: Number(row.at_ms), hash: toHex(sha256(new Uint8Array(row.bytes))), name: row.name } : null;
    const step = referralNameStep(had, next);
    if (step !== 'new') { if (own) db.exec('COMMIT'); return { ok: true, kept: step, site, name: step === 'held' ? r.name : had.name }; }
    db.prepare('INSERT OR REPLACE INTO referral_names (site, name, at_ms, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(site, r.name, next.atMs, Buffer.from(bytes), Buffer.from(sig), nowMs);
    if (own) db.exec('COMMIT');
  } catch (e) { if (own) { try { db.exec('ROLLBACK'); } catch { /* none open */ } } throw e; }
  return { ok: true, kept: 'new', site, name: r.name };
}

/** Every name kept: Map site hex -> { name, atMs, record, signature }. */
export function referralNames(db) {
  db.exec(REFERRAL_NAMES_SQL);
  return new Map(db.prepare('SELECT site, name, at_ms, bytes, signature FROM referral_names').all()
    .map((x) => [x.site, { name: x.name, atMs: Number(x.at_ms), record: toHex(new Uint8Array(x.bytes)), signature: toHex(new Uint8Array(x.signature)) }]));
}
