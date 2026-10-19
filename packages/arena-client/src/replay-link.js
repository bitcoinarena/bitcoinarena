// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// COPY GAME REPLAY (2026-09-25 18:39): the one https link a player copies from the result screen.
//
// The host is a RANDOM committee node of the round, taken from that round's advertisement endpoints (the node's
// /replay/nodes answers them); ws becomes https. The path is the same on every node - /replay?round=<hex>&entry=<hex>
// - so the link plays on any node that holds the run, and the page asks the others when the named one does not.

/** An advertisement endpoint as the https origin a browser opens: ws and wss become https, no trailing slash. */
export function httpsOfEndpoint(endpoint) {
  const s = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!/^(wss?|https?):\/\//i.test(s)) return null;
  return s.replace(/^(wss?|https?):/i, 'https:');
}

/**
 * The replay link: `random()` in [0, 1) picks the host among the endpoints. Refused - null, and why - when there is no
 * endpoint or the ids are not 32-byte hex.
 */
export function replayLinkFor({ endpoints, roundHex, entryHex, random = Math.random } = {}) {
  const hosts = [...new Set((endpoints || []).map(httpsOfEndpoint).filter(Boolean))];
  if (!/^[0-9a-f]{64}$/i.test(String(roundHex || '')) || !/^[0-9a-f]{64}$/i.test(String(entryHex || '')))
    return { ok: false, why: 'a replay link names a round and an entry' };
  if (!hosts.length) return { ok: false, why: 'the round names no committee endpoint to replay it from' };
  const host = hosts[Math.min(hosts.length - 1, Math.floor(random() * hosts.length))];
  return { ok: true, host, url: `${host}/replay?round=${String(roundHex).toLowerCase()}&entry=${String(entryHex).toLowerCase()}` };
}
