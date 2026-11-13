// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEDERATION'S GUARDIAN ADDRESSES, FROM ITS OWN CONFIGURATION (2026-10-15: the endpoint gap). A node advertises
// one guardian_endpoint; during a succession a guardian seated first runs two fedimintd - its old federation's at /guardian and its
// successor's at /guardian-next (node-start.js) - so the advert cannot name both. Each federation's key ceremony wrote its own
// guardians' API URLs into its client configuration (`api_endpoints`, by peer id, beside `broadcast_public_keys`, the peer keys a
// record lists); that is what its invite names and what its clients dial. A record's guardian endpoints are read from there:
//
//   LOCAL    a node guarding the federation reads its own guardian's client.json (<store>.guardian or <store>.guardian-next,
//            whichever one's invite-code names the federation)
//   ASKED    any other seat asks the federation itself, the stock JSON-RPC `client_config`, at the API URLs its invite names
//
// Every guardian of a federation holds the same client configuration, so every seat builds the same endpoints. A seat that reads
// neither keeps the advert's endpoint (federation-records.js) - which is what every record carried before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInvite, inviteForGuardians } from './invite.js';

/** peer key hex -> API URL, from a client configuration (client.json, or the `client_config` answer; flat or under `global`). */
export function configEndpoints(config) {
  const g = (config && (config.global || config)) || {};
  const urls = g.api_endpoints || {}, keys = g.broadcast_public_keys || {};
  const out = new Map();
  for (const [peer, key] of Object.entries(keys)) {
    const e = urls[peer];
    const url = e && (typeof e === 'string' ? e : e.url);
    if (url && /^[0-9a-f]{66}$/i.test(String(key))) out.set(String(key).toLowerCase(), String(url));
  }
  return out;
}

/**
 * THE ONE INVITE A FEDERATION'S GUARDIAN SEATS AGREE ON (kanban #549, measured 2026-10-20 ~07:35Z: the successor 4dc88be7's six
 * guardian seats each signed its record with their own guardian's invite-code - one guardian's URL each - so no two signed the same
 * body and the gatherer counted 1 of the 5 signatures it needs): every guardian, in peer order, from the federation's own
 * configuration, which every guardian holds alike. Null when the configuration names none.
 */
export function configInvite(federationIdHex, config) {
  const urls = (config && ((config.global && config.global.api_endpoints) || config.api_endpoints)) || {};
  const guardians = Object.entries(urls).map(([peer, e]) => ({ peer: Number(peer), url: String(e && (typeof e === 'string' ? e : e.url) || '') }))
    .filter((g) => Number.isInteger(g.peer) && g.url).sort((a, b) => a.peer - b.peer);
  if (!guardians.length || !/^[0-9a-f]{64}$/i.test(String(federationIdHex))) return null;
  try { return inviteForGuardians(Uint8Array.from(String(federationIdHex).match(/../g).map((x) => parseInt(x, 16))), guardians); } catch { return null; }
}

/** The stock `client_config` over the guardian API's WebSocket. */
export async function wsClientConfig(url, { timeoutMs = 10000, WebSocketImpl = null } = {}) {
  if (!/^wss?:\/\//.test(String(url))) throw new Error(`no guardian API to ask: ${url}`);
  const WS = WebSocketImpl || (await import('ws')).default;
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const done = (f, v) => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } f(v); };
    const t = setTimeout(() => done(reject, new Error('no answer in time')), timeoutMs);
    ws.on('error', (e) => done(reject, e));
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'client_config', params: [{ auth: null, params: null }] })));
    ws.on('message', (m) => { try { const j = JSON.parse(String(m)); if (j.id === 1) done(j.result ? resolve : reject, j.result || new Error(JSON.stringify(j.error || j))); } catch (e) { done(reject, e); } });
  });
}

/** The federation a guardian data dir guards: its invite-code's federation id (hex), or null before its ceremony. */
export function federationOfDir(dir, readFile = (f) => readFileSync(f, 'utf8')) {
  try { return readInvite(readFile(join(dir, 'invite-code')).trim().replace(/"/g, '')).federationId; } catch { return null; }
}

/**
 * endpointsOf(fidHex) -> Map(peer key hex -> url) | null. `dirs()` this node's guardian data dirs; `inviteOf(fidHex)` the invite this seat
 * holds; kept `keepMs` once read (`missMs` when nothing answered).
 */
export function createEndpointsOf({ dirs = () => [], inviteOf = () => null, ask = wsClientConfig, readFile = (f) => readFileSync(f, 'utf8'),
  keepMs = 600000, missMs = 60000, now = () => Date.now() }) {
  const kept = new Map();                    // fid -> { at, map, from }
  async function read(fid) {
    for (const dir of (dirs() || []).filter(Boolean)) {
      if (federationOfDir(dir, readFile) !== fid) continue;
      try { const m = configEndpoints(JSON.parse(readFile(join(dir, 'client.json')))); if (m.size) return { map: m, from: `local ${dir}` }; } catch { /* asked below */ }
    }
    let urls = [];
    try { const inv = inviteOf(fid); urls = inv ? readInvite(inv).guardians.map((g) => g.url) : []; } catch { urls = []; }
    for (const u of urls) {
      try { const m = configEndpoints(await ask(u)); if (m.size) return { map: m, from: `asked ${u}` }; } catch { /* the next */ }
    }
    return { map: null, from: null };
  }
  const endpointsOf = async (fidHex) => {
    const fid = String(fidHex).toLowerCase();
    const had = kept.get(fid);
    if (had && now() - had.at < (had.map ? keepMs : missMs)) return had.map;
    const r = await read(fid);
    kept.set(fid, { at: now(), ...r });
    return r.map;
  };
  endpointsOf.from = (fidHex) => (kept.get(String(fidHex).toLowerCase()) || {}).from || null;
  return endpointsOf;
}

/** The guardians with each one's endpoint from `map` (peer key hex -> url) where it names it; the advert's otherwise. */
export const withConfigEndpoints = (guardians, map, toHex) => (map ? guardians.map((g) => (map.has(toHex(g.peerKey)) ? { ...g, endpoint: map.get(toHex(g.peerKey)) } : g)) : guardians);

/** The guardian keys (hex, peer order) of a client configuration: its `broadcast_public_keys` (flat or under `global`), or null. */
export function configKeys(config) {
  const g = (config && (config.global || config)) || {};
  const keys = Object.entries(g.broadcast_public_keys || {}).filter(([peer]) => /^\d+$/.test(peer)).sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, k]) => String(k).toLowerCase());
  return keys.length && keys.every((k) => /^[0-9a-f]{66}$/.test(k)) ? keys : null;
}

/**
 * THE FEDERATION'S OWN GUARDIAN KEYS, WHEN THIS SEAT HOLDS ITS CONFIG (kanban #2603): guardianKeysOf(fidHex) -> [33-byte key] | null.
 *   LOCAL    a guardian data dir of this node whose invite-code names the federation: its client.json
 *   JOINED   the stake-lock client of that federation, home or joined before (`joinedPort(fidHex)`, never a new join): the keys of
 *            the config it downloaded at its join - the same source federationIsBonded counts a round's guardians from
 *   TRUSTED  (kanban #2609) any other federation: `trusted` (arena-protocol trusted-guardian-keys.js createTrustedGuardianKeys) - the config
 *            whose api_endpoints hash to the federation id, answered alike by thresholdOf(n) of those endpoints; asked first at the
 *            invites `inviteOf(fidHex)` and the caller's `{ invites }` name (records' invites: never trusted, the id check decides)
 * Never one guardian's config alone: one guardian answering for the federation could name only its own key, which is the #2599 record
 * again. Kept `keepMs` once read (`missMs` when nothing held it; the trusted source keeps its own).
 */
export function createGuardianKeysOf({ dirs = () => [], joinedPort = async () => null, readFile = (f) => readFileSync(f, 'utf8'),
  trusted = null, inviteOf = () => null,
  keepMs = 600000, missMs = 60000, now = () => Date.now(), fromHex = (h) => Uint8Array.from(String(h).match(/../g).map((x) => parseInt(x, 16))) }) {
  const kept = new Map();                    // fid -> { at, keys, from }
  async function read(fid) {
    for (const dir of (dirs() || []).filter(Boolean)) {
      if (federationOfDir(dir, readFile) !== fid) continue;
      try { const k = configKeys(JSON.parse(readFile(join(dir, 'client.json')))); if (k) return { keys: k.map(fromHex), from: `local ${dir}` }; } catch { /* the port below */ }
    }
    try {
      const port = await joinedPort(fid);
      const g = port && typeof port.guardians === 'function' ? await port.guardians() : null;
      const gid = g && g.federationId ? (typeof g.federationId === 'string' ? g.federationId : Array.from(g.federationId, (x) => x.toString(16).padStart(2, '0')).join('')) : null;
      if (g && String(gid).toLowerCase() === fid && Array.isArray(g.keys) && g.keys.length && g.keys.every((k) => k instanceof Uint8Array && k.length === 33))
        return { keys: g.keys, from: 'stake-lock client' };
    } catch { /* none */ }
    return { keys: null, from: null };
  }
  async function viaTrusted(fid, invites) {
    if (!trusted || typeof trusted.of !== 'function') return null;
    let own = null; try { own = inviteOf(fid); } catch { own = null; }
    try { const k = await trusted.of(fid, [own, ...(invites || [])].filter(Boolean)); return Array.isArray(k) && k.length ? k.map(fromHex) : null; } catch { return null; }
  }
  const guardianKeysOf = async (fidHex, { invites = [] } = {}) => {
    const fid = String(fidHex).toLowerCase();
    let had = kept.get(fid);
    if (!(had && now() - had.at < (had.keys ? keepMs : missMs))) {
      const r = await read(fid);
      // a federation's keys do not change: once read, a later miss keeps them
      kept.set(fid, r.keys || !had || !had.keys ? { at: now(), ...r } : { ...had, at: now() });
      had = kept.get(fid);
    }
    if (had.keys) return had.keys;
    // no local or joined config: the trusted fetch (it keeps its own hits and misses)
    const k = await viaTrusted(fid, invites);
    if (k) { kept.set(fid, { at: now(), keys: k, from: 'trusted fetch' }); return k; }
    return null;
  };
  guardianKeysOf.from = (fidHex) => (kept.get(String(fidHex).toLowerCase()) || {}).from || null;
  return guardianKeysOf;
}
