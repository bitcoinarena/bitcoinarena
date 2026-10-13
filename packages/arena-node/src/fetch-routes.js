// THE SEAT'S OWN FETCHES, ROUTED AND CAPPED (kanban #348, measured 2026-10-13 ~13:2xZ on the test host: each of the 7 testnet4 seats
// held 770-910 established HTTPS connections to its own host's Tailscale address - its peers' public URLs, test-host.tail...ts.net
// /guardian-N and /fed2-N, reached through tailscaled for every call, and Node's fetch opens a new connection for every request in
// flight to an origin, with no cap. With the test host's B nodes slow behind a satellite link the pools grew without end and, through
// the fed2 forwarder, held 4,589 connections open to the test host, clogging the link federation B itself needed.)
//
//   ARENA_ROUTE_MAP              "public prefix=direct prefix,...": a URL starting with the public prefix is fetched at the direct
//                                one instead (the longest prefix wins), e.g. https://seat.example.com/guardian-2=http://127.0.0.1:31231
//   ARENA_FETCH_MAX_PER_ORIGIN   requests in flight per origin at once (default 8); more wait their turn instead of opening more
//   ARENA_FETCH_TIMEOUT_MS       a request that brings no signal of its own is aborted after this (default 30 000)
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
export function cappedFetch(inner, { routes = [], maxPerOrigin = 8, timeoutMs = 30000 } = {}) {
  const lanes = new Map();   // origin -> { busy, waiting: [resolve] }
  const take = async (origin) => {
    let l = lanes.get(origin); if (!l) { l = { busy: 0, waiting: [] }; lanes.set(origin, l); }
    if (l.busy >= maxPerOrigin) await new Promise((r) => l.waiting.push(r));
    l.busy++;
    return () => { l.busy--; const next = l.waiting.shift(); if (next) next(); };
  };
  const f = async (input, init = {}) => {
    const url = routed(typeof input === 'string' || input instanceof URL ? String(input) : input.url, routes);
    let origin; try { origin = new URL(url).origin; } catch { return inner(input, init); }
    const done = await take(origin);
    try {
      const opts = init && init.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) };
      return await inner(typeof input === 'string' || input instanceof URL ? url : new Request(url, input), opts);
    } finally { done(); }
  };
  f.inFlight = () => Object.fromEntries([...lanes].map(([o, l]) => [o, { busy: l.busy, waiting: l.waiting.length }]));
  return f;
}

/** Installs the routed, capped fetch as the process's own (main.js), from the environment. */
export function installFetchRoutes(env = process.env) {
  const routes = parseRoutes(env.ARENA_ROUTE_MAP);
  const maxPerOrigin = Number(env.ARENA_FETCH_MAX_PER_ORIGIN || 8);
  const timeoutMs = Number(env.ARENA_FETCH_TIMEOUT_MS || 30000);
  globalThis.fetch = cappedFetch(globalThis.fetch.bind(globalThis), { routes, maxPerOrigin, timeoutMs });
  return { routes: routes.length, maxPerOrigin, timeoutMs };
}
