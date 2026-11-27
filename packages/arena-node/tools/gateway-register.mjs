#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * EVERY GUARDIAN OF EVERY FEDERATION THE NETWORK USES LISTS OUR GATEWAYS - LEARNT FROM THE SEATS' RECORDS, NOT WRITTEN BY HAND (kanban #3893c).
 *
 * Before: ops/gw-register.mjs (#823, #2775) named federation A's and B's guardians by hand - their urls and where each admin password lies.
 * A successor federation (§23A.6) was listed at nobody's guardians until someone edited it: 4dc88be7's six guardian-next endpoints were
 * added to it by hand, and gw-c, once joined there (#3893b), reached the guardians' list only through that hand entry.
 *
 * Now, one pass:
 *   1. FEDERATIONS AND THEIR GUARDIANS: the seats' GET /federations, each row's threshold-signed record (§23A.4) that is OPEN, DRAINING or
 *      CRITICAL (gateway-keeper.mjs servedRecords) - a successor is one more row. Each record names its guardians' endpoints; the gone are left out.
 *   2. WHICH OF THEM WE RUN: the guardian data dirs under GUARDIAN_ROOTS (this host's paths, or host:path over ssh), live names only
 *      (node-N.db.guardian, node-N.db.guardian-next, ...; archived copies such as .founded-<date> are never read). A dir is the guardian whose
 *      own endpoint (its invite-code's guardian with its local.json identity) is the record's, in the federation its invite names.
 *      A guardian we do not run is skipped: we cannot change its list.
 *   3. THE LIST: like #823/#2775 - each of our gateways (~/blwp-gw/gw-*.url) is listed where it serves that federation (its own /v1/info), taken
 *      off where it does not, and a dead trycloudflare name leaves.
 * Admin passwords are read only for a matched dir that needs a change, and never printed.
 *
 *   SEATS=http://127.0.0.1:31221,... GUARDIAN_ROOTS=/home/daniel/blwp-testnet4,daniel@192.168.1.18:m808/blwp-offload/fed2 \
 *     [GUARDIAN_HOST=tn4.bitcoin-arena.io] [GW_DIR=~/blwp-gw] [GW_PORTS=a:31270,b:31280,c:31290] node tools/gateway-register.mjs [--dry]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { servedRecords } from './gateway-keeper.mjs';
import { readInvite } from '../src/invite.js';

const hex = (b) => Buffer.from(b).toString('hex');

/** A guardian data dir that is live, not an archived copy: node-15.db.guardian, node-3.db.guardian-next. */
export const isLiveGuardianDir = (name) => /^node-\d+\.db\.guardian(-[a-z0-9]+)?$/.test(String(name));

/** An endpoint's path, the part both a record and a dir name the same way (the host may be the tailnet's or the public one). */
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return null; } };

/** Every guardian of every served federation: [{ fed, endpoint }] (the gone left out), from the seats' GET /federations answers. */
export function guardiansOfRecords(answers) {
  const out = [], seen = new Set();
  for (const [fed, r] of servedRecords(answers)) {
    const gone = new Set((r.gone || []).map((g) => hex(g.peerKey)));
    for (const g of r.guardians || []) {
      if (gone.has(hex(g.peerKey)) || !pathOf(g.endpoint)) continue;
      const k = `${fed} ${pathOf(g.endpoint)}`;
      if (seen.has(k)) continue;
      seen.add(k); out.push({ fed, endpoint: g.endpoint });
    }
  }
  return out;
}

/** What a guardian dir is: { fed, path } from its invite-code and its local.json identity; null when they do not read. */
export function guardianDirOwn({ invite, identity }) {
  let inv; try { inv = readInvite(invite); } catch { return null; }
  if (!inv.federationId) return null;
  const own = inv.guardians.find((g) => g.peer === Number(identity)) || (inv.guardians.length === 1 ? inv.guardians[0] : null);
  const path = own && pathOf(own.url);
  return path ? { fed: inv.federationId.toLowerCase(), path } : null;
}

/** Each record guardian with the dir that runs it (or null): [{ fed, endpoint, dir }]. dirs: [{ dir, invite, identity }]. */
export function matchGuardians(guardians, dirs) {
  const own = new Map();
  for (const d of dirs) { const o = guardianDirOwn(d); if (o && !own.has(`${o.fed} ${o.path}`)) own.set(`${o.fed} ${o.path}`, d.dir); }
  return guardians.map((g) => ({ ...g, dir: own.get(`${g.fed} ${pathOf(g.endpoint)}`) || null }));
}

/** The url to ask: the record's endpoint, on GUARDIAN_HOST when one is set (the tailnet funnel stalls; the public tunnel serves the same paths). */
export const guardianUrl = (endpoint, host) => { if (!host) return endpoint; const u = new URL(endpoint); u.host = host; return u.toString().replace(/\/+$/, ''); };

/** GUARDIAN_ROOTS=/local/path,user@host:remote/path -> [{ host|null, path }]. */
export const parseRoots = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = /^([^/:]+@[^/:]+):(.+)$/.exec(x);
  return m ? { host: m[1], path: m[2] } : { host: null, path: x };
});

const ssh = (host, cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, cmd], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The live guardian dirs under one root: [{ dir, host, invite, identity }] - invite-code and identity only, never a password. */
function dirsUnder(root) {
  const out = [];
  if (!root.host) {
    let names = []; try { names = readdirSync(root.path); } catch { return out; }
    for (const n of names.filter(isLiveGuardianDir)) {
      const d = `${root.path}/${n}`;
      try { out.push({ dir: d, host: null, invite: readFileSync(`${d}/invite-code`, 'utf8').trim(), identity: JSON.parse(readFileSync(`${d}/local.json`, 'utf8')).identity }); } catch { /* not a guardian */ }
    }
    return out;
  }
  let text = '';
  try {
    text = ssh(root.host, `cd ${shq(root.path)} 2>/dev/null && for d in node-*.db.guardian*; do [ -f "$d/invite-code" ] || continue; `
      + `printf '%s\\t%s\\t%s\\n' "$d" "$(tr -d '\\n' < "$d/invite-code")" "$(grep -o '"identity"[^,}]*' "$d/local.json" | grep -o '[0-9]*$')"; done`);
  } catch { return out; }
  for (const line of text.split('\n')) {
    const [n, invite, identity] = line.split('\t');
    if (n && isLiveGuardianDir(n) && invite) out.push({ dir: `${root.path}/${n}`, host: root.host, invite, identity: Number(identity) });
  }
  return out;
}

const passwordOf = (g) => g.host ? ssh(g.host, `cat ${shq(`${g.dir}/admin-password`)}`).trim() : readFileSync(`${g.dir}/admin-password`, 'utf8').trim();

async function main(env = process.env, argv = process.argv) {
  const HOME = env.HOME, DRY = argv.includes('--dry') || env.DRY === '1';
  const seats = String(env.SEATS || 'http://127.0.0.1:31221').split(',').map((s) => s.trim()).filter(Boolean);
  const GW_DIR = env.GW_DIR || `${HOME}/blwp-gw`;
  const PORT = Object.fromEntries(String(env.GW_PORTS || 'a:31270,b:31280,c:31290').split(',').map((x) => x.split(':')).map(([n, p]) => [n, Number(p)]));
  const answers = [];
  for (const s of seats) {
    try { const r = await fetch(`${s.replace(/\/+$/, '')}/federations`, { signal: AbortSignal.timeout(20000) }); if (r.ok) answers.push(await r.json()); } catch { /* the next seat */ }
  }
  const recordGuardians = guardiansOfRecords(answers);
  if (!recordGuardians.length) { console.log(`#3893c no federation record from ${answers.length} of ${seats.length} seats, nothing done`); process.exit(1); }
  const dirs = parseRoots(env.GUARDIAN_ROOTS || `${HOME}/blwp-testnet4`).flatMap(dirsUnder);
  const byDir = new Map(dirs.map((d) => [d.dir, d]));
  const guardians = matchGuardians(recordGuardians, dirs).map((g) => ({ ...g, host: g.dir ? byDir.get(g.dir).host : null }));
  const feds = [...new Set(guardians.map((g) => g.fed))];
  console.log(`#3893c federations ${feds.map((f) => f.slice(0, 8)).join(',')}: ${guardians.length} guardians, ${guardians.filter((g) => g.dir).length} ours`
    + feds.map((f) => ` ${f.slice(0, 8)}=${guardians.filter((g) => g.fed === f && g.dir).length}/${guardians.filter((g) => g.fed === f).length}`).join(''));

  const named = existsSync(GW_DIR) ? readdirSync(GW_DIR).filter((f) => /^gw-[a-z]+\.url$/.test(f)).map((f) => ({ gw: f.slice(3, -4), url: readFileSync(`${GW_DIR}/${f}`, 'utf8').trim() })).filter((x) => x.url) : [];
  const current = named.map((x) => x.url);
  if (current.length < 2) { console.log('#823 fewer than two gateway names, nothing done'); process.exit(1); }
  const serves = new Map();   // which federations each named gateway serves (null: not known - then it is listed everywhere, as before #2775)
  for (const x of named) {
    let f = null;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT[x.gw]}/v1/info`, { headers: { Authorization: `Bearer ${readFileSync(`${GW_DIR}/gw-${x.gw}/password`, 'utf8').trim()}` }, signal: AbortSignal.timeout(10000) });
      if (r.ok) f = new Set(((await r.json()).federations || []).map((y) => String(y.federation_id || '').toLowerCase()));
    } catch { f = null; }
    serves.set(x.url, f);
  }
  const wanted = (fed) => current.filter((u) => { const f = serves.get(u); return !f || f.has(fed); });
  const notServing = (fed, u) => { const f = serves.get(u); return !!f && !f.has(fed); };
  const ask = (url, method, auth, params) => new Promise((resolve) => {
    const ws = new WebSocket(url); const t = setTimeout(() => { try { ws.close(); } catch { /* gone */ } resolve({ error: 'timeout' }); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [{ auth, params }] }));
    ws.onmessage = (e) => { clearTimeout(t); ws.close(); try { resolve(JSON.parse(e.data)); } catch { resolve({ error: 'not json' }); } };
    ws.onerror = () => { clearTimeout(t); resolve({ error: 'socket' }); };
  });
  const dead = async (u, fed) => { if (!/\.trycloudflare\.com\/?$/.test(u)) return false;
    try { const r = await fetch(u.replace(/\/*$/, '/routing_info'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fed), signal: AbortSignal.timeout(10000) }); return r.status === 530; } catch { return true; } };
  const deadSeen = new Map();
  let changed = 0, failed = 0;
  for (const g of guardians.filter((x) => x.dir)) {
    const name = `${g.fed.slice(0, 8)}${pathOf(g.endpoint)}`, url = guardianUrl(g.endpoint, env.GUARDIAN_HOST);
    const list = await ask(url, 'module_0_gateways', null, null);
    if (!Array.isArray(list.result)) { console.log(`#3893c ${name}: no list (${JSON.stringify(list.error || '').slice(0, 80)})`); failed++; continue; }
    const add = wanted(g.fed).filter((u) => !list.result.includes(u));
    const del = list.result.filter((u) => notServing(g.fed, u));
    for (const u of list.result.filter((x) => !current.includes(x))) { if (!deadSeen.has(u)) deadSeen.set(u, await dead(u, g.fed)); if (deadSeen.get(u)) del.push(u); }
    if (!add.length && !del.length) continue;
    if (DRY) { console.log(`#3893c ${name}: would add ${JSON.stringify(add)} remove ${JSON.stringify(del)}`); continue; }
    let pw; try { pw = passwordOf(g); } catch { console.log(`#3893c ${name}: no admin password`); failed++; continue; }
    for (const u of add) { const r = await ask(url, 'module_0_add_gateway', pw, u); console.log(`#3893c ${name}: add ${u} ${r.result === true ? 'ok' : 'FAILED'}`); r.result === true ? changed++ : failed++; }
    for (const u of del) { const r = await ask(url, 'module_0_remove_gateway', pw, u); console.log(`#3893c ${name}: remove ${u} ${r.result === true ? 'ok' : 'FAILED'}`); r.result === true ? changed++ : failed++; }
  }
  console.log(`#3893c ${new Date().toISOString()} ${guardians.filter((g) => g.dir).length} guardians, ${changed} changes, ${failed} failed${DRY ? ' (dry)' : ''}`);
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
