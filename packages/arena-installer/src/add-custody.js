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
import { fromHex } from '../../arena-protocol/src/hash.js';
import { walletOf, coinsOf } from './wallet.js';
import { nodeState, guardianSetupOf, ownCoreOf } from './state.js';
import { BOND_MIN_SATS } from './bond.js';
import { depositParts, CUSTODY_PEG_IN_SATS } from './wizard.js';

/** What the owner types: the bond's rules understood (the wizard's promise step). */
export const UNDERSTOOD = 'I UNDERSTAND';
/** A run that has said nothing for this long is taken as gone: another may start. */
export const STALE_MS = 6 * 3600_000;

/** The progress the runner writes, or null. */
export function custodyProgress(home) {
  try { return JSON.parse(readFileSync(join(home, 'custody-add.json'), 'utf8')); } catch { return null; }
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
 * THE START: the request written and the runner started detached. `understood` must be I UNDERSTAND. Answers { ok, progress } or
 * { ok: false, status, why }.
 */
export function startCustodyAdd({ home, release, understood, pegInSats = null, nowMs = Date.now(), node = process.execPath, run = spawn }) {
  if (String(understood || '').trim().toUpperCase() !== UNDERSTOOD) return { ok: false, status: 400, why: `type ${UNDERSTOOD} to go on: the bond's rules` };
  const p = custodyProgress(home);
  if (p && !['done', 'failed'].includes(p.state) && nowMs - Number(p.atMs || 0) < STALE_MS) return { ok: false, status: 409, why: 'custody is being added already', progress: p };
  const bin = join(release, 'packages', 'arena-installer', 'bin', 'custody-add.mjs');
  if (!existsSync(bin)) return { ok: false, status: 501, why: 'this release cannot add custody from the owner page' };
  writeFileSync(join(home, 'custody-add.req'), JSON.stringify({ understood: UNDERSTOOD, pegInSats: pegInSats == null ? null : Number(pegInSats) }), { mode: 0o600 });
  const progress = { state: 'running', step: 'starting', atMs: nowMs };
  writeFileSync(join(home, 'custody-add.json'), JSON.stringify(progress) + '\n', { mode: 0o600 });
  const out = openSync(join(home, 'custody-add.log'), 'a');
  run(node, [bin, '--home', home], { detached: true, stdio: ['ignore', out, out], env: process.env }).unref();
  return { ok: true, progress };
}
