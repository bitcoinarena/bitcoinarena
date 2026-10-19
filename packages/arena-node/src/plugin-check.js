// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLUGIN STORE'S CHECKS, IN THE PAGE AND ON THE SEAT ALIKE (2026-10-10: "Everything with
// loading plugins must happen in the browser including updating games and networks like an AppStore. Malicious code checks
// are very important"). Isomorphic - no Node API: the owner page bundles it and shows its report before Install; the seat
// runs the same checks again, and its own sandboxed trial run (plugin-trial.js), before anything is written or activated.
//   - the manifest stands (its developer's signature over its body, as every seat checks a game);
//   - the donation set is the one the manifest names;
//   - every core and client is byte for byte the file the manifest names by sha-256;
//   - every core passes the scan (below);
//   - an update is the same developer's next version of the game it replaces.
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { decodeManifest, gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { gameInfoStands } from '../../arena-protocol/src/game-info.js';

export const fromBase64 = (s) => (typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(String(s || ''), 'base64'))
  : Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0)));
const utf8 = (b) => new TextDecoder().decode(b);
const shaHex = (b) => toHex(sha256(b));

// THE SCAN: what a decide adapter may not do, by pattern on its source (comments included - an honest adapter has no reason to
// spell any of these). Each finding names the rule and the line.
export const SCAN_RULES = Object.freeze([
  ['loads another module', /\bimport\s*\(|\brequire\s*\(|^\s*import\s[^;]*\bfrom\b|^\s*import\s+['"]/m],
  ['evaluates code', /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/],
  ['reaches the network', /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttp[s]?\b\s*\.\s*request|\bnet\s*\.\s*connect|\bnavigator\b/],
  ['reaches the file system or the process', /\bprocess\b|\bchild_process\b|\bfs\s*\.|\bDeno\b|\bBun\b/],
  ['reaches the global scope', /\bglobalThis\b|\bwindow\b|\bself\b\s*\.|\bglobal\b\s*\.|\bdocument\b/],
  ['runs later or forever', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b|\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/],
  ['reaches its own constructor', /\bconstructor\s*\.\s*constructor\b|__proto__|\bprototype\s*\[|\bReflect\b|\bProxy\b/],
  ['hides its text', /\\u\{?[0-9a-fA-F]{2,}|\\x[0-9a-fA-F]{2}|\batob\s*\(|\bString\s*\.\s*fromCharCode\b/],
]);
export function scanSource(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (const [rule, re] of SCAN_RULES) {
    const hit = new RegExp(re.source, re.flags.includes('m') ? re.flags : re.flags + 'm').exec(text);
    if (hit) { const line = String(text).slice(0, hit.index).split('\n').length; findings.push({ rule, line, text: (lines[line - 1] || '').trim().slice(0, 120) }); }
  }
  return findings;
}

/**
 * THE REPORT ON A PACKAGE: `verify(sig, msg, key)` is Ed25519. Answers { ok, gameId, name, version, devKey, parent, checks:
 * [{ check, ok, detail }], findings, why }. Every check is listed, passed or not, so the page shows the whole report.
 */
export function checkPackage(pkg, { verify, want = null, parentOf = () => null } = {}) {
  const checks = [], findings = [];
  const add = (check, ok, detail = '') => { checks.push({ check, ok, detail }); return ok; };
  const out = (why, extra = {}) => ({ ok: !why, why: why || null, checks, findings, ...extra });
  if (!add('a package of this store', !!pkg && pkg.format === 'arena-plugin/v1')) return out('that is not an arena-plugin/v1 package');
  let manifest;
  try { manifest = decodeManifest(fromHex(String(pkg.manifest))); add('the manifest reads', true); }
  catch (e) { add('the manifest reads', false, e.message); return out(`its manifest does not decode: ${e.message}`); }
  const gameId = toHex(gameIdOf(manifest));
  const who = { gameId, name: manifest.gameName, version: manifest.version, devKey: toHex(manifest.gameDevPubkey), parent: toHex(manifest.parentManifestId) };
  // ITS ANCESTORS, oldest first: each must stand on the one before it (and the oldest on nothing, or on what the caller holds)
  const known = new Map();
  const parentFrom = (id) => known.get(toHex(id)) || parentOf(id) || null;
  for (const h of pkg.ancestors || []) {
    let a;
    try { a = decodeManifest(fromHex(String(h))); } catch (e) { add('its earlier versions read', false, e.message); return out(`an earlier version in it does not decode: ${e.message}`); }
    const s = manifestStands(a, { verify, parentOf: parentFrom });
    if (!add(`its version ${a.version} stands`, s.ok, s.ok ? '' : s.why)) return out(`its version ${a.version} does not stand: ${s.why}`);
    known.set(toHex(gameIdOf(a)), a);
  }
  const stands = manifestStands(manifest, { verify, parentOf: parentFrom });
  if (!add('signed by its developer, and stands', stands.ok, stands.ok ? `developer ${who.devKey.slice(0, 16)}…` : stands.why)) return out(`its manifest does not stand: ${stands.why}`, who);
  if (want && !add('the game asked for', want === gameId, gameId.slice(0, 16))) return out(`that package is game ${gameId.slice(0, 16)}, not ${String(want).slice(0, 16)}`, who);
  let set = null;
  try { set = (pkg.donationSet || []).map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: Number(r.shareBps), label: String(r.label || '') })); } catch { set = null; }
  let setOk = false;
  try { setOk = !!set && toHex(donationSetId(set)) === toHex(manifest.gameDonationSetId); } catch { setOk = false; }
  if (!add('its donation set is the one its manifest names', setOk)) return out('its donation set is not the one its manifest names', who);
  const named = new Set(manifest.cores.map((c) => toHex(c.hash)));
  if (!add('it carries every core its manifest names', (pkg.cores || []).length === named.size, `${(pkg.cores || []).length} of ${named.size}`))
    return out(`its manifest names ${named.size} core(s) and the package carries ${(pkg.cores || []).length}`, who);
  for (const c of pkg.cores || []) {
    const src = fromBase64(c.source);
    const h = shaHex(src);
    if (!add(`core ${String(c.hash).slice(0, 12)}… is the file its manifest names`, h === c.hash && named.has(c.hash), `sha-256 ${h.slice(0, 16)}…`))
      return out(`core ${String(c.hash).slice(0, 16)}: its source is not the file its manifest names (sha-256 ${h.slice(0, 16)})`, who);
    const f = scanSource(utf8(src));
    for (const x of f) findings.push({ core: String(c.hash).slice(0, 16), ...x });
    add(`core ${String(c.hash).slice(0, 12)}… passes the scan`, !f.length, f.map((x) => `${x.rule} (line ${x.line})`).join('; '));
  }
  const clientsNamed = new Set(manifest.clients.map(toHex));
  for (const k of pkg.clients || []) {
    const h = shaHex(fromBase64(k.body));
    if (!add(`client ${String(k.hash).slice(0, 12)}… is a client its manifest names`, h === k.hash && clientsNamed.has(k.hash)))
      return out(`client ${String(k.hash).slice(0, 16)}: it is not a client its manifest names`, who);
  }
  if (findings.length) return out(`the scan refuses it: ${findings.map((f) => `${f.rule} (line ${f.line})`).join('; ')}`, who);
  // ITS DESCRIPTION AND WEBSITE: shown when its developer key signed them for this game id; never a reason to
  // refuse the game - a package with none, or with an unsigned one, installs the same game (the id is the manifest's)
  const info = pkg.info ? gameInfoStands(pkg.info, { gameId: gameIdOf(manifest), manifest, verify }) : null;
  if (pkg.info) add('its description and website are signed by its developer', info.ok, info.ok ? '' : info.why);
  return out(null, { ...who, info: info && info.ok ? { description: info.description, website: info.website, signed: true } : null });
}

/** AN UPDATE IS THE SAME DEVELOPER'S NEXT VERSION OF THE GAME IT REPLACES: its parent is that game, its version higher. */
export function checkUpdate(installed, next) {
  if (!installed || !next) return { ok: false, why: 'an update names the game it replaces' };
  if (installed.devKey !== next.devKey) return { ok: false, why: `that version is signed by another developer (${next.devKey.slice(0, 16)}) than the installed one's (${installed.devKey.slice(0, 16)})` };
  if (next.parent !== installed.gameId) return { ok: false, why: `that version names ${next.parent.slice(0, 16)} as its parent, not the installed ${installed.gameId.slice(0, 16)}` };
  if (!(next.version > installed.version)) return { ok: false, why: `that is version ${next.version}, not newer than the installed ${installed.version}` };
  return { ok: true };
}
