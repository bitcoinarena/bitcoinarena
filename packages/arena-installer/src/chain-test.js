// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S CHAIN TESTS (2026-10-18 rulings 1 and 4: testnet4 only, and Electrum only if testnet4
// servers exist - they do). A connection passes when it answers, is TESTNET4 BY ITS GENESIS - not by a name it reports - and its tip
// agrees with a second source; the latency is measured on every answer.
//
// THE GENESIS IS THE CHECK, NOT THE PORT OR THE NAME. Measured 2026-10-18: electrum.blockstream.info:60002 and testnet4.qtornado.com:51002,
// both listed as testnet4 in places, serve testnet3 (block 0 hashes to 000000000933ea01...). Their header 0 is read and double-hashed here,
// so a server on another chain is refused by what it serves.
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const TESTNET4_GENESIS = '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043';

// THE BUILT-IN LIST: testnet4 Electrum servers, each measured to serve the testnet4 genesis (2026-10-18). A user may add their own.
// OURS FIRST (kanban #656, 2026-10-25: "also do our own API for the testnet installer"; measured that day: mempool.space answered
// for hours on neither its Electrum port nor its Esplora API): Fulcrum on the Arena's public-chain testnet4 node, over a websocket.
// The public servers stay as fallbacks.
export const ARENA_ELECTRUM = Object.freeze({ host: 'tn4.bitcoinarena.io', port: 443, tls: true, ws: true, path: '/electrum', note: 'Bitcoin Arena' });
export const TESTNET4_ELECTRUM = Object.freeze([
  ARENA_ELECTRUM,
  { host: 'mempool.space', port: 40002, tls: true, note: 'mempool.space' },
  { host: 'blackie.c3-soft.com', port: 57010, tls: true, note: 'c3-soft' },
  { host: 'blackie.c3-soft.com', port: 57009, tls: false, note: 'c3-soft, plain TCP' },
]);

// SECOND SOURCES OVER HTTPS (feedback #021, kanban #2570: "Egress only on 443: ... mempool.space:40002 and c3-soft 57009/57010 are
// unreachable, and tn4 WSS can't be second to itself, so no Electrum choice passes"): public Esplora APIs, asked only to agree with the
// node's own source - never a source the node runs on. Measured 2026-11-12: both answer the testnet4 genesis and tip 160,921.
export const TESTNET4_ESPLORA = Object.freeze([
  { esplora: 'https://mempool.space/testnet4/api', note: 'mempool.space (HTTPS)' },
  { esplora: 'https://blockstream.info/testnet4/api', note: 'Blockstream (HTTPS)' },
]);

/** Probe an Esplora API the way probeElectrum probes a server: genesis, tip, and the hashes at `at`. Same answer shape. */
export async function probeEsplora(src, { fetcher = fetch, timeoutMs = 10000, at = null } = {}) {
  const t0 = Date.now();
  const get = async (path) => {
    const r = await fetcher(`${src.esplora}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const t = (await r.text()).trim();
    if (!r.ok) throw new Error(`${src.esplora}${path} answered ${r.status}`);
    return t;
  };
  const hash = (t) => { if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`not a block hash: ${t.slice(0, 40)}`); return t; };
  try {
    const genesis = hash(await get('/block-height/0'));
    const latencyMs = Date.now() - t0;
    if (genesis !== TESTNET4_GENESIS) return { ok: false, why: `block 0 is ${genesis.slice(0, 16)}...: not testnet4`, genesis, latencyMs };
    const height = Number(await get('/blocks/tip/height'));
    if (!Number.isSafeInteger(height)) throw new Error('no tip height');
    const tipHash = hash(await get('/blocks/tip/hash'));
    const atHashes = {};
    for (const h of at || []) atHashes[h] = hash(await get(`/block-height/${h}`));
    return { ok: true, chain: 'testnet4', genesis, height, tipHash, atHashes, software: 'esplora', latencyMs };
  } catch (e) {
    return { ok: false, why: e.message, latencyMs: Date.now() - t0 };
  }
}

/** A block hash in Bitcoin's display order: double SHA-256 of the 80-byte header, bytes reversed. */
export const headerHash = (hex) => {
  const b = Buffer.from(hex, 'hex');
  const once = createHash('sha256').update(b).digest();
  return Buffer.from(createHash('sha256').update(once).digest()).reverse().toString('hex');
};

/**
 * One Electrum session: newline-delimited JSON-RPC over TCP or TLS. TLS certificates are NOT checked (Electrum servers sign their own;
 * the genesis and the agreement with a second source are the checks). Answers { call(method, params), close() }.
 */
export function electrumSession({ host, port, tls: useTls = true, timeoutMs = 10000, connect = null, ws = false, path = '/' }) {
  if (ws) return electrumOverWebSocket({ host, port, tls: useTls, path, timeoutMs });
  return new Promise((resolve, reject) => {
    const opts = { host, port: Number(port), servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false };
    const sock = connect ? connect(opts) : useTls ? tls.connect(opts) : net.connect(opts);
    let buf = '', id = 0, opened = false;
    const waiting = new Map();
    const fail = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); if (!opened) reject(e); };
    // THE OPEN TIMER ENDS WHEN THE CONNECTION OPENS, AND A CLOSED SESSION FAILS AT ONCE (kanban #734, measured 2026-10-29 in the Linux VM:
    // the timer was never cleared, so every session was torn down 20 s after it opened - "did not answer in 20000 ms" from a server that
    // answered - and a call on a session torn down while idle waited for good: the chain bridge hung on getblockcount and never moved on).
    // Each call has its own timeout.
    let dead = null;
    const timer = setTimeout(() => { fail(new Error(`${host}:${port} did not answer in ${timeoutMs} ms`)); sock.destroy(); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (e) => { clearTimeout(timer); dead = dead || new Error(`${host}:${port}: ${e.code || e.message}`); fail(dead); });
    sock.on('close', () => { dead = dead || new Error(`${host}:${port} closed the connection`); fail(dead); });
    sock.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = waiting.get(m.id); if (!w) continue;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(`${host}:${port}: ${m.error.message || JSON.stringify(m.error)}`)); else w.resolve(m.result);
      }
    });
    sock.once(useTls && !connect ? 'secureConnect' : 'connect', () => {
      opened = true; clearTimeout(timer);
      resolve({
        call: (method, params = []) => new Promise((ok, no) => {
          if (dead) { no(dead); return; }
          id += 1; const my = id;
          const t = setTimeout(() => { if (waiting.delete(my)) no(new Error(`${host}:${port} did not answer ${method} in ${timeoutMs} ms`)); }, timeoutMs);
          waiting.set(my, { resolve: (v) => { clearTimeout(t); ok(v); }, reject: (e) => { clearTimeout(t); no(e); } });
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
        }),
        close: () => { clearTimeout(timer); sock.removeAllListeners('close'); sock.destroy(); },
      });
    });
  });
}

/**
 * THE ELECTRUM PROTOCOL OVER A WEBSOCKET (kanban #656): our own server (Fulcrum on the Arena's testnet4 node) is reached at a path of an
 * https name, wss://<host><path> - one JSON-RPC message each way per frame. Same answer as electrumSession: { call, close }.
 */
export function electrumOverWebSocket({ host, port = 443, tls: useTls = true, path = '/', timeoutMs = 10000 }) {
  const url = `${useTls ? 'wss' : 'ws'}://${host}${Number(port) && Number(port) !== (useTls ? 443 : 80) ? `:${port}` : ''}${path}`;
  return new Promise((resolve, reject) => {
    let sock;
    try { sock = new WebSocket(url); } catch (e) { reject(new Error(`${url}: ${e.message}`)); return; }
    let id = 0, opened = false;
    const waiting = new Map();
    const fail = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); if (!opened) reject(e); };
    let dead = null;   // as electrumSession above (kanban #734): the open timer ends at the open, a closed session fails at once
    const timer = setTimeout(() => { fail(new Error(`${url} did not answer in ${timeoutMs} ms`)); try { sock.close(); } catch { /* gone */ } }, timeoutMs);
    sock.onerror = (e) => { clearTimeout(timer); dead = dead || new Error(`${url}: ${(e && e.message) || 'the connection failed'}`); fail(dead); };
    sock.onclose = () => { dead = dead || new Error(`${url} closed the connection`); fail(dead); };
    sock.onmessage = (ev) => {
      for (const line of String(ev.data).split('\n')) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = waiting.get(m.id); if (!w) continue;
        waiting.delete(m.id);
        if (m.error) w.reject(new Error(`${url}: ${m.error.message || JSON.stringify(m.error)}`)); else w.resolve(m.result);
      }
    };
    sock.onopen = () => {
      opened = true; clearTimeout(timer);
      resolve({
        call: (method, params = []) => new Promise((ok, no) => {
          if (dead) { no(dead); return; }
          id += 1; const my = id;
          const t = setTimeout(() => { if (waiting.delete(my)) no(new Error(`${url} did not answer ${method} in ${timeoutMs} ms`)); }, timeoutMs);
          waiting.set(my, { resolve: (v) => { clearTimeout(t); ok(v); }, reject: (e) => { clearTimeout(t); no(e); } });
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }));
        }),
        close: () => { clearTimeout(timer); sock.onclose = null; try { sock.close(); } catch { /* gone */ } },
      });
    };
  });
}

/**
 * Probe one Electrum server: version, tip, header 0. Answers { ok, chain, genesis, height, tipHash, atHashes (the blocks at `at`), software, latencyMs } or
 * { ok: false, why }.
 */
export async function probeElectrum(server, { timeoutMs = 10000, connect = null, at = null } = {}) {
  const t0 = Date.now();
  let s;
  try {
    s = await electrumSession({ ...server, timeoutMs, connect });
    const version = await s.call('server.version', ['arena-installer', '1.4']);
    const tip = await s.call('blockchain.headers.subscribe');
    const genesis = headerHash(await s.call('blockchain.block.header', [0]));
    const latencyMs = Date.now() - t0;
    if (genesis !== TESTNET4_GENESIS) return { ok: false, why: `block 0 hashes to ${genesis.slice(0, 16)}...: not testnet4`, genesis, latencyMs };
    const atHashes = {};
    for (const h of at || []) atHashes[h] = headerHash(await s.call('blockchain.block.header', [h]));
    return { ok: true, chain: 'testnet4', genesis, height: tip.height, tipHash: headerHash(tip.hex), atHashes, software: Array.isArray(version) ? version[0] : String(version), latencyMs };
  } catch (e) {
    return { ok: false, why: e.message, latencyMs: Date.now() - t0 };
  } finally { if (s) s.close(); }
}

/** The JSON-RPC client of a bitcoind, by cookie file or user and password. */
export function coreRpc({ url, cookiePath = '', user = '', password = '', fetcher = fetch, timeoutMs = 10000 }) {
  return async (method, params = []) => {
    const auth = cookiePath ? readFileSync(cookiePath, 'utf8').trim() : `${user}:${password}`;
    const r = await fetcher(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(auth).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'arena-installer', method, params }) });
    if (r.status === 401) throw new Error('bitcoind refused the credentials (401)');
    const body = await r.json().catch(() => null);
    if (!body) throw new Error(`bitcoind answered ${r.status} with no JSON`);
    if (body.error) throw new Error(`bitcoind: ${body.error.message}`);
    return body.result;
  };
}

/**
 * Probe a Bitcoin Core: chain info, block 0's hash, sync state. Answers { ok, chain, genesis, height, headers, synced, pruned, tipHash,
 * latencyMs } or { ok: false, why }.
 */
export async function probeCore(conf, { fetcher = fetch, at = null } = {}) {
  const t0 = Date.now();
  try {
    if (conf.cookiePath) readFileSync(conf.cookiePath);   // a missing cookie is said as one, not as a 401
  } catch (e) { return { ok: false, why: `no cookie file at ${conf.cookiePath} (${e.code}): is bitcoind running, and is this its testnet4 directory?` }; }
  try {
    const rpc = coreRpc({ ...conf, fetcher });
    const info = await rpc('getblockchaininfo');
    const genesis = await rpc('getblockhash', [0]);
    const latencyMs = Date.now() - t0;
    if (genesis !== TESTNET4_GENESIS) return { ok: false, why: `block 0 is ${genesis.slice(0, 16)}... (chain "${info.chain}"): not testnet4`, genesis, latencyMs };
    return { ok: true, chain: info.chain, genesis, height: info.blocks, headers: info.headers, synced: info.blocks >= info.headers - 1 && !info.initialblockdownload,
      pruned: Boolean(info.pruned), tipHash: info.bestblockhash, atHashes: Object.fromEntries(await Promise.all((at || []).map(async (h) => [h, await rpc('getblockhash', [h])]))),
      software: 'bitcoind', latencyMs };
  } catch (e) {
    return { ok: false, why: /fetch failed|ECONNREFUSED|abort/i.test(e.message + (e.cause ? e.cause.code : '')) ? `nothing answers at ${conf.url} (${e.cause ? e.cause.code : e.message})` : e.message,
      latencyMs: Date.now() - t0 };
  }
}

// THE TIPS AGREE BELOW THE TIP, NOT AT IT. Measured 2026-10-18 06:2xZ: mempool.space and c3-soft both at 156,896 with different blocks;
// bitcoind listed c3-soft's tip as a valid competing branch of 5 blocks (getchaintips branchlen 5) - testnet4's tip forks often and both
// servers were healthy. Two sources agree when their tips are within 2 blocks (a block can land between the reads) and both name the
// same block at one of AGREE_DEPTHS below the lower tip: the shallowest shared one says how deep the fork is.
export const AGREE_DEPTHS = Object.freeze([3, 6, 9, 12]);
/** The heights both sources are asked for: AGREE_DEPTHS below the lower tip. */
export const agreeHeights = (a, b) => AGREE_DEPTHS.map((d) => Math.max(0, Math.min(a.height, b.height) - d));

/** Does a source agree with a second one? Each one's `atHashes` names its blocks at agreeHeights(a, b). Answers { ok, why, forkDepth }. */
export function tipsAgree(a, b) {
  if (!a.ok || !b.ok) return { ok: false, why: 'one of the two sources did not answer' };
  if (Math.abs(a.height - b.height) > 2) return { ok: false, why: `tips ${a.height} and ${b.height} are ${Math.abs(a.height - b.height)} blocks apart` };
  const hs = agreeHeights(a, b);
  const shared = hs.find((h) => a.atHashes && b.atHashes && a.atHashes[h] && a.atHashes[h] === b.atHashes[h]);
  if (shared === undefined) return { ok: false, why: `no shared block down to ${hs[hs.length - 1]}: one of them is on another chain` };
  const forkDepth = Math.min(a.height, b.height) - shared;
  return { ok: true, forkDepth, why: `tips ${a.height} and ${b.height}, the same block at ${shared}${shared === hs[0] ? '' : ` (a competing branch above it - testnet4's tip forks)`}` };
}

/**
 * The full test of a chain connection, as the wizard's Test button runs it: the source itself, then a second source from the built-in
 * list (one that is not the source) for the agreement. `probe` is injectable for tests.
 */
export async function testConnection(conn, { probe = { core: probeCore, electrum: probeElectrum, esplora: probeEsplora }, list = [...TESTNET4_ELECTRUM, ...TESTNET4_ESPLORA] } = {}) {
  const ask = (c, opts) => (c.kind === 'core' ? probe.core(c, opts) : c.kind === 'esplora' ? (probe.esplora ? probe.esplora(c, opts) : Promise.resolve({ ok: false, why: 'no Esplora probe given' })) : probe.electrum(c, opts));
  const kindOf = (s) => (s.esplora ? 'esplora' : 'electrum');
  let own = await ask(conn);
  if (!own.ok) return { ok: false, source: own, why: own.why };
  // A SECOND SOURCE THAT LAGS IS ASKED NO FURTHER, the next one is (kanban #684, 2026-10-26: "bitcoinarena install waiting for bitcoin core /
  // electrum sync" - Core synced at 157,655, the page at 100 % for good; the first server of the list, ours, stood 11 blocks behind and failed
  // every test it was the second source of, the interim Electrum's and the synced Core's alike; measured the same day: ours 157,645, the three
  // public ones 157,657): every server of the list in turn until one agrees, never only the first that answers
  let second = null, agree = null;
  const behind = [], disagreed = [];
  for (const s of list) {
    if (conn.kind === 'electrum' && s.host === conn.host && Number(s.port) === Number(conn.port)) continue;
    const first = { endpoint: s.esplora || `${s.host}:${s.port}`, ...(await ask({ kind: kindOf(s), ...s })) };
    if (!first.ok) { second = second || first; continue; }
    // both asked again for the block at the common height (each answers its tip again too)
    const at = agreeHeights(own, first);
    const again = await ask(conn, { at });
    if (!again.ok) return { ok: false, source: again, why: again.why };
    own = again;
    second = { endpoint: first.endpoint, ...(await ask({ kind: kindOf(s), ...s }, { at })) };
    if (!second.ok) continue;
    agree = tipsAgree(own, second);
    if (agree.ok) break;
    disagreed.push(second);
    if (second.height < own.height - 2) behind.push(second);
  }
  if (!agree) agree = { ok: false, why: second && !second.ok ? `no second source answered (${second.endpoint}: ${second.why})` : 'no second source answered' };
  const synced = conn.kind === 'core' ? own.synced : true;
  // A SYNCED BITCOIN CORE IS NOT HELD BACK BY A SERVER BEHIND IT (kanban #684): when every server that answered is behind it, Core is the one
  // ahead - its own peers gave it the headers it validated - so the lagging server is not trusted over it
  if (!agree.ok && synced && conn.kind === 'core' && behind.length && behind.length === disagreed.length) {
    agree = { ok: true, behind: true, why: `tip ${own.height}, synced; ${behind.map((b) => `${b.endpoint} is ${own.height - b.height} blocks behind`).join(', ')}` };
  }
  return { ok: agree.ok && synced, source: own, second, agree, why: !synced ? `bitcoind is still syncing (${own.height} of ${own.headers})` : agree.why };
}
