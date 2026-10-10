// THE PLUGIN STORE'S PACKAGE (kanban #276 step 5, the owner 2026-10-09: "Choose supported games and markets, as a plugin store.
// See what other nodes host. Install it. Always scan for malicious code before install"; 2026-10-10: "some sort of plugin
// system where games can be downloaded from other nodes"). A seat serves each game it hosts as one package: its signed
// manifest, its developer's donation set, its cores' sources and its clients - and an installing seat takes it only when
//   - the manifest stands (its developer's signature over its body, as every seat checks a game),
//   - the donation set is the one the manifest names,
//   - every core and client is byte for byte the file the manifest names by hash,
//   - and every core's source passes the scan: no module loading, no network, no file system, no process, no eval.
// A decide adapter is pure: it takes the revealed moves and answers verdicts. Replayed games' wasm cores are not packaged
// here (their cores are installed with their engine); attested markets have no core and package their manifest and client.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, encodeManifest, gameIdOf, manifestStands } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');

/** A hosted game as a package (JSON-able), from its registration's files. Null when it names no source to give. */
export function packageOf(game) {
  const cores = [];
  for (const [hash, core] of game.cores || []) {
    if (!core || !core.url || !String(core.url).startsWith('file:')) return null;
    cores.push({ hash, name: core.name || '', configs: [...(core.configs ? core.configs.keys() : [])], source: b64(readFileSync(new URL(core.url))) });
  }
  const clients = (game.clientUrls || []).map((u) => { const body = readFileSync(new URL(u)); return { hash: sha(body), body: b64(body) }; });
  return { format: 'arena-plugin/v1', name: game.name, title: game.title || game.name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: (game.donationSet || []).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: Number(r.shareBps), label: r.label || '' })),
    cores, clients };
}

// THE SCAN: what a decide adapter may not do, by pattern on its source (comments included - a pattern in a comment is refused
// too: an honest adapter has no reason to spell them). Each finding names the rule and the line.
export const SCAN_RULES = Object.freeze([
  ['loads another module', /\bimport\s*\(|\brequire\s*\(|^\s*import\s[^;]*\bfrom\b|^\s*import\s+['"]/m],
  ['evaluates code', /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/],
  ['reaches the network', /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bhttp[s]?\b\s*\.\s*request|\bnet\s*\.\s*connect/],
  ['reaches the file system or the process', /\bprocess\b|\bchild_process\b|\bfs\s*\.|\bDeno\b|\bBun\b/],
  ['reaches the global scope', /\bglobalThis\b|\bwindow\b|\bself\b\s*\.|\bglobal\b\s*\./],
  ['runs later or forever', /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b|\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/],
  ['reaches its own constructor', /\bconstructor\s*\.\s*constructor\b|__proto__|\bprototype\s*\[/],
]);
export function scanSource(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (const [rule, re] of SCAN_RULES) {
    const flags = re.flags.includes('m') ? re.flags : re.flags + 'm';
    const hit = new RegExp(re.source, flags).exec(text);
    if (hit) {
      const line = String(text).slice(0, hit.index).split('\n').length;
      findings.push({ rule, line, text: (lines[line - 1] || '').trim().slice(0, 120) });
    }
  }
  return findings;
}

/**
 * IS THIS PACKAGE THE GAME IT SAYS, AND SAFE TO RUN? `verify(sig, msg, key)` is Ed25519 (as the seats check manifests).
 * Answers { ok, gameId, name, findings } or { ok: false, why, findings }.
 */
export function verifyPackage(pkg, { verify, want = null } = {}) {
  if (!pkg || pkg.format !== 'arena-plugin/v1') return { ok: false, why: 'that is not an arena-plugin/v1 package' };
  let manifest;
  try { manifest = decodeManifest(fromHex(String(pkg.manifest))); } catch (e) { return { ok: false, why: `its manifest does not decode: ${e.message}` }; }
  const stands = manifestStands(manifest, { verify });
  if (!stands.ok) return { ok: false, why: `its manifest does not stand: ${stands.why}` };
  const gameId = toHex(gameIdOf(manifest));
  if (want && want !== gameId) return { ok: false, why: `that package is game ${gameId.slice(0, 16)}, not ${String(want).slice(0, 16)}` };
  let set;
  try { set = (pkg.donationSet || []).map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: Number(r.shareBps), label: String(r.label || '') })); }
  catch (e) { return { ok: false, why: `its donation set does not read: ${e.message}` }; }
  try { if (toHex(donationSetId(set)) !== toHex(manifest.gameDonationSetId)) return { ok: false, why: 'its donation set is not the one its manifest names' }; }
  catch (e) { return { ok: false, why: `its donation set does not stand: ${e.message}` }; }
  const named = new Set(manifest.cores.map((c) => toHex(c.hash)));
  if ((pkg.cores || []).length !== named.size) return { ok: false, why: `its manifest names ${named.size} core(s) and the package carries ${(pkg.cores || []).length}` };
  const findings = [];
  for (const c of pkg.cores) {
    const src = Buffer.from(String(c.source || ''), 'base64');
    if (sha(src) !== c.hash || !named.has(c.hash)) return { ok: false, why: `core ${String(c.hash).slice(0, 16)}: its source is not the file its manifest names (sha-256 ${sha(src).slice(0, 16)})` };
    for (const f of scanSource(src.toString('utf8'))) findings.push({ core: c.hash.slice(0, 16), ...f });
  }
  const clientsNamed = new Set(manifest.clients.map(toHex));
  for (const k of pkg.clients || []) {
    const body = Buffer.from(String(k.body || ''), 'base64');
    if (sha(body) !== k.hash || !clientsNamed.has(k.hash)) return { ok: false, why: `client ${String(k.hash).slice(0, 16)}: it is not a client its manifest names` };
  }
  if (findings.length) return { ok: false, why: `the scan refuses it: ${findings.map((f) => `${f.rule} (line ${f.line})`).join('; ')}`, findings, gameId };
  return { ok: true, gameId, name: manifest.gameName, findings: [] };
}

/** Kept on disk, one directory per game id: the package as fetched and its files. */
export function installPackage(dir, pkg, gameId) {
  const at = join(dir, gameId);
  mkdirSync(at, { recursive: true });
  for (const c of pkg.cores) writeFileSync(join(at, `core-${c.hash}.mjs`), Buffer.from(c.source, 'base64'));
  for (const k of pkg.clients || []) writeFileSync(join(at, `client-${k.hash}.html`), Buffer.from(k.body, 'base64'));
  writeFileSync(join(at, 'package.json'), JSON.stringify(pkg));
  return at;
}

/**
 * THE INSTALLED GAMES AS REGISTRATIONS (main.js at start): each package checked again before it is loaded; a core is a decide
 * adapter module exporting DECIDE. Answers { registrations, refused: [{ dir, why }] }.
 */
export async function loadInstalled(dir, { verify }) {
  const registrations = [], refused = [];
  if (!dir || !existsSync(dir)) return { registrations, refused };
  for (const id of readdirSync(dir)) {
    const at = join(dir, id);
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')); } catch (e) { refused.push({ dir: at, why: e.message }); continue; }
    const v = verifyPackage(pkg, { verify, want: id });
    if (!v.ok) { refused.push({ dir: at, why: v.why }); continue; }
    const manifest = decodeManifest(fromHex(pkg.manifest));
    const cores = new Map();
    for (const c of pkg.cores) {
      const file = join(at, `core-${c.hash}.mjs`);
      if (sha(readFileSync(file)) !== c.hash) { refused.push({ dir: at, why: `core ${c.hash.slice(0, 16)} changed on disk` }); continue; }
      const m = await import(pathToFileURL(file).href);
      if (!m.DECIDE || typeof m.DECIDE.decide !== 'function') { refused.push({ dir: at, why: `core ${c.hash.slice(0, 16)} exports no DECIDE` }); continue; }
      cores.set(c.hash, { name: c.name, hash: c.hash, url: pathToFileURL(file).href, adapter: m.DECIDE, configs: new Map((c.configs || []).map((h) => [h, {}])) });
    }
    registrations.push({ name: pkg.name, title: pkg.title, manifest, gameId: gameIdOf(manifest), cores,
      donationSet: pkg.donationSet.map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
      clientUrls: (pkg.clients || []).map((k) => pathToFileURL(join(at, `client-${k.hash}.html`)).href) });
  }
  return { registrations, refused };
}
