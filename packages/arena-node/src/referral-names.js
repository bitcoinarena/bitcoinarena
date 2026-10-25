// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// REFERRAL PROGRAMS' NAMES, AS A SEAT KEEPS THEM (kanban #675; protocol referral-name.js): the newest signed name of each website key, kept
// when its signature verifies; GET /referral-fees and the explorer and Health name a website by it.
import { decodeReferralName, referralNameStands } from '../../arena-protocol/src/referral-name.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const REFERRAL_NAMES_SQL = `CREATE TABLE IF NOT EXISTS referral_names (
  site TEXT PRIMARY KEY, name TEXT NOT NULL, at_ms INTEGER NOT NULL, bytes BLOB NOT NULL, signature BLOB NOT NULL, kept_ms INTEGER NOT NULL)`;

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
  const had = db.prepare('SELECT at_ms, name FROM referral_names WHERE site = ?').get(site);
  if (had && Number(had.at_ms) === Number(r.atMs) && had.name === r.name) return { ok: true, kept: 'held', site, name: r.name };
  if (had && Number(had.at_ms) >= Number(r.atMs)) return { ok: true, kept: 'older', site, name: had.name };
  db.prepare('INSERT OR REPLACE INTO referral_names (site, name, at_ms, bytes, signature, kept_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(site, r.name, Number(r.atMs), Buffer.from(fromHex(String(body.record).toLowerCase())), Buffer.from(sig), nowMs);
  return { ok: true, kept: 'new', site, name: r.name };
}

/** Every name kept: Map site hex -> { name, atMs, record, signature }. */
export function referralNames(db) {
  db.exec(REFERRAL_NAMES_SQL);
  return new Map(db.prepare('SELECT site, name, at_ms, bytes, signature FROM referral_names').all()
    .map((x) => [x.site, { name: x.name, atMs: Number(x.at_ms), record: toHex(new Uint8Array(x.bytes)), signature: toHex(new Uint8Array(x.signature)) }]));
}
