/**
 * A NODE-SIDE TOOL'S LOCK CLIENT REACHES THE GUARDIANS ON THIS MACHINE, NOT THROUGH THE FUNNEL (kanban #293, the owner
 * 2026-10-12 "Fix the issues so our markets and games can have a paid round"). Measured 13:45-14:20Z on the test host: one
 * wasm lock client holds 21 guardian websockets (3 per guardian) and closes none, not even on free(); through the Tailscale
 * Funnel a third client on the same machine fails "Failed to download client config" after ~65 s (2 of 10 joins in one
 * process, and a second process fails while the first holds 3 clients) - the Funnel caps one source at ~20 connections per
 * ingress address. The same 10 joins against the local seat ports: 10 of 10, ~1.1 s each, 203 sockets.
 *
 * So a tool running beside the guardians maps their public endpoints to local ones with the seats' own variable,
 * FM_WS_API_CONNECT_OVERRIDES ("wss://public=ws://127.0.0.1:port/,..."), applied to every WebSocket the page's wasm opens.
 * Unset, nothing changes. A browser player is one client from its own address and keeps the public endpoints.
 */
export function routeGuardianSockets(overrides = process.env.FM_WS_API_CONNECT_OVERRIDES) {
  if (!overrides || !globalThis.WebSocket) return 0;
  const map = new Map();
  for (const pair of overrides.split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) map.set(pair.slice(0, at).trim().replace(/\/+$/, ''), pair.slice(at + 1).trim());
  }
  if (!map.size) return 0;
  const Base = globalThis.WebSocket;
  globalThis.WebSocket = class extends Base {
    constructor(url, ...rest) { super(map.get(String(url).replace(/\/+$/, '')) || url, ...rest); }
  };
  return map.size;
}
