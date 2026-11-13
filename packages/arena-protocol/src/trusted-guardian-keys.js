// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S GUARDIAN KEYS FROM A SOURCE NO BONDED STRANGER CAN WRITE (kanban #2609, owner decision 2026-11-13 "löse alle").
//
// Without the federation's own guardian keys a record of it is judged by counting, and every counting rule loses to enough bonds
// (#2599/#2603/#2604/#2605/#2611/#2613/#2614/#2615, feedback #037-#045). The keys are in the federation's client config
// (`broadcast_public_keys`), and the federation id commits to that config's guardian API endpoints:
//
//   fedimint-core/src/config.rs:271  GlobalClientConfig::calculate_federation_id() = FederationId(self.api_endpoints.consensus_hash())
//
// i.e. sha256 over the consensus encoding of BTreeMap<PeerId, PeerUrl { url, name }>: BigSize(n), then per peer in id order BigSize(peer),
// BigSize(len) url bytes, BigSize(len) name bytes (encoding/collections.rs:182, mod.rs:444-446, mod.rs:600, mod.rs:368). Measured against
// the client.json and invite-code of federation 337ae01a (testnet4, 7 guardians) and 423e010e (regtest): the id matches byte for byte.
// The id does NOT commit to broadcast_public_keys - so the keys are taken the way fedimint's own client takes its config
// (fedimint-api-client/src/lib.rs:63-112, try_download_client_config): the endpoints from any answer whose api_endpoints hash to the
// id, then the config from every one of those endpoints, and the keys only when thresholdOf(n) of them answer the identical config.
//
// What this still trusts: the guardians at the endpoints the id commits to - a threshold of them (the federation itself) could name
// other keys - and the transport to those URLs (TLS/DNS of the hosts the guardians chose). A bonded stranger can do neither: it cannot
// change the endpoints without changing the id, and it is not a threshold of them. The invite only says where to ask first; an invite
// naming strangers' URLs gets nothing past the id check.
import { sha256bytes } from './sha256.js';
import { utf8Encode } from './utf8.js';
import { thresholdOf } from './federation-record.js';
import { readInvite } from '../../arena-node/src/invite.js';

const tgkHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function tgkBigSize(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n >> 8, n & 255];
  return [0xfe, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
const tgkEncStr = (s) => { const b = utf8Encode(String(s)); return [...tgkBigSize(b.length), ...b]; };

/** The config's global part (the `client_config` answer is { global, modules }; a client.json may be flat). */
const tgkGlobalOf = (config) => (config && typeof config === 'object' ? (config.global && typeof config.global === 'object' ? config.global : config) : null);

/** [{ peer, url, name }] in peer order from a config's api_endpoints, or null when one does not read. */
export function configApiEndpoints(config) {
  const g = tgkGlobalOf(config);
  const eps = g && g.api_endpoints;
  if (!eps || typeof eps !== 'object') return null;
  const out = [];
  for (const [peer, e] of Object.entries(eps)) {
    if (!/^\d+$/.test(peer) || Number(peer) > 0xffff || !e || typeof e.url !== 'string' || typeof e.name !== 'string') return null;
    out.push({ peer: Number(peer), url: e.url, name: e.name });
  }
  return out.length ? out.sort((a, b) => a.peer - b.peer) : null;
}

/** The federation id (hex) a client config's api_endpoints hash to - fedimint's calculate_federation_id - or null. */
export function federationIdOfConfig(config) {
  const eps = configApiEndpoints(config);
  if (!eps) return null;
  const out = [...tgkBigSize(eps.length)];
  for (const e of eps) out.push(...tgkBigSize(e.peer), ...tgkEncStr(e.url), ...tgkEncStr(e.name));
  return tgkHex(sha256bytes(Uint8Array.from(out)));
}

/** What the guardians must agree on, as one string: the endpoints, the keys, the consensus version. Null when the keys do not read. */
function tgkAgreedPart(config) {
  const g = tgkGlobalOf(config), eps = configApiEndpoints(config);
  const keys = g && g.broadcast_public_keys;
  if (!eps || !keys || typeof keys !== 'object') return null;
  const k = eps.map((e) => String(keys[String(e.peer)] || '').toLowerCase());
  if (Object.keys(keys).length !== eps.length || !k.every((x) => /^0[23][0-9a-f]{64}$/.test(x))) return null;
  const cv = g.consensus_version || null;
  return JSON.stringify({ eps: eps.map((e) => [e.peer, e.url, e.name]), keys: k, cv: cv ? [cv.major, cv.minor] : null });
}

/** The stock `client_config` JSON-RPC over a guardian's WebSocket (the browser's, or Node's global WebSocket). */
export function wsAskClientConfig(url, { timeoutMs = 6000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^wss?:\/\//.test(String(url))) { reject(new Error(`no guardian API to ask: ${url}`)); return; }
    if (typeof WebSocketImpl !== 'function') { reject(new Error('no WebSocket here')); return; }
    let ws; try { ws = new WebSocketImpl(url); } catch (e) { reject(e); return; }
    const done = (f, v) => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } f(v); };
    const t = setTimeout(() => done(reject, new Error('no answer in time')), timeoutMs);
    ws.onerror = () => done(reject, new Error(`${url}: socket error`));
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'client_config', params: [{ auth: null, params: null }] }));
    ws.onmessage = (m) => { try { const j = JSON.parse(String(m.data)); if (j.id === 1) done(j.result ? resolve : reject, j.result || new Error(JSON.stringify(j.error || j))); } catch (e) { done(reject, e); } };
  });
}

const tgkBounded = (p, ms) => Promise.race([Promise.resolve(p), new Promise((_, no) => setTimeout(() => no(new Error('no answer in time')), ms))]);

/**
 * trustedGuardianKeys(federationId, invite, fetcher) -> { ok, keys: [hex, peer order], threshold, n, agreed, endpoints, why }.
 * `federationId` hex or 32 bytes; `invite` one invite or a list (where to ask first - never trusted); `fetcher(url) -> config JSON`.
 * Kept in `cache` (a Map, per federation): a hit for `keepMs`, a miss for `missMs` unless a new invite is given.
 */
export async function trustedGuardianKeys(federationId, invite, fetcher = wsAskClientConfig, { cache = TGK_DEFAULT_CACHE, timeoutMs = 6000, keepMs = 3600000, missMs = 60000, now = () => Date.now() } = {}) {
  const fid = typeof federationId === 'string' ? federationId.toLowerCase() : tgkHex(federationId);
  const invites = [...new Set((Array.isArray(invite) ? invite : [invite]).filter((x) => typeof x === 'string' && x))];
  const had = cache && cache.get(fid);
  if (had && !had.pending) {
    if (had.r.ok && now() - had.at < keepMs) return had.r;
    if (!had.r.ok && now() - had.at < missMs && invites.every((i) => had.tried.has(i))) return had.r;
  }
  if (had && had.pending) return had.pending;
  const tried = new Set([...(had && had.tried ? had.tried : []), ...invites]);
  const pending = tgkFetchKeys(fid, invites, fetcher, timeoutMs).catch((e) => ({ ok: false, why: e.message }));
  if (cache) cache.set(fid, { pending, tried, at: now(), r: had && had.r });
  const r = await pending;
  // a federation's keys do not change: once agreed, a later miss keeps them
  if (cache) cache.set(fid, { at: now(), tried, r: !r.ok && had && had.r && had.r.ok ? had.r : r });
  return cache ? cache.get(fid).r : r;
}
const TGK_DEFAULT_CACHE = new Map();

async function tgkFetchKeys(fid, invites, fetcher, timeoutMs) {
  if (!/^[0-9a-f]{64}$/.test(fid)) return { ok: false, why: 'not a federation id' };
  const answers = new Map();                 // url -> config | null
  const ask = (url) => {
    if (!answers.has(url)) answers.set(url, tgkBounded(fetcher(url), timeoutMs).then((c) => c, () => null));
    return answers.get(url);
  };
  // 1. the endpoints the id commits to: from any answer at an invite's URLs whose api_endpoints hash to the id
  const urls = [];
  for (const inv of invites) {
    try { const r = readInvite(inv); if (r.federationId === fid) urls.push(...r.guardians.map((g) => g.url)); } catch { /* not an invite */ }
  }
  if (!urls.length) return { ok: false, why: 'no invite of this federation to ask' };
  let endpoints = null;
  await Promise.all([...new Set(urls)].map(async (u) => {
    const c = await ask(u);
    if (!endpoints && c && federationIdOfConfig(c) === fid) endpoints = configApiEndpoints(c);
  }));
  if (!endpoints) return { ok: false, why: 'no guardian at the invite answered a config whose endpoints hash to the federation id' };
  // 2. every committed endpoint's config; the keys only from thresholdOf(n) identical answers that hash to the id
  const n = endpoints.length, threshold = thresholdOf(n);
  const got = await Promise.all(endpoints.map((e) => ask(e.url)));
  const groups = new Map();
  for (const c of got) {
    if (!c || federationIdOfConfig(c) !== fid) continue;
    const a = tgkAgreedPart(c);
    if (a) groups.set(a, (groups.get(a) || 0) + 1);
  }
  const [best, count] = [...groups.entries()].sort((p, q) => q[1] - p[1])[0] || [null, 0];
  if (!best || count < threshold) return { ok: false, n, threshold, agreed: count, why: `${count} of ${n} guardians answered one config, ${threshold} needed` };
  const a = JSON.parse(best);
  return { ok: true, keys: a.keys, threshold, n, agreed: count, endpoints: a.eps.map(([peer, url, name]) => ({ peer, url, name })) };
}

/**
 * A per-federation source for a page or a seat: of(fid, invites) -> Promise<keys hex[] | null>; known(fid) -> 33-byte keys | null at once
 * (what a synchronous caller - federationStatuses - reads while the fetch runs: null until agreed, the keyless rules meanwhile);
 * learn(fid, invite) notes an invite and starts the fetch in the background.
 */
export function createTrustedGuardianKeys({ fetcher = wsAskClientConfig, timeoutMs = 6000, keepMs = 3600000, missMs = 60000, now = () => Date.now(), onKeys = null } = {}) {
  const cache = new Map(), invites = new Map();
  const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const note = (fid, inv) => {
    if (typeof inv !== 'string' || !inv) return;
    if (!invites.has(fid)) invites.set(fid, new Set());
    const s = invites.get(fid);
    if (!s.has(inv) && s.size < 8) s.add(inv);
  };
  async function of(fidHex, inv = []) {
    const fid = String(fidHex).toLowerCase();
    for (const i of Array.isArray(inv) ? inv : [inv]) note(fid, i);
    const had = cache.get(fid);
    const r = await trustedGuardianKeys(fid, [...(invites.get(fid) || [])], fetcher, { cache, timeoutMs, keepMs, missMs, now });
    if (r.ok && !(had && had.r && had.r.ok) && typeof onKeys === 'function') { try { onKeys(fid, r); } catch { /* the caller's */ } }
    return r.ok ? r.keys : null;
  }
  function known(fidHex) {
    const h = cache.get(String(fidHex).toLowerCase());
    return h && h.r && h.r.ok ? h.r.keys.map(fromHex) : null;
  }
  function learn(fidHex, inv) { of(fidHex, inv).catch(() => null); }
  // learn, and wait at most `ms` for the answer (a page's read waits this long once, then judges keyless and picks the keys up next time)
  async function wait(fidHex, inv, ms = 2000) {
    const p = of(fidHex, inv).catch(() => null);
    await Promise.race([p, new Promise((ok) => setTimeout(ok, ms))]);
    return known(fidHex);
  }
  const result = (fidHex) => { const h = cache.get(String(fidHex).toLowerCase()); return (h && h.r) || null; };
  // the synchronous guardianKeysOf federationStatuses takes, carrying learn and wait
  const guardianKeysOf = Object.assign((fidHex) => known(fidHex), { learn, wait });
  return { of, known, learn, wait, result, guardianKeysOf };
}
