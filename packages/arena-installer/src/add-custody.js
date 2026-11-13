// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN INSTALLED NODE ADDS CUSTODY FROM ITS OWNER PAGE (kanban #563, 2026-10-21: "configure every role and service one by one ... on
// installed nodes too"; the owner-page rule of 2026-10-20: never "run this command"). Before this the custody card said: open Add custody
// or run `arena-install --add-custody`. Now the page shows the plan - Lightning, the bond against the guardian floor, what the wallet must
// hold and why - the owner types I UNDERSTAND (the bond's rules, as the wizard asks them), and the node runs the wizard's own custody
// steps itself (bin/custody-add.mjs, detached: its service step restarts this seat), the way the address switch runs (reach-switch.mjs).
// Progress is <home>/custody-add.json { state: running | lightning | gateway | funds | done | failed, step, why, address, needSats,
// haveSats, atMs }; the request <home>/custody-add.req (0600, deleted once read).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { walletOf, coinsOf } from './wallet.js';
import { nodeState, guardianSetupOf, ownCoreOf } from './state.js';
import { BOND_MIN_SATS } from './bond.js';
import { depositParts, CUSTODY_PEG_IN_SATS } from './wizard.js';

/** What the owner types: the bond's rules understood (the wizard's promise step). */
export const UNDERSTOOD = 'I UNDERSTAND';
/** A run that has said nothing for this long is taken as gone: another may start. */
export const STALE_MS = 6 * 3600_000;

// A RUNNER THAT IS GONE HOLDS NOTHING (kanban #2462, state audit 2026-11-12): the progress file named no process, so a runner the machine's
// restart (nothing starts it again at boot), a kill or a crash ended left its last state - running, funds, lightning, gateway - and every
// start was refused "custody is being added already" for up to STALE_MS, with nothing running and the request file already taken. The start
// now records the runner it started in <home>/custody-add.run { pid, boot, atMs } (boot: the machine's start in minutes, as update.lock
// keeps it, kanban #1166); a progress whose runner has ended, or was started before the machine last started, is interrupted at once: the
// page reads `interrupted: true` and the owner starts it again. A start from before this record (no custody-add.run) keeps the old age rule.
const bootMinute = (now = Date.now(), up = uptime()) => Math.round((now - up * 1000) / 60000);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function runnerGone(home, { alive = pidAlive, boot = bootMinute() } = {}) {
  let r = null;
  try { r = JSON.parse(readFileSync(join(home, 'custody-add.run'), 'utf8')); } catch { return false; }
  if (!r || !Number.isInteger(r.pid) || r.pid <= 0) return false;
  if (Number.isFinite(r.boot) && Math.abs(r.boot - boot) > 2) return true;
  return !alive(r.pid);
}
/** True while a run holds the next start: not final, said something within STALE_MS, and its runner (when recorded) still alive. */
function runHolds(home, p, nowMs, o) {
  return !!p && !['done', 'failed'].includes(p.state) && nowMs - Number(p.atMs || 0) < STALE_MS && !runnerGone(home, o);
}
function recordRunner(home, child, nowMs) {
  // always written: a runner whose pid is unknown (spawn failed) clears the record of the one before, so that one never speaks for it
  const pid = child && Number.isInteger(child.pid) ? child.pid : null;
  writeFileSync(join(home, 'custody-add.run'), JSON.stringify({ pid, boot: bootMinute(), atMs: nowMs }) + '\n', { mode: 0o600 });
}

/** The progress the runner writes, or null; `interrupted: true` on a run that did not finish and whose runner is gone (kanban #2462). */
export function custodyProgress(home, o = {}) {
  let p;
  try { p = JSON.parse(readFileSync(join(home, 'custody-add.json'), 'utf8')); } catch { return null; }
  if (p && !['done', 'failed'].includes(p.state) && runnerGone(home, o)) return { ...p, interrupted: true };
  return p;
}

/**
 * THE PLAN (nothing changes): { ok, done } for a node that holds custody already; else { ok, plan: { lightning, bondSats, bondFloorSats,
 * bondBelowFloor, parts, needSats, walletSats, shortSats, address, guardianEndpoint, progress } } or { ok: false, why }.
 */
export async function custodyPlan({ home, release, state = null, kit = { coinsOf }, pegInSats = null }) {
  const st = state || nodeState(home);
  const s = st.read();
  const progress = custodyProgress(st.home || home);
  if ((s.roles || []).includes('custody') && (s.bond || {}).custodyAdvert) return { ok: true, done: true, progress };
  if (!s.chain || !ownCoreOf(s)) return { ok: false, why: 'custody needs your own Bitcoin Core: LND cannot run on an Electrum server' };
  if (!s.bond || !s.bond.txid) return { ok: false, why: 'this node has no bond yet: post its bond first (custody is added to the bond\'s advertisement, no second bond)' };
  const asCustody = { ...s, roles: [...new Set([...(s.roles || []), 'custody'])], custodyLater: s.custodyLater || { atMs: 0 } };
  const guardian = guardianSetupOf(asCustody, { release });
  if (!guardian) return { ok: false, why: 'this node cannot run a guardian: its release carries no guardian for this system, or it has no public address' };
  const lightning = !s.lightning || !s.lightning.lnddir ? (s.lightning && s.lightning.pubkey ? 'running' : 'install') : !s.lightning.pubkey ? 'starting' : 'running';
  const pegIn = Math.max(0, Math.floor(Number(pegInSats ?? (s.custody || {}).pegInSats ?? CUSTODY_PEG_IN_SATS)));
  const parts = depositParts(asCustody, pegIn);
  const needSats = Object.values(parts).reduce((a, x) => a + Number(x), 0);
  const seedHex = st.readSecret('seed.hex');
  if (!seedHex) return { ok: false, why: 'the wallet seed is not in this node\'s home' };
  const w = walletOf(fromHex(seedHex));
  const { coins } = await kit.coinsOf(s.chain, w.spk);
  const walletSats = coins.reduce((a, c) => a + Number(c.sats), 0);
  const bondSats = Number(s.bond.sats || 0), bondFloorSats = Number(BOND_MIN_SATS);
  return { ok: true, plan: { lightning, gateway: s.gateway ? 'set up' : 'set up now', bondSats, bondFloorSats, bondBelowFloor: bondSats < bondFloorSats,
    parts, needSats, walletSats, shortSats: Math.max(0, needSats - walletSats), address: w.address, guardianEndpoint: guardian.endpoint, progress } };
}

/**
 * A CUSTODY NODE WITHOUT ITS GATEWAY (kanban #711, 2026-10-26, the owner after an install: "lightning gateway reports error and no hint
 * about reason or how to solve it"): setup lets Lightning or the gateway be left for later, and the seat then probes a gateway that was
 * never set up. Null when there is nothing to say (not custody, or the gateway set up); else { why, fix } - `fix` true when the owner
 * page can set it up (startGatewaySetup), the words plain enough to act on.
 */
export function gatewayGap(s) {
  if (!(s.roles || []).includes('custody') || s.gateway) return null;
  if (!s.chain || !ownCoreOf(s)) return { why: 'Not set up: the gateway needs Lightning, and Lightning needs your own Bitcoin Core (this node reads an Electrum server).', fix: false };
  if (!s.lightning || !s.lightning.pubkey) return { why: 'Not set up: Lightning was left for later in setup, so the gateway was never started.', fix: true };
  return { why: 'Not set up: the gateway was left for later in setup.', fix: true };
}

/**
 * THE GATEWAY ALONE (kanban #711): the custody runner's Lightning and gateway steps only - no roles, no bond, no funds - for a custody node
 * whose setup left them for later. Same progress file as adding custody. Answers { ok, progress } or { ok: false, status, why }.
 */
export function startGatewaySetup({ home, release, state = null, nowMs = Date.now(), node = process.execPath, run = spawn, runner = {} }) {
  const gap = gatewayGap((state || nodeState(home)).read());
  if (!gap) return { ok: false, status: 409, why: 'this node\'s gateway is set up already' };
  if (!gap.fix) return { ok: false, status: 409, why: gap.why };
  const p = custodyProgress(home);
  if (runHolds(home, p, nowMs, runner)) return { ok: false, status: 409, why: 'already running', progress: p };
  const bin = join(release, 'packages', 'arena-installer', 'bin', 'custody-add.mjs');
  if (!existsSync(bin)) return { ok: false, status: 501, why: 'this release cannot set up the gateway from the owner page' };
  writeFileSync(join(home, 'custody-add.req'), JSON.stringify({ gatewayOnly: true }), { mode: 0o600 });
  const progress = { state: 'running', step: 'starting', gatewayOnly: true, atMs: nowMs };
  writeFileSync(join(home, 'custody-add.json'), JSON.stringify(progress) + '\n', { mode: 0o600 });
  const out = openSync(join(home, 'custody-add.log'), 'a');
  const child = run(node, [bin, '--home', home], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  recordRunner(home, child, nowMs);
  return { ok: true, progress };
}

/**
 * THE START: the request written and the runner started detached. `understood` must be I UNDERSTAND. Answers { ok, progress } or
 * { ok: false, status, why }.
 */
export function startCustodyAdd({ home, release, understood, pegInSats = null, nowMs = Date.now(), node = process.execPath, run = spawn, runner = {} }) {
  if (String(understood || '').trim().toUpperCase() !== UNDERSTOOD) return { ok: false, status: 400, why: `type ${UNDERSTOOD} to go on: the bond's rules` };
  const p = custodyProgress(home);
  if (runHolds(home, p, nowMs, runner)) return { ok: false, status: 409, why: 'custody is being added already', progress: p };
  const bin = join(release, 'packages', 'arena-installer', 'bin', 'custody-add.mjs');
  if (!existsSync(bin)) return { ok: false, status: 501, why: 'this release cannot add custody from the owner page' };
  writeFileSync(join(home, 'custody-add.req'), JSON.stringify({ understood: UNDERSTOOD, pegInSats: pegInSats == null ? null : Number(pegInSats) }), { mode: 0o600 });
  const progress = { state: 'running', step: 'starting', atMs: nowMs };
  writeFileSync(join(home, 'custody-add.json'), JSON.stringify(progress) + '\n', { mode: 0o600 });
  const out = openSync(join(home, 'custody-add.log'), 'a');
  const child = run(node, [bin, '--home', home], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  recordRunner(home, child, nowMs);
  return { ok: true, progress };
}
