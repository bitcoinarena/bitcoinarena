// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SOCIAL NAMES REMEMBERED IN THE BROWSER (kanban #2641, Daniel 2026-11-14: "Merke dir die angegebenen social Daten im Browser so dass der User
// es nicht nochmal angeben muss, wenn es einmal validiert ist"): per report key, arena.bounty.social:<pubkey> = { x, telegram, discord, armada,
// checkedAt }. Only a name whose live check said member is kept; one that failed is dropped; a check that could not be read leaves what was kept.
// Every storage call is in a try (a private window, blocked or full storage): without it the page works, it only asks again.
// The page carries a copy of the functions between the markers below (the build step copies them; no imports, plain functions).
// ---- social-store begin
const SOCIAL_PLATFORMS = ['x', 'telegram', 'discord', 'armada', 'nostr'];
function socialKey(pubkey) { return 'arena.bounty.social:' + String(pubkey || ''); }
function socialLoad(storage, pubkey) {
  if (!/^[0-9a-f]{64}$/.test(String(pubkey || ''))) return null;
  let raw = null;
  try { raw = storage && storage.getItem(socialKey(pubkey)); } catch (e) { return null; }
  if (!raw) return null;
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const p of SOCIAL_PLATFORMS) if (typeof o[p] === 'string' && o[p].trim() && o[p].length <= 120) out[p] = o[p].trim();
  if (!Object.keys(out).length) return null;
  out.checkedAt = Number.isFinite(o.checkedAt) ? o.checkedAt : null;
  return out;
}
function socialSave(storage, pubkey, asked, results, nowMs) {
  if (!/^[0-9a-f]{64}$/.test(String(pubkey || ''))) return null;
  const kept = socialLoad(storage, pubkey) || {};
  delete kept.checkedAt;
  for (const p of SOCIAL_PLATFORMS) {
    const r = results && results[p];
    if (!r) continue;
    const name = asked && typeof asked[p] === 'string' ? asked[p].trim() : '';
    if (r.member === true && name) kept[p] = name;
    else if (r.member === false) delete kept[p];
  }
  try {
    if (!Object.keys(kept).length) { storage.removeItem(socialKey(pubkey)); return null; }
    kept.checkedAt = Number(nowMs) || Date.now();
    storage.setItem(socialKey(pubkey), JSON.stringify(kept));
  } catch (e) { return null; }
  return kept;
}
/** The saved names the server holds no link for (another device, a cleared server): those are sent once more. */
function socialMissing(saved, links) {
  if (!saved) return {};
  const have = new Set((links || []).filter((l) => l && l.member === true).map((l) => l.platform));
  const out = {};
  for (const p of SOCIAL_PLATFORMS) if (saved[p] && !have.has(p)) out[p] = saved[p];
  return out;
}
/** The bonus the flags give, as the faucet counts it: X +20; Nostr +20; 2 of Telegram, Discord, Armada +20 (kanban #2641). */
function socialBonus(flags) {
  const f = flags || {};
  const n = ['telegram', 'discord', 'armada'].filter((p) => f[p] === true).length;
  return (f.x === true ? 20 : 0) + (f.nostr === true ? 20 : 0) + (n >= 2 ? 20 : 0);
}
// ---- social-store end
export { SOCIAL_PLATFORMS, socialKey, socialLoad, socialSave, socialMissing, socialBonus };
