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
export const TESTNET4_ELECTRUM = Object.freeze([
  { host: 'mempool.space', port: 40002, tls: true, note: 'mempool.space' },
  { host: 'blackie.c3-soft.com', port: 57010, tls: true, note: 'c3-soft' },
  { host: 'blackie.c3-soft.com', port: 57009, tls: false, note: 'c3-soft, plain TCP' },
]);

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
export function electrumSession({ host, port, tls: useTls = true, timeoutMs = 10000, connect = null }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port: Number(port), servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false };
    const sock = connect ? connect(opts) : useTls ? tls.connect(opts) : net.connect(opts);
    let buf = '', id = 0, opened = false;
    const waiting = new Map();
    const fail = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); if (!opened) reject(e); };
    const timer = setTimeout(() => { fail(new Error(`${host}:${port} did not answer in ${timeoutMs} ms`)); sock.destroy(); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('error', (e) => { clearTimeout(timer); fail(new Error(`${host}:${port}: ${e.code || e.message}`)); });
    sock.on('close', () => fail(new Error(`${host}:${port} closed the connection`)));
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
      opened = true;
      resolve({
        call: (method, params = []) => new Promise((ok, no) => {
          id += 1; waiting.set(id, { resolve: ok, reject: no });
          sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        }),
        close: () => { clearTimeout(timer); sock.removeAllListeners('close'); sock.destroy(); },
      });
    });
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
export async function testConnection(conn, { probe = { core: probeCore, electrum: probeElectrum }, list = TESTNET4_ELECTRUM } = {}) {
  const ask = (c, opts) => (c.kind === 'core' ? probe.core(c, opts) : probe.electrum(c, opts));
  let own = await ask(conn);
  if (!own.ok) return { ok: false, source: own, why: own.why };
  let second = null;
  for (const s of list) {
    if (conn.kind === 'electrum' && s.host === conn.host && Number(s.port) === Number(conn.port)) continue;
    second = { endpoint: `${s.host}:${s.port}`, ...(await ask({ kind: 'electrum', ...s })) };
    if (second.ok) {
      // both asked again for the block at the common height (each answers its tip again too)
      const at = agreeHeights(own, second);
      own = await ask(conn, { at });
      second = { endpoint: second.endpoint, ...(await ask({ kind: 'electrum', ...s }, { at })) };
      if (own.ok && second.ok) break;
    }
  }
  if (!own.ok) return { ok: false, source: own, why: own.why };
  const agree = second && second.ok ? tipsAgree(own, second) : { ok: false, why: 'no second source answered' };
  const synced = conn.kind === 'core' ? own.synced : true;
  return { ok: agree.ok && synced, source: own, second, agree, why: !synced ? `bitcoind is still syncing (${own.height} of ${own.headers})` : agree.why };
}
