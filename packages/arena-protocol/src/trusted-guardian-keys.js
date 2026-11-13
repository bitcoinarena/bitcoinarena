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
import { thresholdOf, splitSignedRecord, federationRecordId } from './federation-record.js';
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


// WHICH INVITES THE FETCH ASKS (kanban #2618, feedback #047 against #2609): the first 8 invites of any record were kept for good, and a record's
// invite only has to name the federation id - its URLs are its author's. Eight bonded strangers' records with junk invites, noted first, filled
// every slot: the genuine endpoints were asked 0 times (the junk ones 56) and the seat stayed keyless. Now, per federation:
//   EVICTED    an invite that fails - none of its URLs answers a config hashing to the id, or the endpoints it led to reach no threshold -
//              leaves the book at once and is remembered failed for TGK_FAILED_MS: not taken again, not asked again, in that time
//   TRUSTED    a plain-string invite is a trusted source (the seat's own invite, the kept record's, the round's on the page) and is asked
//              first, with an invite that already led to agreed keys; the records' invites only when those found no endpoints
//   PER SIGNER a record's invite ({ invite, signers }) is taken only while one of its record's verified signers backs fewer than
//              TGK_PER_SIGNER invites (in the book or remembered failed), and charges every one of them: strangers cannot crowd out an invite
//              the genuine guardians signed, and k strangers bring at most k * TGK_PER_SIGNER a window
//   BOUNDED    at most TGK_BOOK invites a federation; a new one replaces the untried record invite of the most crowded signers (not one less
//              crowded than itself), never a trusted or good one
//   ONE KEY    once keys are agreed nothing is asked until the hit expires (keepMs)
// Each invite is asked at at most TGK_URLS_PER_INVITE of its URLs.
export const TGK_PER_SIGNER = 2, TGK_BOOK = 16, TGK_FAILED_MS = 600000, TGK_URLS_PER_INVITE = 8;

/** The invite of a signed record and the node keys (hex) whose signatures over it verify - what a record's invite is charged to. Null if none. */
export function recordInviteSource(bytes, verify) {
  let s; try { s = splitSignedRecord(bytes); } catch { return null; }
  const invite = s.record && typeof s.record.invite === 'string' ? s.record.invite : null;
  if (!invite || typeof verify !== 'function') return null;
  let id; try { id = federationRecordId(s.record); } catch { return null; }
  const signers = [];
  for (const g of s.signatures) { let ok = false; try { ok = !!verify(g.signature, id, g.nodePubkey); } catch { ok = false; } if (ok) signers.push(tgkHex(g.nodePubkey)); }
  return signers.length ? { invite, signers: [...new Set(signers)] } : null;
}

function tgkEntryOf(cache, fid) {
  let e = cache.get(fid);
  if (!e) { e = { at: 0, r: null, pending: null, book: new Map(), failed: new Map(), endpoints: null, seq: 0 }; cache.set(fid, e); }
  if (!e.book) Object.assign(e, { book: new Map(), failed: new Map(), endpoints: null, seq: 0 });
  return e;
}
/** Take `src` (a trusted invite string, or { invite, signers }) into the federation's book, as the rules above say. */
function tgkAdmit(e, src, t) {
  const trusted = typeof src === 'string';
  const inv = trusted ? src : src && typeof src.invite === 'string' ? src.invite : null;
  if (!inv) return;
  for (const [k, f] of e.failed) if (f.until <= t) e.failed.delete(k);
  if (e.failed.has(inv)) return;
  const had = e.book.get(inv);
  if (had) { if (trusted) had.trusted = true; return; }
  let signers = [];
  if (!trusted) {
    signers = Array.isArray(src.signers) ? src.signers.filter((x) => typeof x === 'string') : [];
    if (!signers.length) return;
    const backs = new Map();
    for (const x of [...e.book.values(), ...e.failed.values()]) for (const s of x.signers || []) backs.set(s, (backs.get(s) || 0) + 1);
    if (!signers.some((s) => (backs.get(s) || 0) < TGK_PER_SIGNER)) return;
  }
  if (e.book.size >= TGK_BOOK) {
    // full: the untried record invite of the most crowded signers goes (an entry's crowding is its least-charged signer's count: what it
    // stands on), the oldest of those - never a trusted or good one, and never one less crowded than the newcomer
    const backs = new Map();
    for (const x of [...e.book.values(), ...e.failed.values()]) for (const s of x.signers || []) backs.set(s, (backs.get(s) || 0) + 1);
    const crowd = (sg) => (sg.length ? Math.min(...sg.map((s) => backs.get(s) || 0)) : Infinity);
    const mine = trusted ? -1 : crowd(signers) + 1;
    const old = [...e.book.entries()].filter(([, x]) => !x.trusted && x.state === 'untried')
      .map(([k, x]) => ({ k, c: crowd(x.signers), seq: x.seq })).sort((p, q) => q.c - p.c || p.seq - q.seq)[0];
    if (!old || (!trusted && old.c < mine)) { if (!trusted) return; } else e.book.delete(old.k);
  }
  e.book.set(inv, { trusted, state: 'untried', signers, seq: ++e.seq });
}
function tgkFail(e, inv, t) {
  const x = e.book.get(inv);
  e.book.delete(inv);
  e.failed.set(inv, { until: t + TGK_FAILED_MS, signers: x ? x.signers : [] });
  if (e.failed.size > 256) e.failed.delete(e.failed.keys().next().value);
}

/**
 * trustedGuardianKeys(federationId, invites, fetcher) -> { ok, keys: [hex, peer order], threshold, n, agreed, endpoints, why, asked }.
 * `federationId` hex or 32 bytes; `invites` one or a list: a string is a trusted source, { invite, signers } a record's (recordInviteSource) -
 * where to ask, never what to believe; `fetcher(url) -> config JSON`. Kept in `cache` (a Map, per federation): a hit for `keepMs`, a miss for
 * `missMs` unless the book holds an untried invite.
 */
export async function trustedGuardianKeys(federationId, invite, fetcher = wsAskClientConfig, { cache = TGK_DEFAULT_CACHE, timeoutMs = 6000, keepMs = 3600000, missMs = 60000, now = () => Date.now() } = {}) {
  const fid = typeof federationId === 'string' ? federationId.toLowerCase() : tgkHex(federationId);
  const e = tgkEntryOf(cache, fid);
  for (const src of Array.isArray(invite) ? invite : [invite]) tgkAdmit(e, src, now());
  if (e.pending) return e.pending;
  if (e.r && e.r.ok && now() - e.at < keepMs) return e.r;
  const untried = [...e.book.values()].some((x) => x.state === 'untried');
  if (e.r && !e.r.ok && now() - e.at < missMs && !untried) return e.r;
  e.pending = tgkFetchKeys(fid, e, fetcher, timeoutMs, now).catch((err) => ({ ok: false, why: err.message }));
  const r = await e.pending;
  e.pending = null;
  // a federation's keys do not change: once agreed, a later miss keeps them
  if (r.ok || !(e.r && e.r.ok)) e.r = r;
  e.at = now();
  return e.r;
}
const TGK_DEFAULT_CACHE = new Map();

async function tgkFetchKeys(fid, e, fetcher, timeoutMs, now) {
  if (!/^[0-9a-f]{64}$/.test(fid)) return { ok: false, why: 'not a federation id' };
  const answers = new Map();                 // url -> config | null
  const asked = { n: 0 };
  const ask = (url) => {
    if (!answers.has(url)) { asked.n++; answers.set(url, tgkBounded(fetcher(url), timeoutMs).then((c) => c, () => null)); }
    return answers.get(url);
  };
  // 1. the endpoints the id commits to: once an answer hashed to the id they are kept (e.endpoints); else from the book, the trusted and good
  // invites first, the records' invites only when those found none. An invite none of whose URLs answers such a config is evicted
  let endpoints = e.endpoints, from = null;
  const tryInvites = async (list) => {
    await Promise.all(list.map(async ([inv]) => {
      let urls = [];
      try { const r = readInvite(inv); if (r.federationId === fid) urls = [...new Set(r.guardians.map((g) => g.url))].slice(0, TGK_URLS_PER_INVITE); } catch { urls = []; }
      let hit = null;
      for (const c of await Promise.all(urls.map(ask))) if (!hit && c && federationIdOfConfig(c) === fid) hit = configApiEndpoints(c);
      if (!hit) { tgkFail(e, inv, now()); return; }
      if (!endpoints) { endpoints = hit; from = inv; }
      else if (!from) from = inv;
    }));
  };
  if (!endpoints) {
    const all = [...e.book.entries()];
    await tryInvites(all.filter(([, x]) => x.trusted || x.state === 'good'));
    if (!endpoints) await tryInvites(all.filter(([, x]) => !x.trusted && x.state !== 'good'));
  }
  if (!endpoints) return { ok: false, asked: asked.n, why: e.book.size || e.failed.size ? 'no guardian at the invites answered a config whose endpoints hash to the federation id' : 'no invite of this federation to ask' };
  e.endpoints = endpoints;
  // 2. every committed endpoint's config; the keys only from thresholdOf(n) identical answers that hash to the id
  const n = endpoints.length, threshold = thresholdOf(n);
  const got = await Promise.all(endpoints.map((x) => ask(x.url)));
  const groups = new Map();
  for (const c of got) {
    if (!c || federationIdOfConfig(c) !== fid) continue;
    const a = tgkAgreedPart(c);
    if (a) groups.set(a, (groups.get(a) || 0) + 1);
  }
  const [best, count] = [...groups.entries()].sort((p, q) => q[1] - p[1])[0] || [null, 0];
  if (!best || count < threshold) {
    // no threshold: the invite that led here is evicted too (the endpoints stay known - the id committed to them - and are asked next time)
    if (from && e.book.has(from)) tgkFail(e, from, now());
    return { ok: false, n, threshold, agreed: count, asked: asked.n, why: `${count} of ${n} guardians answered one config, ${threshold} needed` };
  }
  if (from && e.book.has(from)) e.book.get(from).state = 'good';
  const a = JSON.parse(best);
  return { ok: true, keys: a.keys, threshold, n, agreed: count, asked: asked.n, endpoints: a.eps.map(([peer, url, name]) => ({ peer, url, name })) };
}

/**
 * A per-federation source for a page, a seat or the arbiter: of(fid, invites) -> Promise<keys hex[] | null> (invites as trustedGuardianKeys
 * takes them); known(fid) -> 33-byte keys | null at once (what a synchronous caller - federationStatuses - reads while the fetch runs: null
 * until agreed, the keyless rules meanwhile); learn(fid, invites) starts the fetch in the background; book(fid) what the fetch holds.
 */
export function createTrustedGuardianKeys({ fetcher = wsAskClientConfig, timeoutMs = 6000, keepMs = 3600000, missMs = 60000, now = () => Date.now(), onKeys = null } = {}) {
  const cache = new Map();
  const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  async function of(fidHex, inv = []) {
    const fid = String(fidHex).toLowerCase();
    const before = cache.get(fid);
    const hadKeys = !!(before && before.r && before.r.ok);
    const r = await trustedGuardianKeys(fid, (Array.isArray(inv) ? inv : [inv]).filter(Boolean), fetcher, { cache, timeoutMs, keepMs, missMs, now });
    if (r.ok && !hadKeys && typeof onKeys === 'function') { try { onKeys(fid, r); } catch { /* the caller's */ } }
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
  const book = (fidHex) => { const h = cache.get(String(fidHex).toLowerCase()); return h && h.book ? { book: [...h.book].map(([invite, x]) => ({ invite, ...x })), failed: [...h.failed.keys()] } : null; };
  // the synchronous guardianKeysOf federationStatuses takes, carrying learn and wait
  const guardianKeysOf = Object.assign((fidHex) => known(fidHex), { learn, wait });
  return { of, known, learn, wait, result, book, guardianKeysOf };
}
