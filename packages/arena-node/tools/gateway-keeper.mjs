#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * EVERY GATEWAY IN EVERY FEDERATION THE NETWORK USES, AND A GATEWAY THAT STOPS RUNNING COMES BACK (kanban #3893b).
 *
 * Measured 2026-11-27 20:20Z: gw-c was joined to 337ae01a and b18947f0 but not to 4dc88be7, the successor federation (§23A.6) whose seats
 * served it OPEN - every LNv2 invoice asked of gw-c there failed "No federation available for prefix 4dc88be7", and the guardians' gateway
 * list held only gw-a and gw-b. Nothing joined a gateway to a federation after its founding; each join was by hand.
 *
 * One pass, per gateway (testnet4-gateway.sh runs each as a user unit):
 *   1. JOIN: the federations the seats serve (GET /federations: each row's signed record, §23A.4) that are OPEN, DRAINING or CRITICAL and
 *      signed by at least the record's threshold - the invite is the record's own, the one a guarding seat serves; never one made up. A
 *      record whose federation id is not the row's is ignored. Missing ones are joined with `gateway-cli connect-fed <invite>`.
 *   2. HEALTH: `gateway-cli info`. A gateway that does not answer, or answers a state other than Running (its LND connection lost - LND
 *      restarted under it), on FAIL_PASSES passes in a row is restarted: `systemctl --user restart <its unit>`. A gateway is not a seat.
 * Passwords are read from each gateway's own file and never printed; invites are logged by federation id only.
 *
 *   SEATS=http://127.0.0.1:31221,... GATEWAYS=a:31270:/home/daniel/blwp-gw/gw-a:blwp-tn4-gw-a,... GATEWAY_CLI=<path> \
 *     STATE=<file> [FAIL_PASSES=2] [DRY=1] node tools/gateway-keeper.mjs
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';

const JOINABLE = new Set([1, 2, 3]);   // FEDERATION_STATUS OPEN, DRAINING, CRITICAL: rounds or a drain still use it
const hex = (b) => Buffer.from(b).toString('hex');

/** The served records (kanban #3893c, shared with gateway-register.mjs): Map federation id hex -> decoded record, for each row whose record
 *  is the row's federation, OPEN, DRAINING or CRITICAL, with a fed1 invite and at least its threshold of signatures - the first seat's wins. */
export function servedRecords(answers) {
  const out = new Map();
  for (const a of answers) {
    for (const row of (a && Array.isArray(a.federations) ? a.federations : [])) {
      const id = String(row.federation || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id) || out.has(id) || typeof row.record !== 'string') continue;
      let rec;
      try { rec = splitSignedRecord(Buffer.from(row.record, 'hex')); } catch { continue; }
      const r = rec.record;
      if (hex(r.federationId) !== id || !JOINABLE.has(r.status) || !/^fed1/.test(r.invite)) continue;
      if (rec.signatures.length < r.threshold) continue;
      out.set(id, r);
    }
  }
  return out;
}

/** The federations to be in, from seats' GET /federations answers: Map federation id hex -> invite. */
export const federationsToJoin = (answers) => new Map([...servedRecords(answers)].map(([id, r]) => [id, r.invite]));

/** Which of `wanted` (Map id -> invite) a gateway that is in `joined` (ids) must still join: [{ id, invite }]. */
export const missingJoins = (joined, wanted) => {
  const have = new Set([...joined].map((x) => String(x).toLowerCase()));
  return [...wanted].filter(([id]) => !have.has(id)).map(([id, invite]) => ({ id, invite }));
};

/** The health verdict of one pass: { fails, restart } from the previous fail count and this pass's info (null: no answer). */
export function healthStep(prevFails, info, failPasses = 2) {
  const ok = !!info && info.gateway_state === 'Running';
  const fails = ok ? 0 : (prevFails || 0) + 1;
  return { fails, restart: fails >= failPasses, why: ok ? null : (info ? `state ${info.gateway_state}` : 'no answer') };
}

/** GATEWAYS=name:port:dir:unit,... */
export const parseGateways = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const [name, port, dir, unit] = x.split(':');
  return { name, port: Number(port), dir, unit: unit || `blwp-tn4-gw-${name}` };
}).filter((g) => g.name && g.port > 0 && g.dir);

const run = (cmd, args, ms = 120000) => new Promise((ok) => {
  execFile(cmd, args, { timeout: ms, maxBuffer: 16 << 20 }, (err, stdout, stderr) => ok({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

async function main(env = process.env) {
  const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
  const cli = env.GATEWAY_CLI || 'gateway-cli', dry = env.DRY === '1', failPasses = Number(env.FAIL_PASSES || 2);
  const seats = String(env.SEATS || 'http://127.0.0.1:31221').split(',').map((s) => s.trim()).filter(Boolean);
  const gateways = parseGateways(env.GATEWAYS);
  if (!gateways.length) { log({ step: 'no gateways named' }); process.exit(2); }
  const state = env.STATE && existsSync(env.STATE) ? JSON.parse(readFileSync(env.STATE, 'utf8')) : { fails: {} };
  const answers = [];
  for (const s of seats) {
    try { const r = await fetch(`${s.replace(/\/+$/, '')}/federations`, { signal: AbortSignal.timeout(20000) }); if (r.ok) answers.push(await r.json()); } catch { /* the next seat */ }
  }
  const wanted = federationsToJoin(answers);
  log({ step: 'federations served', seats: answers.length, federations: [...wanted.keys()].map((id) => id.slice(0, 8)) });
  for (const g of gateways) {
    let password;
    try { password = readFileSync(`${g.dir}/password`, 'utf8').trim(); } catch { log({ step: 'no password file', gateway: g.name }); continue; }
    const base = ['--rpcpassword', password, '-a', `http://127.0.0.1:${g.port}`];
    const r = await run(cli, [...base, 'info'], 30000);
    let info = null;
    try { info = r.err ? null : JSON.parse(r.stdout); } catch { info = null; }
    const h = healthStep(state.fails[g.name], info, failPasses);
    state.fails[g.name] = h.fails;
    if (h.why) log({ step: 'gateway unhealthy', gateway: g.name, why: h.why, passes: h.fails });
    if (h.restart) {
      log({ step: dry ? 'would restart' : 'restarting', gateway: g.name, unit: g.unit });
      if (!dry) { const x = await run('systemctl', ['--user', 'restart', g.unit], 120000); log({ step: 'restarted', gateway: g.name, ok: !x.err }); state.fails[g.name] = 0; }
      continue;
    }
    if (!info) continue;
    const joined = (info.federations || []).map((f) => f.federation_id);
    for (const m of missingJoins(joined, wanted)) {
      if (dry) { log({ step: 'would join', gateway: g.name, federation: m.id.slice(0, 8) }); continue; }
      const j = await run(cli, [...base, 'connect-fed', m.invite], 180000);
      let got = null; try { got = JSON.parse(j.stdout).federation_id; } catch { got = null; }
      log({ step: got === m.id ? 'joined' : 'join failed', gateway: g.name, federation: m.id.slice(0, 8), why: got === m.id ? undefined : (j.stderr || j.stdout).replace(/fed1[0-9a-z]+/g, '<invite>').slice(-200) });
    }
  }
  if (env.STATE) { writeFileSync(env.STATE + '.tmp', JSON.stringify(state)); renameSync(env.STATE + '.tmp', env.STATE); }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
