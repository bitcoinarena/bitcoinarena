// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE READS FOR A MARKET (kanban #920, docs/MARKET-CREATOR.md). A market names an address and every node reads it, so an address is an attack on the node:
// public hosts only, checked on the address the connection really uses (the lookup below answers it, so a name cannot turn private between the check and the
// connect), no redirects, no cookies, a small answer, a short time.
import { lookup as dnsLookup } from 'node:dns';
import https from 'node:https';
import { marketHostProblem, marketUrlProblem, privateAddress } from '../../arena-protocol/src/market-check.js';

export const READ_MAX_BYTES = 1 << 20, READ_MS = 10000, SOCKET_MS = 30000, SOCKET_MESSAGES = 1000, READS_MAX = 3;

/** A lookup that refuses any answer that is not public: handed to the connection itself. */
export function publicLookup(host, options, done) {
  dnsLookup(host, { ...options, all: true }, (e, list) => {
    if (e) return done(e);
    const bad = list.find((x) => privateAddress(x.address));
    if (bad) return done(new Error('that host is not public'));
    if (options && options.all) return done(null, list);
    return done(null, list[0].address, list[0].family);
  });
}

/** One address read: the answer's text. */
export function readPage(url, { lookup = publicLookup, maxBytes = READ_MAX_BYTES, timeoutMs = READ_MS } = {}) {
  return new Promise((done, fail) => {
    const bad = marketUrlProblem(url); if (bad) { fail(new Error(bad)); return; }
    const q = https.get(url, { lookup, headers: { 'user-agent': 'bitcoin-arena-node', accept: '*/*' }, timeout: timeoutMs, agent: false }, (r) => {
      if (r.statusCode !== 200) { r.destroy(); fail(new Error(`answered ${r.statusCode}`)); return; }
      let size = 0; const parts = [];
      r.on('data', (x) => { size += x.length; if (size > maxBytes) { r.destroy(); fail(new Error('the answer is over 1 MB')); return; } parts.push(x); });
      r.on('end', () => done(Buffer.concat(parts).toString('utf8')));
      r.on('error', fail);
    });
    q.on('timeout', () => q.destroy(new Error('no answer in time')));
    q.on('error', fail);
    setTimeout(() => q.destroy(new Error('no answer in time')), timeoutMs).unref();
  });
}

const parsed = (text) => { try { return JSON.parse(text); } catch { return text; } };

/** A socket read for a moment: its messages. The address is checked first; the runtime's WebSocket takes no lookup of ours. */
export function readSocket(r, { most = SOCKET_MESSAGES, waitMs = SOCKET_MS, WS = globalThis.WebSocket, lookup = publicLookup } = {}) {
  return new Promise((done, fail) => {
    const bad = marketUrlProblem(r.url, true); if (bad) { fail(new Error(bad)); return; }
    lookup(new URL(r.url).hostname, {}, (e) => {
      if (e) { fail(e); return; }
      const got = []; const ws = new WS(r.url);
      const end = () => { clearTimeout(t); try { ws.close(); } catch { /* closed */ } done(got); };
      const t = setTimeout(end, waitMs);
      ws.onopen = () => { if (r.subscribe) ws.send(String(r.subscribe)); };
      ws.onmessage = (m) => { got.push(parsed(String(m.data))); if (got.length >= most) end(); };
      ws.onerror = () => { clearTimeout(t); fail(new Error('the socket refused')); };
    });
  });
}

/** Every read of a market: { reads: { id: value } } or { why }. */
export async function readMarketSources(list, options = {}) {
  if (!Array.isArray(list) || list.length > READS_MAX) return { why: `At most ${READS_MAX} reads` };
  const reads = {};
  for (const r of list) {
    if (!r || !/^[a-z][a-zA-Z0-9]*$/.test(String(r.id))) return { why: 'Name each read in letters' };
    const unlisted = marketHostProblem(r.url, options.hosts); if (unlisted && marketUrlProblem(r.url, r.kind === 'ws') === null) return { why: `${r.id}: ${unlisted}` };
    try { reads[r.id] = r.kind === 'ws' ? await readSocket(r, options.socket) : parsed(await readPage(r.url, options.page)); } catch (e) { return { why: `${r.id}: ${e.message}` }; }
  }
  return { reads };
}
