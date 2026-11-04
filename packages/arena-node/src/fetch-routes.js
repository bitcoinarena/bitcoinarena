// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEAT'S OWN FETCHES, ROUTED AND CAPPED (measured 2026-10-13 ~13:2xZ on the test host: each of the 7 testnet4 seats
// held 770-910 established HTTPS connections to its own host's Tailscale address - its peers' public URLs, test-host.tail...ts.net
// /guardian-N and /fed2-N, reached through tailscaled for every call, and Node's fetch opens a new connection for every request in
// flight to an origin, with no cap. With the test host's B nodes slow behind a satellite link the pools grew without end and, through
// the fed2 forwarder, held 4,589 connections open to the test host, clogging the link federation B itself needed.)
//
//   ARENA_ROUTE_MAP              "public prefix=direct prefix,...": a URL starting with the public prefix is fetched at the direct
//                                one instead (the longest prefix wins), e.g. https://seat.example.com/guardian-2=http://127.0.0.1:31231
//   ARENA_FETCH_MAX_PER_ORIGIN   requests in flight per origin at once (default 8); more wait their turn instead of opening more
//   ARENA_FETCH_TIMEOUT_MS       a request that brings no signal of its own is aborted after this (default 30 000); a host that
//                                did not resolve (ENOTFOUND) is not dialed again for as long
//   ARENA_FETCH_KEEPALIVE_MS     how long an idle connection to a peer is kept for its next request (default 30 000; 0 = Node's own 4 s)
export function parseRoutes(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return i > 0 ? [x.slice(0, i).replace(/\/+$/, ''), x.slice(i + 1).replace(/\/+$/, '')] : null;
  }).filter(Boolean).sort((a, b) => b[0].length - a[0].length);
}

/** The URL a seat really fetches: the longest route whose prefix the URL starts with (at a path boundary), else the URL itself. */
export function routed(url, routes) {
  const s = String(url);
  for (const [from, to] of routes) {
    if (s === from || s.startsWith(from + '/') || s.startsWith(from + '?')) return to + s.slice(from.length);
  }
  return s;
}

/** A fetch that routes, caps the requests in flight per origin, and times out a request that brings no signal. */
export function cappedFetch(inner, { routes = [], maxPerOrigin = 8, timeoutMs = 30000, dispatcher = null } = {}) {
  const lanes = new Map();   // lane -> { busy, waiting: [{ go, abort }] }
  // ONE LANE PER SEAT, NOT PER HOST (measured 2026-10-13 ~20:45Z: the 7 test host seats answer behind one host,
  // tn4.bitcoin-arena.io/guardian-N, so a second-host seat had 8 requests in flight to all seven together; over the ship's link the queue
  // grew and its seating agent stopped signing PRESENTs - 4 present of 9 drawn, no certificate): the host and the first path segment
  // - read off the address as CALLED (before routing), and only for a public https host, where seats sit behind one host by path
  // prefix (/guardian-N, /fed2-N); a seat's direct address (http://ip:port) is one lane, as before
  const laneOf = (u) => { const x = new URL(u); if (x.protocol !== 'https:') return x.origin; const seg = x.pathname.split('/').filter(Boolean)[0] || ''; return `${x.origin}/${seg}`; };
  // AND A WAITING CALL KEEPS ITS OWN DEADLINE: its signal aborts it in the queue too, not only once it is sent (a 5 s call waited
  // behind 30 s ones without bound)
  const take = async (lane, signal) => {
    let l = lanes.get(lane); if (!l) { l = { busy: 0, waiting: [] }; lanes.set(lane, l); }
    if (l.busy >= maxPerOrigin) {
      await new Promise((go, no) => {
        const w = { go, abort: null };
        if (signal) {
          if (signal.aborted) { no(signal.reason || new Error('aborted')); return; }
          w.abort = () => { const i = l.waiting.indexOf(w); if (i >= 0) l.waiting.splice(i, 1); no(signal.reason || new Error('aborted')); };
          signal.addEventListener('abort', w.abort, { once: true });
        }
        l.waiting.push(w);
      });
    }
    l.busy++;
    return () => { l.busy--; const next = l.waiting.shift(); if (next) next.go(); };
  };
  // A HOST THAT DOES NOT RESOLVE IS NOT DIALED AGAIN UNTIL A TIMEOUT HAS PASSED (kanban #742, measured 2026-10-28 on test host seat 3:
  // 112,473 TLSSocket objects alive an hour after its start, 111,216 of them destroyed, all to eight *.trycloudflare.com quick tunnels
  // of stopped installer test nodes still in the census - ~3.6 dials a second to each, every one failing at DNS and leaving its socket
  // behind; the heap reached the 1,024 MB limit about hourly and the 137 DNS lookups a second were nearly all misses). After ENOTFOUND
  // the host is answered at once with that failure, without a socket, for the same `timeoutMs` a request is allowed; then dialed again.
  const unresolved = new Map();   // hostname -> { untilMs, code } of its last ENOTFOUND; one entry per host that failed, none kept once it resolves
  const notFound = (e) => { for (let c = e, i = 0; c && i < 4; c = c.cause, i++) if (c.code === 'ENOTFOUND') return c.code; return null; };
  const f = async (input, init = {}) => {
    const called = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = routed(called, routes);
    let lane; try { lane = laneOf(called); } catch { return inner(input, init); }
    let host; try { host = new URL(url).hostname; } catch { host = null; }
    const gone = host && unresolved.get(host);
    if (gone) {
      if (Date.now() < gone.untilMs) throw new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ${gone.code} ${host} (not dialed again until the timeout has passed)`), { code: gone.code, hostname: host }) });
      unresolved.delete(host);
    }
    const opts = init && init.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) };
    const done = await take(lane, opts.signal);
    try {
      const d = dispatcher && !opts.dispatcher ? await dispatcher() : null;
      return await inner(typeof input === 'string' || input instanceof URL ? url : new Request(url, input), d ? { ...opts, dispatcher: d } : opts);
    } catch (e) {
      const code = host && notFound(e);
      if (code) unresolved.set(host, { untilMs: Date.now() + timeoutMs, code });
      throw e;
    } finally { done(); }
  };
  f.unresolved = () => Object.fromEntries([...unresolved].map(([h, x]) => [h, { untilMs: x.untilMs, code: x.code }]));
  f.inFlight = () => Object.fromEntries([...lanes].map(([o, l]) => [o, { busy: l.busy, waiting: l.waiting.length }]));
  return f;
}

// A CONNECTION TO A PEER IS KEPT FOR ITS NEXT REQUEST (kanban #1122, measured 2026-11-04 on an installer node on the main test
// host: GET /identity went unanswered for 5-15 s at a time, 29 connections in its listen queue; 33 of 39 s on the loop busy, half of it
// in TLS - 9.4 s reading, 3.1 s getPeerCertificate, 2.3 s handshakes and teardowns - over ~90 new TLS connections a minute to the
// seats behind one Tailscale serve host). Node's fetch closes an idle connection after 4 s when the server names no keep-alive time,
// and the seating agent's batch reads come every few seconds to a dozen seats at once, so nearly every read paid a new handshake.
// Kept `keepAliveMs` here instead; a server that names its own keep-alive time (Node's http server says 5 s) is still taken at its
// word, up to 10 min. The Agent is the class of Node's own fetch dispatcher (no undici package is shipped), made on the first request.
export function keepAliveDispatcher(native, keepAliveMs) {
  if (!(keepAliveMs > 0)) return null;
  let made = null;
  return () => made || (made = (async () => {
    const sym = Symbol.for('undici.globalDispatcher.1');
    if (!globalThis[sym]) { try { await native('data:,'); } catch { /* no dispatcher: Node's own then */ } }
    const g = globalThis[sym];
    try { return g && typeof g.constructor === 'function' ? new g.constructor({ keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: Math.max(keepAliveMs, 600000) }) : null; }
    catch { return null; }
  })());
}

/** Installs the routed, capped fetch as the process's own (main.js), from the environment. */
export function installFetchRoutes(env = process.env) {
  const routes = parseRoutes(env.ARENA_ROUTE_MAP);
  const maxPerOrigin = Number(env.ARENA_FETCH_MAX_PER_ORIGIN || 8);
  const timeoutMs = Number(env.ARENA_FETCH_TIMEOUT_MS || 30000);
  const keepAliveMs = Number(env.ARENA_FETCH_KEEPALIVE_MS ?? 30000);
  const native = globalThis.fetch.bind(globalThis);
  globalThis.fetch = cappedFetch(native, { routes, maxPerOrigin, timeoutMs, dispatcher: keepAliveDispatcher(native, keepAliveMs) });
  return { routes: routes.length, maxPerOrigin, timeoutMs, keepAliveMs };
}
