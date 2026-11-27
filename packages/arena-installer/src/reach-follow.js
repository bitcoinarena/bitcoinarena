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
import { addressRefusal } from '../../arena-node/src/address-rules.js';   // kanban #3887

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
  startedMs = null, retryMs = UPDATE_RETRY_MS, adoptUrl = null, accept = null, feeCheck = null, depthOf = null }) {
  const st = state || nodeState(home);
  const did = [];
  let s = st.read();
  let r = s.reach || {};
  // THE OUTSIDE CHECK (kanban #3886): `accept(url)` - other seats reach this node's key at the address - before any update names it; once a pass
  const checked = new Map();
  const gate = async (url) => {
    if (!checked.has(url)) { let g; try { g = await accept(url); } catch (e) { g = { ok: false, why: e.message }; } checked.set(url, g || { ok: false, why: 'not checked' }); }
    return checked.get(url);
  };
  // PUBLIC_URL EDITED BY HAND (kanban #3885): taken as the node's address once asked for (`adoptUrl`, the owner page's button) or once
  // `accept(url)` passes it (the outside check) - then the update below names it like a switched one
  const m = addressMismatch({ s, publicEndpoint, censusRead, ownEndpoints, switching: switchRunning(st.home, nowMs) });
  if (m && m.adoptable && (norm(adoptUrl) === norm(m.conf) || accept)) {
    const tried = s.addressAdopt && norm(s.addressAdopt.url) === norm(m.conf) && !s.addressAdopt.ok && nowMs - Number(s.addressAdopt.atMs || 0) < retryMs;
    if (!tried || norm(adoptUrl) === norm(m.conf)) {
      const g = accept ? await gate(m.conf) : { ok: true };
      if (g && g.ok) {
        st.update((n) => ({ reach: { ...(n.reach || {}), url: m.conf, adopted: { from: m.installer, atMs: nowMs } }, addressAdopt: { url: m.conf, ok: true, atMs: nowMs } }));
        did.push(`public_url ${m.conf} taken as this node's address (was ${m.installer})`);
      } else st.save({ addressAdopt: { url: m.conf, ok: false, why: (g && g.why) || 'not taken', ...(g && g.detail ? { detail: g.detail } : {}), atMs: nowMs } });
      s = st.read(); r = s.reach || {};
    }
  }
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
        const g = accept ? await gate(r.url) : { ok: true };
        if (!g.ok) st.save({ endpointUpdate: { endpoint: r.url, why: `checked from outside first: ${g.why || 'not reached'}`, outside: g.detail || null, atMs: nowMs } });
        else {
          // kanban #3888: the wallet can pay it - else the amount and the deposit address are said, nothing is sent
          let fee = null;
          if (feeCheck) { try { fee = await feeCheck(); } catch (e) { fee = null; } }
          let res;
          if (fee && fee.ok && fee.enough === false) res = { ok: false, why: fee.why, fee };
          else { try { res = await refresh({ home: st.home, state: st, post: true }); } catch (e) { res = { ok: false, why: e.message }; } }
          if (res && res.ok) did.push(`advertisement update ${res.update ? res.update.txid : '(already sent)'}`);
          else st.save({ endpointUpdate: { endpoint: r.url, why: (res && res.why) || 'not posted', pending: !!(res && res.pending), ...(res && res.fee ? { fee: res.fee } : {}), atMs: nowMs } });
        }
      }
    }
  }
  // HOW FAR THE UPDATE IS (kanban #3889): its confirmations, read on this clock while the census does not name it yet
  if (depthOf && censusRead && !namesNew) {
    const s3 = st.read(), u = s3.endpointUpdate;
    if (u && u.txid && s3.reach && norm(u.endpoint) === norm(s3.reach.url)) {
      try {
        const d = await depthOf(s3.chain, u.txid, { sinceTip: Number.isInteger(u.tip) ? u.tip : null, height: Number.isInteger(u.height) ? u.height : null });
        if (d) st.update((n) => (n.endpointUpdate && n.endpointUpdate.txid === u.txid ? { endpointUpdate: { ...n.endpointUpdate, depth: d.depth, ...(Number.isInteger(d.height) ? { height: d.height } : {}), depthAtMs: nowMs } } : null));
      } catch { /* the chain did not answer: the last depth stays */ }
    }
  }
  const after = st.read();
  return { did, view: viewOf(after, { censusRead, ownEndpoints, namesNew, mismatch: addressMismatch({ s: after, publicEndpoint, censusRead, ownEndpoints, switching: switchRunning(st.home, nowMs) }) }) };
}

const QUICK_HOST = /(^|\.)trycloudflare\.com$/i;
/** A switch of the owner page still running (bin/reach-switch.mjs): its address is not the operator's edit. */
export function switchRunning(home, nowMs = Date.now()) {
  try { const p = JSON.parse(readFileSync(join(home, 'reach-switch.json'), 'utf8')); return !!p && (p.state === 'running' || p.state === 'login') && nowMs - Number(p.atMs || 0) < 15 * 60000; } catch { return false; }
}

/**
 * PUBLIC_URL AGAINST THE ADVERTISEMENT (kanban #3885, node operators 2026-11: public_url changed in arena.conf and the node restarted - the
 * census, which reads only the on-chain advertisement, kept the old address and nobody said so). `publicEndpoint` the address the seat runs on
 * (arena.conf public_url), `s` the installer's state (reach.url the address it set up), `ownEndpoints` what the census names for this node.
 * Answers null when they agree, else { conf, installer, advertised, confDiffers, censusDiffers, adoptable, why }: `adoptable` when public_url
 * was edited by hand on a bonded node that runs no quick tunnel and no switch - the advertisement update can name it.
 */
export function addressMismatch({ s, publicEndpoint, censusRead = false, ownEndpoints = [], switching = false }) {
  if (!publicEndpoint) return null;
  const r = (s && s.reach) || {};
  const conf = String(publicEndpoint).trim().replace(/\/+$/, '');
  const advertised = censusRead ? [...new Set((ownEndpoints || []).map(String))] : null;
  const confDiffers = !!r.url && norm(r.url) !== norm(conf);
  const censusDiffers = !!advertised && advertised.length > 0 && !advertised.some((e) => norm(e) === norm(conf));
  if (!confDiffers && !censusDiffers) return null;
  let host = ''; try { host = new URL(conf).hostname; } catch { host = ''; }
  const quick = r.mode === 'quick' || QUICK_HOST.test(host);
  const bonded = !!(s && s.bond && s.bond.txid);
  const refusal = quick ? null : addressRefusal(conf);   // kanban #3887: https on 443, a name with a certificate
  const adoptable = confDiffers && !quick && !switching && bonded && !refusal;
  const why = confDiffers
    ? `public_url in arena.conf is ${conf}, but this node's advertisement names ${(advertised && advertised.length ? advertised : [r.url]).join(', ')}: changing public_url and restarting changes nothing for the network until an advertisement update names it`
    : `this node runs on ${conf}, but the census names ${advertised.join(', ')}`;
  return { conf, installer: r.url || null, advertised, confDiffers, censusDiffers, adoptable, quick, switching: !!switching, bonded, refusal, why };
}

/** What the owner page shows of it: the census's address(es) for this node, the update on its way, the tunnel kept, how long it takes. */
export function viewOf(s, { censusRead = false, ownEndpoints = [], namesNew = false, mismatch = null } = {}) {
  const r = (s && s.reach) || {};
  const u = s && s.endpointUpdate && norm(s.endpointUpdate.endpoint) === norm(r.url) ? s.endpointUpdate : null;
  return { censusRead, advertised: censusRead ? [...new Set(ownEndpoints.map(String))] : null, censusNamesNew: !!namesNew, update: u, progress: progressOf(u, { namesNew, censusRead }),
    previous: r.previous || null, bonded: !!(s && s.bond && s.bond.txid), takesBlocks: CENSUS_TAKES_BLOCKS, takesMinutes: CENSUS_TAKES_BLOCKS * BLOCK_MINUTES,
    mismatch, adopt: (s && s.addressAdopt) || null };
}

/** The update's confirmations the census waits for (6 deep), then its next 6-block step. */
export const UPDATE_DEPTH = 6;
/**
 * THE ADVERTISEMENT UPDATE'S PROGRESS (kanban #3889: operators asked us whether their update arrived): sent (txid) -> n of 6 confirmations ->
 * 6 deep, the census takes it at its next 6-block step -> taken (the census names the address). { step: sent | confirming | deep | taken,
 * txid, depth, need, minutesLeft } or null when no update is on its way.
 */
export function progressOf(u, { namesNew = false, censusRead = false } = {}) {
  if (censusRead && namesNew) return !u || !u.txid ? null : { step: 'taken', txid: (u && u.txid) || null, depth: u && Number.isInteger(u.depth) ? u.depth : null, need: UPDATE_DEPTH, minutesLeft: 0 };
  if (!u || !u.txid) return null;
  const depth = Number.isInteger(u.depth) ? u.depth : null;
  const left = Math.max(0, CENSUS_TAKES_BLOCKS - (depth || 0));
  const step = depth === null || depth === 0 ? 'sent' : depth < UPDATE_DEPTH ? 'confirming' : 'deep';
  return { step, txid: u.txid, depth, need: UPDATE_DEPTH, minutesLeft: left * BLOCK_MINUTES };
}
