#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CUSTODY ADDED FROM THE OWNER PAGE (kanban #563): the installer wizard's own custody steps for a node installed without it - the same code
// `arena-install --add-custody` runs - started by the seat on POST /owner/custody/add and detached from it, because the service step
// restarts the seat. In order: custody chosen (beginAddCustody), the service step (the seat restarted with its guardian), Lightning (LND
// installed on the node's Bitcoin Core, or the one it runs), the gateway, the federation (drawn), the bond's rules (the owner typed
// I UNDERSTAND on the page), the wallet holding what custody needs (waited for), and the bond's advertisement updated to name custody
// with the custody agent installed. The request is <home>/custody-add.req (0600, deleted once read); the progress <home>/custody-add.json,
// which the owner page reads.
//
//     custody-add --home <home>
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeState, defaultHome } from '../src/state.js';
import { createWizard, beginAddCustody } from '../src/wizard.js';

const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = resolve(i >= 0 ? args[i + 1] : defaultHome());
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const statusFile = join(home, 'custody-add.json'), reqFile = join(home, 'custody-add.req');
const say = (o) => { writeFileSync(statusFile, JSON.stringify({ ...o, atMs: Date.now() }) + '\n', { mode: 0o600 }); console.log(`${new Date().toISOString()} ${o.state} ${o.step || ''} ${o.why || ''}`); };
const fail = (step, why) => { say({ state: 'failed', step, why }); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A wizard step asked again every `everyMs` until it answers ok, at most `tries` times; `waiting` is what the page shows meanwhile. */
async function until(step, waiting, ask, { everyMs = 15000, tries = 120 } = {}) {
  let r;
  for (let t = 0; t < tries; t++) {
    r = await ask();
    if (r && r.ok) return r;
    say({ state: waiting, step, why: (r && r.why) || 'not yet' });
    await sleep(everyMs);
  }
  return r || { ok: false, why: 'no answer' };
}

let req;
try { req = JSON.parse(readFileSync(reqFile, 'utf8')); } catch (e) { fail('request', `no request: ${e.message}`); }
rmSync(reqFile, { force: true });
const state = nodeState(home);
let s = state.read();
const seatPort = (s.reach && s.reach.port) || (s.service && s.service.port);
const own = join(release, 'runtime', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const cloudflared = process.env.ARENA_CLOUDFLARED || (existsSync(own) ? own : 'cloudflared');
const wizard = createWizard({ state, release, seatPort, bridgePort: s.bridgePort || null, cloudflared, log: (l) => console.log(l) });
const boot = !(s.service && s.service.boot === false);

say({ state: 'running', step: 'custody chosen' });
if (!((s.roles || []).includes('custody') && s.custodyLater)) {
  const b = beginAddCustody(state);
  if (!b.ok) fail('custody chosen', b.why);
}
s = state.read();
const roles = await wizard['POST /api/roles']({ roles: [...new Set([...(s.roles || []), 'custody'])] });
if (!roles.ok) fail('roles', roles.why);
// THE SERVICE STEP: arena.conf naming the guardian, the units, the seat restarted (it serves the guardian's endpoint from now on)
say({ state: 'running', step: 'restarting the node with its guardian' });
const svc = await wizard['POST /api/service']({ boot });
if (!svc.ok) fail('service', svc.why);
// LIGHTNING: LND installed here on the node's Bitcoin Core (or the one already set up), then asked until it answers
s = state.read();
if (!s.lightning || !s.lightning.pubkey) {
  if (!s.lightning || !s.lightning.lnddir) {
    say({ state: 'lightning', step: 'installing LND' });
    const l = await wizard['POST /api/lightning/own']({ boot });
    if (!l.ok) fail('lightning', l.why);
  }
  const ready = await until('lightning', 'lightning', () => wizard['POST /api/lightning/status']({}), { everyMs: 15000, tries: 240 });
  if (!ready.ok) fail('lightning', ready.why);
}
// THE GATEWAY on that LND; a release without gatewayd for this system leaves it for later, as the wizard does
s = state.read();
if (!s.gateway) {
  say({ state: 'gateway', step: 'setting up the gateway' });
  const g = await wizard['POST /api/gateway/setup']({ boot });
  if (!g.ok && g.noBinary) { const later = await wizard['POST /api/gateway/later']({}); if (!later.ok) fail('gateway', later.why); }
  else if (!g.ok) fail('gateway', g.why);
}
if (state.read().gateway) {
  const gs = await until('gateway', 'gateway', () => wizard['POST /api/gateway/status']({}), { everyMs: 10000, tries: 60 });
  if (!gs.ok) fail('gateway', gs.why);
}
// THE FEDERATION: drawn (no invitation joins a running one) - and THE BOND'S RULES, understood on the page
const fed = await wizard['POST /api/federation']({});
if (!fed.ok) fail('federation', fed.why);
const promise = await wizard['POST /api/promise']({ text: req.understood });
if (!promise.ok) fail('the bond\'s rules', promise.why);
// THE WALLET: what custody needs (the advertisement updates, the peg-in, the channels' reserves), waited for - up to a day
let check;
for (let t = 0; t < 1440; t++) {
  check = await wizard['POST /api/bond/check']({ pegInSats: req.pegInSats ?? undefined });
  if (!check.ok) fail('funds', check.why);
  if (check.enough) break;
  say({ state: 'funds', step: 'waiting for the wallet', address: check.address, needSats: check.needSats, haveSats: check.totalSats,
    why: `send ${check.needSats - check.totalSats} sat to ${check.address}` });
  await sleep(60000);
}
if (!check || !check.enough) fail('funds', 'the wallet did not receive what custody needs within a day: start again once it holds it');
// THE BOND'S ADVERTISEMENT, UPDATED TO NAME CUSTODY (no second bond), and the custody agent
say({ state: 'running', step: 'updating the bond\'s advertisement' });
const post = await wizard['POST /api/bond/post']({});
if (!post.ok) fail('bond', post.why);
const fin = await wizard['POST /api/finish']({});   // the launchers without "Add custody" any more
say({ state: 'done', step: 'custody added', update: post.update || null, finish: fin.ok ? null : fin.why });
setTimeout(() => process.exit(0), 500);
