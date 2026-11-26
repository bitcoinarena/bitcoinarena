// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CAN THE NETWORK REACH THIS NODE? (kanban #3798, the owner 2026-11-26: "eine eigene Test/Diagnose-Seite, ob der Tunnel von aussen erreichbar
// ist"). The owner page's "Check my node" asks three seats GET /reach-probe?node=<key>; each seat dials the addresses IT holds for that node -
// the census advert's endpoint(s) and the node's newest signed announcement - asks GET /identity there and says, per address, whether that
// node's key answered, how long it took, and if not, why (the name does not resolve, a broken certificate, no answer in time, an HTTP error,
// another node). Seen live: a census still naming a dead quick tunnel (#3565), a Funnel address no seat could reach (#3723), a node that
// answered in 8-13 s (bitcoind's RPC queue full).
//
// NOT AN OPEN PROXY (the #3700 rules): the asker names a node KEY, never an address - the seat dials only what the census and its address book
// name for that key, each held to peerEndpointRefusal (no loopback/private literal or local name) and to the process's connect-time dial
// guard (dial-guard.js: a name resolving to a private address fails). One fixed path, no redirect followed, at most 64 bytes read, and the
// answer says only reached / kind / HTTP status / ms - never what the address sent. At most PROBE_PER_MINUTE fresh probes per asking address,
// PROBE_ALL_PER_MINUTE in all; a node's answer is kept PROBE_KEEP_MS and shared by everyone asking meanwhile.
import { canonicalAddress, askerAddress } from './reach-check.js';

export const PROBE_TIMEOUT_MS = 8000;
export const PROBE_PER_MINUTE = 6;
export const PROBE_ALL_PER_MINUTE = 30;
export const PROBE_KEEP_MS = 30000;
export const PROBE_TARGETS_MOST = 3;
const KEY = /^[0-9a-f]{64}$/;
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

/** The addresses a seat dials for a node: its census endpoints, then its newest announced one - each once, at most PROBE_TARGETS_MOST. */
export function probeTargets({ census = [], announced = null, refusal = () => null }) {
  const out = [];
  const add = (url, from) => {
    if (!url) return;
    const had = out.find((t) => norm(t.url) === norm(url));
    if (had) { if (!had.from.includes(from)) had.from.push(from); return; }
    if (out.length >= PROBE_TARGETS_MOST || refusal(url)) return;
    out.push({ url: String(url).replace(/\/+$/, ''), from: [from] });
  };
  for (const u of census) add(u, 'census');
  add(announced, 'announced');
  return out;
}

/** What a failed fetch was, in one word: dns | tls | timeout | refused | blocked | connect. */
export function failureKind(e) {
  // a timeout is a DOMException (name TimeoutError, a numeric code); a network failure a TypeError with the system error as its cause
  const code = [e && e.name, e && e.code, e && e.cause && e.cause.code, e && e.cause && e.cause.name].filter((x) => typeof x === 'string').join(' ');
  const msg = String((e && e.cause && e.cause.message) || (e && e.message) || '');
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) return 'dns';
  if (/CERT|SSL|TLS|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate|ssl|tls/i.test(msg)) return 'tls';
  if (/ECONNREFUSED/.test(code)) return 'refused';
  if (/EARENA_INTERNAL_ADDRESS/.test(code) || /loopback or private address/i.test(msg)) return 'blocked';
  return 'connect';
}

/** GET <origin>/identity once: does `node`'s key answer? { reached, ms, kind?, status? } - kind: http | other-node | <failureKind>. */
export async function probeOne(url, node, { fetchFn = fetch, timeoutMs = PROBE_TIMEOUT_MS, nowMs = () => Date.now() } = {}) {
  const origin = String(url).replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
  const t0 = nowMs();
  try {
    const r = await fetchFn(`${origin}/identity`, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/octet-stream' } });
    const ms = nowMs() - t0;
    if (r.status !== 200) { try { await r.body?.cancel(); } catch { /* gone */ } return { reached: false, ms, kind: 'http', status: r.status }; }
    const b = new Uint8Array(await r.arrayBuffer()).slice(0, 64);
    const hex = Buffer.from(b).toString('hex');
    return hex === node ? { reached: true, ms: nowMs() - t0 } : { reached: false, ms, kind: 'other-node' };
  } catch (e) { return { reached: false, ms: nowMs() - t0, kind: failureKind(e) }; }
}

/**
 * The door's logic. `targetsOf(nodeHex)` answers { census: [endpoint...], announced: endpoint | null } as this seat holds them; `probe(url,
 * node)` probeOne. Answers { status, body }.
 */
export function createReachProbe({ targetsOf, refusal = () => null, probe = probeOne, nowMs = () => Date.now(), env = process.env } = {}) {
  const asks = new Map(), kept = new Map(), running = new Map();
  let all = [];
  return async function reachProbe(req, nodeParam) {
    const node = String(nodeParam || '').toLowerCase();
    if (!KEY.test(node)) return { status: 400, body: { ok: false, why: 'GET /reach-probe?node=<64 hex>' } };
    const now = nowMs();
    const k = kept.get(node);
    if (k && now - k.at < PROBE_KEEP_MS) return { status: 200, body: { ...k.body, keptMs: now - k.at } };
    if (running.has(node)) return { status: 200, body: await running.get(node) };
    const ip = canonicalAddress(askerAddress(req, { env }));
    const recent = (asks.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= PROBE_PER_MINUTE) return { status: 429, body: { ok: false, why: `at most ${PROBE_PER_MINUTE} checks a minute` } };
    all = all.filter((t) => now - t < 60000);
    if (all.length >= PROBE_ALL_PER_MINUTE) return { status: 429, body: { ok: false, why: 'this seat is busy with checks: ask another one' } };
    let held; try { held = (await targetsOf(node)) || {}; } catch { held = {}; }
    const census = (held.census || []).map(String), announced = held.announced ? String(held.announced) : null;
    const targets = probeTargets({ census, announced, refusal });
    if (!targets.length) return { status: 404, body: { ok: false, node, census, announced, why: 'this seat holds no address for that node' } };
    recent.push(now); asks.set(ip, recent); all.push(now);
    if (asks.size > 10000) for (const [a, v] of asks) if (!v.some((t) => now - t < 60000)) asks.delete(a);
    const job = (async () => {
      const results = await Promise.all(targets.map(async (t) => ({ ...t, ...(await probe(t.url, node)) })));
      const body = { ok: true, node, census, announced, results, atMs: nowMs() };
      kept.set(node, { at: nowMs(), body });
      if (kept.size > 1000) kept.delete(kept.keys().next().value);
      return body;
    })();
    running.set(node, job);
    try { return { status: 200, body: await job }; } finally { running.delete(node); }
  };
}
