// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW WAY IN, FOLLOWED THROUGH BY THE SEAT (kanban #3565, an outside node operator 2026-11-24: the owner page's switch from a quick tunnel to
// Tailscale Funnel took the quick tunnel away at once and posted nothing on chain; the census - which only an advertisement changes - still
// named the dead trycloudflare address hours later, and the owner page through the site said "This node did not answer: Failed to fetch").
//
//   switchPlan   the owner-page switch (bin/reach-switch.mjs): from a tunnel to a way that runs none (Funnel, direct), the tunnel is kept and
//                its address remembered as reach.previous - the census and the pages reading it still go there until the census switched
//   followReach  the seat, on its address clock (server.js announceAddress) - it outlives the switch's runner, which ends with the seat's own
//                restart on Linux (one cgroup): finishes a switch the runner left "running", posts the advertisement update naming the new
//                address (change-roles.js refreshEndpoint) while the census names another, and takes the kept tunnel away once the census
//                names the new one. A quick tunnel is announced, never advertised: its name changes at every restart.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tunnelMode } from './reach.js';
import { nodeState } from './state.js';

/** Blocks from an update's broadcast until the census names it: confirmed 6 deep, read at the seats' next 6-block step. */
export const CENSUS_TAKES_BLOCKS = 12;
/** A testnet4 block, on average, in minutes - for "about N minutes" on the owner page. */
export const BLOCK_MINUTES = 10;
/** A failed update (no coins for the fee, a refused broadcast) is tried again after this long. */
export const UPDATE_RETRY_MS = 10 * 60 * 1000;

const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

/** The switch from `was` (state.reach before) to `mode`: whether the old tunnel stays, and the address it serves. */
export function switchPlan(was, mode, nowMs = Date.now()) {
  if (!was || !was.url || !tunnelMode(was.mode) || tunnelMode(mode)) return { keepTunnel: false, previous: null };
  return { keepTunnel: true, previous: { mode: was.mode, url: was.url, atMs: nowMs } };
}

/**
 * One pass. `publicEndpoint` the address this seat runs on (ARENA_WSS_<port>); `censusRead` whether the seat has read its census, and
 * `ownEndpoints` the endpoints the census's entries for this node's key name; `refresh(o)` refreshEndpoint, `removeTunnel()` the installer's
 * removeProgram for the tunnel; `startedMs` when this seat started. Answers { did: [...], view } - the view for GET /owner/reach.
 */
export async function followReach({ home, state = null, publicEndpoint, censusRead = false, ownEndpoints = [], refresh, removeTunnel, nowMs = Date.now(),
  startedMs = null, retryMs = UPDATE_RETRY_MS }) {
  const st = state || nodeState(home);
  const did = [];
  const s = st.read();
  const r = s.reach || {};
  const here = !!r.url && !!publicEndpoint && norm(r.url) === norm(publicEndpoint);
  // A SWITCH WHOSE RUNNER ENDED WITH THE SEAT'S RESTART: this seat started after it, on the address it switched to - it got through
  try {
    const file = join(st.home, 'reach-switch.json');
    const p = JSON.parse(readFileSync(file, 'utf8'));
    if (p && p.state === 'running' && p.mode === r.mode && here && Number.isFinite(startedMs) && startedMs > Number(p.atMs)) {
      writeFileSync(file, JSON.stringify({ state: 'done', mode: p.mode, url: r.url, atMs: nowMs, by: 'seat' }) + '\n', { mode: 0o600 });
      did.push('switch done');
    }
  } catch { /* no switch on record */ }
  const namesNew = censusRead && !!r.url && ownEndpoints.some((e) => norm(e) === norm(r.url));
  if (censusRead) {
    // THE KEPT TUNNEL GOES once the census names the new address (or the node has no bond: no census names it at all) - never a tunnel
    // the way in now runs itself
    if (r.previous && !tunnelMode(r.mode) && (namesNew || !(s.bond && s.bond.txid))) {
      let gone = null;
      try { gone = await removeTunnel(); } catch (e) { gone = { ok: false, why: e.message }; }
      if (gone && gone.ok) {
        st.update((n) => { if (!n.reach || !n.reach.previous) return null; const { previous, ...rest } = n.reach; return { reach: rest }; });
        did.push(`old tunnel ${r.previous.url} removed`);
      }
    }
    // THE ADVERTISEMENT UPDATE while the census names another address: a stable way in, the seat running on it, a bond to update
    if (r.mode !== 'quick' && here && s.bond && s.bond.txid && !namesNew) {
      const u = s.endpointUpdate;
      const same = !!u && norm(u.endpoint) === norm(r.url);
      const onItsWay = same && !!u.txid;
      const failedLately = same && !u.txid && nowMs - Number(u.atMs || 0) < retryMs;
      if (!onItsWay && !failedLately) {
        let res;
        try { res = await refresh({ home: st.home, state: st, post: true }); } catch (e) { res = { ok: false, why: e.message }; }
        if (res && res.ok) did.push(`advertisement update ${res.update ? res.update.txid : '(already sent)'}`);
        else st.save({ endpointUpdate: { endpoint: r.url, why: (res && res.why) || 'not posted', pending: !!(res && res.pending), atMs: nowMs } });
      }
    }
  }
  return { did, view: viewOf(st.read(), { censusRead, ownEndpoints, namesNew }) };
}

/** What the owner page shows of it: the census's address(es) for this node, the update on its way, the tunnel kept, how long it takes. */
export function viewOf(s, { censusRead = false, ownEndpoints = [], namesNew = false } = {}) {
  const r = (s && s.reach) || {};
  const u = s && s.endpointUpdate && norm(s.endpointUpdate.endpoint) === norm(r.url) ? s.endpointUpdate : null;
  return { censusRead, advertised: censusRead ? [...new Set(ownEndpoints.map(String))] : null, censusNamesNew: !!namesNew, update: u,
    previous: r.previous || null, bonded: !!(s && s.bond && s.bond.txid), takesBlocks: CENSUS_TAKES_BLOCKS, takesMinutes: CENSUS_TAKES_BLOCKS * BLOCK_MINUTES };
}
