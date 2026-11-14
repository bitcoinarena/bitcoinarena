// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE INSTALLER, END TO END (kanban #2642): this tree's installer (packages/arena-installer bin/arena-install.mjs) started in a TEMP HOME
// and its setup wizard driven in a real headless Chrome; then `arena-install --update` (the signed asset's check), and a node in a temp home
// updated, rolled back and auto-updated between real release folders with real seats of each release answering.
//
// WHAT IS REAL AND WHAT IS NOT (each flow's evidence says it again):
//  - the wizard is the installer process itself, on 127.0.0.1, its page in Chrome, every step clicked as a person clicks it;
//  - the Bitcoin step is tested against the devnet's regtest bitcoind (read-only): the installer accepts testnet4 only, so it must REFUSE it
//    by its genesis. To go on, the chain step's record is written into the temp home's state.json (what a passed save writes) and the
//    installer started again - which is the wizard's own "closed and resumed" path (the state on disk, the session kept across a restart);
//  - the reach and install steps are not driven (installer.reach-service says why: live seats, the real launchd domain);
//  - the update flows run this tree's update.js / auto-update.js on copies (APFS clones) of the real darwin-arm64 releases in
//    ~/.arena-node/releases, in a temp home, with a private regtest bitcoind; the service manager is e2e/lib/installer-update.mjs's
//    systemctl stand-in (the Mac's launchd domain holds a live node), so the update runs as on Linux.
// Temp homes: ~/wf1489/e2e-2642/installer-<stamp>/ (E2E_INSTALLER_ROOT). Ports: E2E_INSTALLER_PORT (default 18300) + 10..60.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, copyFileSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Skip, check, wait } from '../lib/ctx.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib', 'installer-update.mjs');
const env = process.env;
const BASE_PORT = Number(env.E2E_INSTALLER_PORT || 18300);
const P = { wizard: BASE_PORT + 10, seat: BASE_PORT + 20, bridge: BASE_PORT + 21, btc: BASE_PORT + 30, updSeat: BASE_PORT + 40, serve: BASE_PORT + 50 };
const RELEASES = env.E2E_RELEASES_DIR || join(homedir(), '.arena-node', 'releases');

// ---------- shared: the temp root, the wizard process, the update node ----------
function rootOf(ctx) {
  if (!ctx.shared.installer) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(env.E2E_INSTALLER_ROOT || join(homedir(), 'wf1489', 'e2e-2642'), `installer-${stamp}`);
    mkdirSync(base, { recursive: true });
    ctx.shared.installer = { base };
  }
  return ctx.shared.installer;
}
const portFree = (port) => new Promise((ok) => { const c = net.connect({ port, host: '127.0.0.1' }); c.setTimeout(1000, () => { c.destroy(); ok(true); }); c.once('connect', () => { c.destroy(); ok(false); }); c.once('error', () => ok(true)); });

/** Start this tree's installer in the wizard's temp home; answers { proc, link, out() }. */
async function startWizard(ctx, W) {
  const logFile = join(ctx.dir, `installer-${Date.now()}.log`);
  let out = '';
  const proc = spawn(process.execPath, [join(ctx.root, 'packages/arena-installer/bin/arena-install.mjs'), '--home', W.home, '--port', String(P.wizard),
    '--seat-port', String(P.seat), '--bridge-port', String(P.bridge), '--local'],
  { cwd: ctx.root, env: { ...env, HOME: W.tmpHome, ARENA_NO_BROWSER: '1', ARENA_INSTANCE: '', ARENA_PORT_OFFSET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const take = (d) => { out += d; try { writeFileSync(logFile, out); } catch { /* evidence only */ } };
  proc.stdout.on('data', take); proc.stderr.on('data', take);
  W.proc = proc;
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const m = /Open this link in your browser[^\n]*\n\s*\n\s*(http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+)/.exec(out);
    if (m) return { proc, link: m[1], out: () => out, logFile };
    if (proc.exitCode !== null) throw new Error(`the installer ended (${proc.exitCode}) before printing its link: ${out.slice(-600)}`);
    await wait(250);
  }
  proc.kill('SIGTERM');
  throw new Error(`the installer printed no setup link in 90 s: ${out.slice(-600)}`);
}
async function stopWizard(W) {
  if (!W || !W.proc || W.proc.exitCode !== null) return;
  W.proc.kill('SIGTERM');
  for (let i = 0; i < 40 && W.proc.exitCode === null; i++) await wait(100);
  if (W.proc.exitCode === null) W.proc.kill('SIGKILL');
}
let exitHooked = false;
function hookExit(ctx) {
  if (exitHooked) return; exitHooked = true;
  // a runner ended by a signal (perl's alarm, Ctrl-C) runs the exit hook too: no seat or bitcoind of this suite is left behind
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM']) process.once(sig, () => process.exit(130));
  process.on('exit', () => {
    const I = ctx.shared.installer || {};
    try { if (I.wiz && I.wiz.proc && I.wiz.proc.exitCode === null) I.wiz.proc.kill('SIGKILL'); } catch { /* gone */ }
    if (I.upd && !I.upd.cleaned) {
      try { spawnSync(process.execPath, [LIB, jobFile(I.upd, { op: 'stop-all' })], { env: updEnv(I.upd), timeout: 30000 }); } catch { /* best effort */ }
      try { if (I.upd.btcUp) spawnSync(join(I.upd.btcBin, 'bitcoin-cli'), I.upd.btcArgs.concat('stop'), { timeout: 15000 }); } catch { /* best effort */ }
    }
  });
}

/** A Chrome tab on the wizard with the session cookie of the flow before (each flow gets its own Chrome from the runner). */
async function wizardTab(ctx, url) {
  const W = ctx.shared.installer.wiz;
  const b = await ctx.chrome();
  const t = await b.tab('about:blank');
  if (W.cookie) await t.call('Network.setCookie', { name: W.cookie.name, value: W.cookie.value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict', expires: W.cookie.expires });
  await t.go(url || `http://127.0.0.1:${P.wizard}/`, 1500);
  return { b, t };
}
async function keepCookie(ctx, t) {
  const c = await t.call('Network.getCookies', { urls: [`http://127.0.0.1:${P.wizard}/`] });
  const k = (c.cookies || []).find((x) => x.name === 'arena_wizard');
  if (k) ctx.shared.installer.wiz.cookie = k;
  return !!k;
}
const apiState = (t) => t.js(`fetch('/api/state', { cache: 'no-store' }).then((r) => r.json())`);
const stepIs = async (t, step, ms = 30000) => t.until(`fetch('/api/state', { cache: 'no-store' }).then((r) => r.json()).then((s) => s.step === ${JSON.stringify(step)} && s.step)`, ms, `the wizard's step is ${step}`);
const fill = (t, sel, v) => t.js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
  const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
/** Click, and fail by name when nothing visible matched (cdp.mjs click answers false then). */
const press = async (t, sel, text) => { check(await t.click(sel, text), `a visible ${sel}${text ? ` "${text}"` : ''} to click`); };
const pageErrors = (t) => t.log.errors.map((e) => e.text.slice(0, 200));
const needWizard = (ctx) => {
  const W = ctx.shared.installer && ctx.shared.installer.wiz;
  if (!W || !W.proc || W.proc.exitCode !== null) throw new Skip('the wizard is not running (installer.wizard-opens did not pass in this run)');
  return W;
};
const rawGet = (port, path, headers) => new Promise((ok) => {
  const q = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => ok({ status: r.statusCode, body: b })); });
  q.on('error', (e) => ok({ status: 0, body: e.message })); q.end();
});

// ---------- the update node ----------
const updEnv = (U) => ({ ...env, HOME: U.tmpHome, XDG_CONFIG_HOME: join(U.tmpHome, '.config') });
let jobN = 0;
function jobFile(U, o) { const f = join(U.base, `job-${process.pid}-${++jobN}.json`); writeFileSync(f, JSON.stringify({ root: U.root, home: U.home, port: P.updSeat, ...o })); return f; }
/** One run of e2e/lib/installer-update.mjs in the update node's temp home; answers its JSON. */
function job(ctx, U, o, ms = 600000) {
  return new Promise((ok, no) => {
    const f = jobFile(U, o);
    const c = spawn(process.execPath, [LIB, f], { env: updEnv(U), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { c.kill('SIGKILL'); no(new Error(`${o.op}: no answer in ${Math.round(ms / 1000)} s`)); }, ms);
    c.on('exit', () => {
      clearTimeout(timer);
      writeFileSync(join(ctx.dir, `job-${o.op}-${jobN}.log`), `${out}\n--- stderr\n${err}`);
      const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (!line) return no(new Error(`${o.op}: no JSON (${err.slice(-400)})`));
      const r = JSON.parse(line);
      if (r.threw) return no(new Error(`${o.op} threw: ${r.threw.slice(0, 500)}`));
      ok(r);
    });
  });
}
const vparts = (v) => String(v).split(/[.-]/).map((x) => Number(x) || 0);
const vcmp = (a, b) => { const x = vparts(a), y = vparts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
/** The two newest real darwin-arm64 releases on this machine (or Skip). */
function realReleases() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Skip(`the real releases on hand are darwin-arm64; this runner is ${process.platform}-${process.arch}`);
  let names = [];
  try { names = readdirSync(RELEASES).filter((d) => /^(bitcoin-)?arena-node-[\d.]+-darwin-arm64$/.test(d) && existsSync(join(RELEASES, d, 'VERSION'))); } catch { names = []; }
  const list = names.map((d) => ({ dir: join(RELEASES, d), name: d, version: readFileSync(join(RELEASES, d, 'VERSION'), 'utf8').trim(), commit: readFileSync(join(RELEASES, d, 'COMMIT'), 'utf8').trim() }))
    .sort((a, b) => vcmp(a.version, b.version));
  if (list.length < 2) throw new Skip(`two darwin-arm64 release folders are needed in ${RELEASES}; found ${list.length}`);
  return { older: list[list.length - 2], newer: list[list.length - 1] };
}
const clone = (from, to) => execFileSync('cp', ['-Rc', from, to]);   // APFS clone: the real release's bytes, no second copy on disk
async function seatSays(port) {
  const out = {};
  try { const r = await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(5000) }); out.identity = Buffer.from(await r.arrayBuffer()).subarray(0, 32).toString('hex'); } catch (e) { out.identity = null; out.why = e.message; }
  try { const j = await (await fetch(`http://127.0.0.1:${port}/owner/version`, { signal: AbortSignal.timeout(5000) })).json(); out.version = j.version; out.commit = j.commit; out.latestWhy = j.latest && j.latest.why; } catch (e) { out.version = null; }
  return out;
}
function unitRelease(U) {
  const t = readFileSync(join(U.tmpHome, '.config', 'systemd', 'user', 'arena-node.service'), 'utf8');
  const m = /^WorkingDirectory=(.+)\/packages\/arena-node$/m.exec(t);
  return m ? m[1] : null;
}
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
const needUpd = (ctx) => {
  const U = ctx.shared.installer && ctx.shared.installer.upd;
  if (!U || !U.ready) throw new Skip('the update node is not up (installer.update did not get it running in this run)');
  return U;
};

// ---------- the flows ----------
export const flows = [
  {
    id: 'installer.wizard-opens', area: 'installer', title: 'the installer starts in a temp home and its setup page opens in Chrome from the one-time link',
    money: 0, reach: 2, needs: ['chrome'], timeoutMs: 180000, order: 1,
    async run(ctx) {
      const I = rootOf(ctx); hookExit(ctx);
      for (const p of [P.wizard, P.seat, P.bridge]) if (!(await portFree(p))) throw new Error(`port ${p} on 127.0.0.1 is taken (E2E_INSTALLER_PORT moves the installer flows' ports)`);
      const W = I.wiz = { tmpHome: join(I.base, 'wizard-home') };
      W.home = join(W.tmpHome, '.bitcoinarena');
      mkdirSync(W.tmpHome, { recursive: true });
      const s = await startWizard(ctx, W);
      check(/Bitcoin Arena setup \(testnet4\)\. Node home: /.test(s.out()), 'the installer says its network and home', s.out().slice(0, 300));
      const { t } = await wizardTab(ctx, s.link);
      // the token traded for a session cookie and gone; the page draws the first step
      // the intro (kanban #596: how many nodes) before the first step, until "Set up my node"
      await t.until(`location.pathname === '/' && !location.search && (() => { const b = document.querySelector('#intro-go'); return !!b && b.offsetParent !== null; })()`, 30000, 'the intro\'s "Set up my node" on /');
      check(await keepCookie(ctx, t), 'the wizard set its session cookie (arena_wizard)');
      const st = await apiState(t);
      check(st.ok && st.step === 'start' && st.network === 'testnet4', 'a new home starts at the first step, testnet4', { step: st.step, network: st.network });
      await t.shot(join(ctx.dir, '01-start.png'), true);
      // the used link again, in a browser without the session: refused
      const again = await rawGet(P.wizard, `/${new URL(s.link).search}`, { host: `127.0.0.1:${P.wizard}` });
      check(again.status === 403 && /used already/.test(again.body), 'the used setup link is refused', again);
      // no session: 401; another Host (DNS rebinding): 421; a POST without x-arena-wizard (from the page, with the session): 403
      const noSession = await rawGet(P.wizard, '/api/state', { host: `127.0.0.1:${P.wizard}` });
      check(noSession.status === 401, 'the API answers nothing without the session', noSession);
      const rebind = await rawGet(P.wizard, '/api/state', { host: `attacker.example:${P.wizard}`, cookie: `arena_wizard=${I.wiz.cookie.value}` });
      check(rebind.status === 421, 'a request under another Host is refused (DNS rebinding)', rebind);
      const noHeader = await t.js(`fetch('/api/roles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"roles":[]}' }).then((r) => r.status)`);
      check(noHeader === 403, 'a POST without x-arena-wizard is refused', noHeader);
      const errs = pageErrors(t);
      check(!errs.length, 'the page threw nothing', errs);
      return { home: W.home, link: s.link.replace(/t=.*/, 't=(token)'), step: st.step, build: st.build, usedLink: again.status, noSession: noSession.status, otherHost: rebind.status, noHeader,
        shots: ['01-start.png'] };
    },
  },
  {
    id: 'installer.start-new-seed', area: 'installer', title: 'first step: "Create a new seed" chosen in the page, the wizard moves to the Bitcoin step',
    money: 0, reach: 2, needs: ['chrome'], after: ['installer.wizard-opens'], timeoutMs: 120000, order: 2,
    async run(ctx) {
      needWizard(ctx);
      const { t } = await wizardTab(ctx);
      // the intro: one node on this computer, "Set up my node"
      await t.until(`!!document.querySelector('#intro-go')`, 20000, 'the intro');
      if (await t.js(`document.querySelector('#intro-go').offsetParent !== null`)) {
        check(await t.js(`document.querySelector('#intro-count').value`) === '1', 'the intro offers one node by default');
        await press(t, '#intro-go');
      }
      await t.until(`(() => { const e = document.querySelector('#start-way-new'); return !!e && e.closest('section').classList.contains('on'); })()`, 20000, 'the first step\'s "Create a new seed" choice');
      const inst = (await apiState(t)).instances;
      check(inst && Number(inst.count) === 1, 'the intro saved one node on this computer', inst);
      await press(t, '#start-way-new');
      await t.until(`!!document.querySelector('#start-go') && !document.querySelector('#start-go').disabled`, 10000, 'Continue enabled');
      await press(t, '#start-go');
      await stepIs(t, 'chain');
      const st = await apiState(t);
      check(st.origin === 'new' && st.control === 'words', 'the start is saved as new 24 words', { origin: st.origin, control: st.control });
      await t.until(`!!document.querySelector('#k-core')`, 20000, 'the Bitcoin step (#k-core)');
      await t.shot(join(ctx.dir, '02-bitcoin.png'), true);
      check(!pageErrors(t).length, 'the page threw nothing', pageErrors(t));
      return { origin: st.origin, control: st.control, step: st.step, shots: ['02-bitcoin.png'] };
    },
  },
  {
    id: 'installer.chain-devnet', area: 'installer', title: 'Bitcoin step: "My Bitcoin Core" tested and saved against the devnet bitcoind - refused by its genesis (regtest is not testnet4)',
    money: 0, reach: 2, needs: ['chrome', 'devnet'], after: ['installer.start-new-seed'], timeoutMs: 120000, order: 3,
    async run(ctx) {
      needWizard(ctx);
      const { t } = await wizardTab(ctx);
      await t.until(`!!document.querySelector('#k-core')`, 20000, 'the Bitcoin step');
      await press(t, '#k-core');
      await t.until(`!!document.querySelector('#c-url')`, 10000, 'the RPC address field');
      await fill(t, '#c-url', ctx.dn.rpcUrl);
      await fill(t, '#c-cookie', ctx.dn.cookie);
      await press(t, 'button', '^Test$');
      const tested = await t.until(`(() => { const x = document.body.innerText; return /Failed: [^\\n]*not testnet4|Passed:/.test(x) && x.match(/(Failed|Passed): [^\\n]*/)[0]; })()`, 45000, 'the test\'s answer');
      await t.shot(join(ctx.dir, '03-bitcoin-tested.png'), true);
      check(/^Failed: block 0 is 0f9188f13cb7b2c7\.\.\. \(chain "regtest"\): not testnet4/.test(tested), 'the devnet bitcoind was reached (its regtest genesis read) and refused as not testnet4', tested);
      await press(t, 'button', '^Save and continue$');
      await t.until(`/Failed: [^\\n]*not testnet4/.test(document.body.innerText) && !document.querySelector('button[disabled]')`, 45000, 'the save\'s refusal');
      const st = await apiState(t);
      check(st.step === 'chain' && !(st.done || {}).chain, 'nothing is saved: the wizard stays at the Bitcoin step', { step: st.step, done: st.done });
      await t.shot(join(ctx.dir, '04-bitcoin-save-refused.png'), true);
      return { tested, step: st.step, devnet: ctx.dn.rpcUrl, shots: ['03-bitcoin-tested.png', '04-bitcoin-save-refused.png'] };
    },
  },
  {
    id: 'installer.resume-after-restart', area: 'installer', title: 'the installer closed and started again: the page resumes on the same session at the next step (Bitcoin step\'s record written into state.json)',
    money: 0, reach: 2, needs: ['chrome', 'devnet'], after: ['installer.chain-devnet'], timeoutMs: 180000, order: 4,
    async run(ctx) {
      const W = needWizard(ctx);
      await stopWizard(W);
      // THE BITCOIN STEP'S RECORD, AS A PASSED SAVE WRITES IT (wizard.js POST /api/chain/save: mark('chain', { chain, chainTest })): the devnet's
      // Core by its cookie. The installer takes testnet4 only (flow installer.chain-devnet), so this one line is written by the suite
      const { nodeState } = await import(pathToFileURL(join(ctx.root, 'packages/arena-installer/src/state.js')).href);
      const height = Number(ctx.dn.cli('getblockcount'));
      nodeState(W.home).update((n) => ({ chain: { kind: 'core', url: ctx.dn.rpcUrl, cookiePath: ctx.dn.cookie }, chainTest: { atMs: Date.now(), why: 'e2e #2642: written by the suite (devnet regtest)', latencyMs: 0, height },
        done: { ...(n.done || {}), chain: Date.now() } }));
      const s = await startWizard(ctx, W);
      // the old session (kept on disk as its hash) opens the page; the new link is not used
      const { t } = await wizardTab(ctx);
      await t.until(`!!document.querySelector('#rl-verify, [id^="rl-"]')`, 30000, 'the roles step on the old session');
      const st = await apiState(t);
      check(st.ok && st.step === 'roles', 'the restarted installer resumes at the roles step', st.step);
      check(st.origin === 'new' && st.control === 'words', 'the first step\'s choice survived the restart', { origin: st.origin, control: st.control });
      await t.shot(join(ctx.dir, '05-roles-after-restart.png'), true);
      return { restartedPid: s.proc.pid, step: st.step, sessionKept: true, chainWritten: { kind: 'core', url: ctx.dn.rpcUrl, height }, shots: ['05-roles-after-restart.png'] };
    },
  },
  {
    id: 'installer.roles-apps', area: 'installer', title: 'roles step (the default roles saved) and apps step (every app of the tree on) saved through the page',
    money: 0, reach: 2, needs: ['chrome'], after: ['installer.resume-after-restart'], timeoutMs: 120000, order: 5,
    async run(ctx) {
      needWizard(ctx);
      const { t } = await wizardTab(ctx);
      await t.until(`!!document.querySelector('[id^="rl-"]')`, 20000, 'the roles step');
      const roleIds = await t.js(`[...document.querySelectorAll('[id^="role-"]')].map((e) => e.id)`);
      // custody switched on: checked at once (kanban #641) - it needs LND and the node's own Core, and must say so or pass
      await press(t, 'button', '^Save and continue$');
      await stepIs(t, 'apps');
      let st = await apiState(t);
      check(Array.isArray(st.roles) && st.roles.length > 0 && !st.roles.includes('custody'), 'the default roles were saved, custody not among them', st.roles);
      await t.until(`!!document.querySelector('[id^="ap-"]')`, 20000, 'the apps step');
      const apps = await t.js(`[...document.querySelectorAll('[id^="ap-"]')].map((e) => e.id.slice(3))`);
      await t.shot(join(ctx.dir, '06-apps.png'), true);
      await press(t, 'button', '^Continue$');
      await stepIs(t, 'seed');
      st = await apiState(t);
      check(st.apps.length === apps.length && apps.every((a) => st.apps.includes(a)), 'every app shown was saved', { shown: apps, saved: st.apps });
      check(!pageErrors(t).length, 'the page threw nothing', pageErrors(t));
      return { roleTiles: roleIds, roles: st.roles, apps: st.apps, step: st.step, shots: ['06-apps.png'] };
    },
  },
  {
    id: 'installer.seed-words', area: 'installer', title: 'seed step: 24 words shown, wrong words asked back refused, the right ones accepted; seed.hex 0600 and the words\' owner bound',
    money: 0, reach: 3, needs: ['chrome'], after: ['installer.roles-apps'], timeoutMs: 120000, order: 6,
    async run(ctx) {
      const W = needWizard(ctx);
      const { t } = await wizardTab(ctx);
      await t.until(`!!document.querySelector('#seed-show')`, 20000, 'the seed step');
      await press(t, '#seed-show');
      await t.until(`document.querySelectorAll('.words span').length === 24`, 15000, '24 words');
      const words = await t.js(`[...document.querySelectorAll('.words span')].map((s) => s.textContent.replace(/^\\d+/, '').trim())`);
      check(words.length === 24 && words.every((w) => /^[a-z]{3,8}$/.test(w)), '24 BIP39-looking words', words.length);
      await t.shot(join(ctx.dir, '07-seed-words.png'), true);   // (the temp node's words: a throwaway regtest-only home)
      check(!existsSync(join(W.home, 'seed.hex')), 'nothing is written before the words are asked back');
      await press(t, '#seed-written');
      await t.until(`document.querySelectorAll('[id^="cw-"]').length > 0 && document.querySelectorAll('.words span').length === 0`, 10000, 'the words leave the screen, the inputs come');
      let positions = await t.js(`[...document.querySelectorAll('[id^="cw-"]')].map((e) => Number(e.id.slice(3)))`);
      for (const p of positions) await fill(t, `#cw-${p}`, 'wrong');
      await press(t, '#seed-confirm');
      const refused = await t.until(`(document.body.innerText.match(/words? [\\d, ]+ (is|are) not what was shown[^\\n]*/) || [])[0]`, 15000, 'the wrong words refused');
      check(!existsSync(join(W.home, 'seed.hex')), 'a wrong answer writes nothing');
      // shown again: the same words (kept in memory until confirmed), then asked back right
      await t.until(`!!document.querySelector('#seed-show')`, 10000, 'Show again');
      await press(t, '#seed-show');
      await t.until(`document.querySelectorAll('.words span').length === 24`, 15000, '24 words again');
      const again = await t.js(`[...document.querySelectorAll('.words span')].map((s) => s.textContent.replace(/^\\d+/, '').trim())`);
      check(again.join(' ') === words.join(' '), 'the same words are shown again until confirmed');
      await press(t, '#seed-written');
      await t.until(`document.querySelectorAll('[id^="cw-"]').length > 0`, 10000, 'the inputs');
      positions = await t.js(`[...document.querySelectorAll('[id^="cw-"]')].map((e) => Number(e.id.slice(3)))`);
      for (const p of positions) await fill(t, `#cw-${p}`, words[p - 1]);
      await t.shot(join(ctx.dir, '08-seed-asked-back.png'), true);
      await press(t, '#seed-confirm');
      await stepIs(t, 'emergency');
      const mode = statSync(join(W.home, 'seed.hex')).mode & 0o777;
      check(mode === 0o600, 'seed.hex is 0600', mode.toString(8));
      const st = await apiState(t);
      const ownerFile = JSON.parse(readFileSync(join(W.home, 'node.db.owner.json'), 'utf8'));
      check(st.owner && st.owner.mode === 'seed' && /^[0-9a-f]{64}$/.test(st.owner.pubkey), 'the owner is the words\' own key', st.owner);
      check(ownerFile.pubkey === st.owner.pubkey, 'node.db.owner.json binds that owner before the node\'s first start', { file: ownerFile.pubkey, state: st.owner.pubkey });
      check((st.done || {}).owner, 'the owner step is done with the words');
      check(!pageErrors(t).length, 'the page threw nothing', pageErrors(t));
      return { asked: positions, refused, seedHexMode: mode.toString(8), owner: st.owner, step: st.step, shots: ['07-seed-words.png', '08-seed-asked-back.png'] };
    },
  },
  {
    id: 'installer.emergency-owner-handoff', area: 'installer', title: 'emergency code shown and written down; the wizard reaches the reach step and hands the owner key to its own session only',
    money: 0, reach: 2, needs: ['chrome'], after: ['installer.seed-words'], timeoutMs: 120000, order: 7,
    async run(ctx) {
      const W = needWizard(ctx);
      const { t } = await wizardTab(ctx);
      const code = await t.until(`(() => { const e = document.querySelector('#emergency-code'); return e && e.textContent !== '…' && e.textContent; })()`, 20000, 'the emergency code');
      check(code.length >= 8, 'an emergency code is shown', code.length);
      await t.shot(join(ctx.dir, '09-emergency.png'), true);
      await press(t, '#emergency-done');
      await stepIs(t, 'reach');
      await t.until(`!!document.querySelector('#r-test')`, 20000, 'the reach step (#r-test)');
      await t.shot(join(ctx.dir, '10-reach.png'), true);
      // THE OWNER HAND-OFF (FinishSteps: the Done page posts it to the node's dashboard): to this session the words' seed, as on disk
      const h = await t.js(`fetch('/api/owner/handoff').then((r) => r.json())`);
      const seedOnDisk = readFileSync(join(W.home, 'seed.hex'), 'utf8').trim();
      check(h.ok && h.kind === 'seed' && h.seed === seedOnDisk, 'the hand-off gives this session the seed on disk', { ok: h.ok, kind: h.kind, same: h.seed === seedOnDisk });
      const other = await rawGet(P.wizard, '/api/owner/handoff', { host: `127.0.0.1:${P.wizard}` });
      check(other.status === 401 && !/[0-9a-f]{64}/.test(other.body), 'without the session the hand-off gives nothing', other.status);
      const st = await apiState(t);
      check(Object.keys(st.done || {}).includes('emergency'), 'the emergency step is done');
      check(!pageErrors(t).length, 'the page threw nothing', pageErrors(t));
      return { codeLength: code.length, step: st.step, handoff: h.kind, withoutSession: other.status, done: Object.keys(st.done || {}), shots: ['09-emergency.png', '10-reach.png'] };
    },
  },
  {
    id: 'installer.reach-service', area: 'installer', title: 'reach step (direct check) and "Install and start" (service, owner login) - the wizard\'s finish',
    money: 0, reach: 2, needs: ['chrome'], after: ['installer.emergency-owner-handoff'], timeoutMs: 60000, order: 8,
    async run(ctx) {
      // the wizard is ended here: nothing after this flow uses it
      const W = ctx.shared.installer && ctx.shared.installer.wiz;
      await stopWizard(W);
      throw new Skip('not drivable on this machine: the reach step\'s direct check asks the live testnet4 seats (reach.js REACH_SEATS, hard-coded, no setting) '
        + 'to connect back, and "Install and start" writes launchd agents into the user\'s real gui domain (service.js installService) where a live node runs - '
        + 'neither has a regtest/devnet or temp-domain switch. The wizard was driven up to the reach step (installer.emergency-owner-handoff); the seat it would '
        + 'start is covered by the update flows');
    },
  },
  {
    id: 'installer.update-cli-signature', area: 'installer', title: '`arena-install --update <asset>`: a forged SHA256SUMS and a file that is not the signed one refused; the real signed asset passes its check and unpacks',
    money: 0, reach: 2, needs: [], timeoutMs: 600000, order: 10,
    async run(ctx) {
      const { newer } = realReleases();
      const dl = join(RELEASES, 'downloads', newer.version);
      const asset = existsSync(dl) ? readdirSync(dl).find((f) => /darwin-arm64\.tar\.gz$/.test(f)) : null;
      if (!asset || !existsSync(join(dl, 'SHA256SUMS.sig'))) throw new Skip(`no signed download of ${newer.version} in ${dl} (asset, SHA256SUMS, SHA256SUMS.sig)`);
      const I = rootOf(ctx);
      const base = join(I.base, 'cli-update'); mkdirSync(base, { recursive: true });
      const tmpHome = join(base, 'home'); mkdirSync(tmpHome, { recursive: true });
      const node = join(tmpHome, '.bitcoinarena');
      const runCli = (assetPath) => {
        const r = spawnSync(process.execPath, [join(ctx.root, 'packages/arena-installer/bin/arena-install.mjs'), '--update', assetPath, '--home', node],
          { cwd: ctx.root, env: { ...env, HOME: tmpHome, ARENA_NO_BROWSER: '1' }, encoding: 'utf8', timeout: 400000 });
        return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' | ') };
      };
      // 1. SHA256SUMS changed by one character, the signature as published: not signed
      const forged = join(base, 'forged'); mkdirSync(forged, { recursive: true });
      const sums = readFileSync(join(dl, 'SHA256SUMS'), 'utf8');
      writeFileSync(join(forged, 'SHA256SUMS'), sums.replace(/^([0-9a-f])/, (c) => (c === '0' ? '1' : '0')));
      copyFileSync(join(dl, 'SHA256SUMS.sig'), join(forged, 'SHA256SUMS.sig'));
      writeFileSync(join(forged, asset), 'not the release\n');
      const a = runCli(join(forged, asset));
      check(a.status === 2 && /Refused: SHA256SUMS is not signed by the Arena release key/.test(a.out), 'a forged SHA256SUMS is refused', a);
      // 2. the published SHA256SUMS and signature, beside a file that is not the signed asset
      const swapped = join(base, 'swapped'); mkdirSync(swapped, { recursive: true });
      copyFileSync(join(dl, 'SHA256SUMS'), join(swapped, 'SHA256SUMS')); copyFileSync(join(dl, 'SHA256SUMS.sig'), join(swapped, 'SHA256SUMS.sig'));
      writeFileSync(join(swapped, asset), 'not the release\n');
      const b = runCli(join(swapped, asset));
      check(b.status === 2 && new RegExp(`Refused: ${asset.replace(/\./g, '\\.')} is not the signed file`).test(b.out), 'a file that is not the signed asset is refused', b);
      check(!existsSync(join(node, 'releases', asset.replace(/\.tar\.gz$/, ''))), 'nothing refused was unpacked');
      // 3. the real signed asset (an APFS clone of the download): its check passes, it unpacks; no node in this home, so no move
      const real = join(base, 'real'); mkdirSync(real, { recursive: true });
      for (const f of [asset, 'SHA256SUMS', 'SHA256SUMS.sig']) clone(join(dl, f), join(real, f));
      const c = runCli(join(real, asset));
      const unpacked = join(node, 'releases', asset.replace(/\.tar\.gz$/, ''));
      check(!/Refused/.test(c.out), 'the real signed asset passes the signature check', c);
      check(existsSync(join(unpacked, 'VERSION')) && readFileSync(join(unpacked, 'VERSION'), 'utf8').trim() === newer.version, 'it was unpacked beside the node, never over it', unpacked);
      check(c.status === 1 && /Not updated: no node is installed at /.test(c.out), 'with no node in this home it says so and moves nothing', c);
      return { asset, forgedSums: a, notTheSignedFile: b, genuine: c, unpacked };
    },
  },
  {
    id: 'installer.update', area: 'installer', title: 'node update: a node running a real release (seat answering) moved to the next real release - backed up, units rewritten, the same node answering as the new version',
    money: 0, reach: 3, needs: ['devnet'], timeoutMs: 900000, order: 11,
    async run(ctx) {
      const { older, newer } = realReleases();
      const I = rootOf(ctx); hookExit(ctx);
      for (const p of [P.btc, P.updSeat, P.serve]) if (!(await portFree(p))) throw new Error(`port ${p} on 127.0.0.1 is taken (E2E_INSTALLER_PORT moves the installer flows' ports)`);
      const U = I.upd = { base: join(I.base, 'update'), root: ctx.root, older, newer };
      U.tmpHome = join(U.base, 'home'); U.home = join(U.tmpHome, '.bitcoinarena');
      const rel = join(U.home, 'releases');
      mkdirSync(rel, { recursive: true });
      mkdirSync(join(U.tmpHome, '.config', 'systemd', 'user'), { recursive: true });
      // A PRIVATE REGTEST BITCOIND for this node (the devnet's chain is left alone: a seat writes to its chain source's wallet as it likes)
      U.btcBin = ctx.dn.btcBin || env.BITCOIN_BIN;
      if (!U.btcBin || !existsSync(join(U.btcBin, 'bitcoind'))) throw new Skip('no bitcoind (BITCOIN_BIN) for the update node\'s private regtest chain');
      const btcDir = join(U.base, 'btc'); mkdirSync(btcDir, { recursive: true });
      U.btcArgs = ['-regtest', `-datadir=${btcDir}`, `-rpcport=${P.btc}`];
      execFileSync(join(U.btcBin, 'bitcoind'), [...U.btcArgs, '-listen=0', '-daemon', '-fallbackfee=0.0001'], { timeout: 30000 });
      U.btcUp = true;
      for (let i = 0; i < 60; i++) { try { execFileSync(join(U.btcBin, 'bitcoin-cli'), [...U.btcArgs, 'getblockcount'], { stdio: 'pipe', timeout: 5000 }); break; } catch { await wait(500); } }
      // the two releases, cloned into the temp home's releases/ (the real folders are not touched)
      U.r1 = join(rel, older.name); U.r2 = join(rel, newer.name);
      clone(older.dir, U.r1); clone(newer.dir, U.r2);
      // THE NODE AS INSTALLED: its settings (one of the owner's own, which an update must keep), its state, its seat's unit
      writeFileSync(join(U.home, 'arena.conf'), ['# e2e #2642: a node in a temp home on a private regtest chain', `port=${P.updSeat}`, `database=${join(U.home, 'node.db')}`, 'network=regtest',
        `bitcoind_url=http://127.0.0.1:${P.btc}`, `bitcoind_cookie=${join(btcDir, 'regtest', '.cookie')}`, 'seating=0',
        '# no release checks against the Arena site from this test node', 'release_latest_url=', 'e2e_owner_setting=kept-2642', ''].join('\n'), { mode: 0o600 });
      writeFileSync(join(U.home, 'state.json'), JSON.stringify({ network: 'testnet4', createdMs: Date.now(), service: { port: P.updSeat }, release: { path: U.r1, atMs: Date.now() },
        done: { start: 1, chain: 1, roles: 1, apps: 1, seed: 1, emergency: 1, owner: 1, reach: 1, service: 1 } }, null, 1));
      const up = await job(ctx, U, { op: 'seat-up', release: U.r1, waitMs: 180000 });
      check(up.ok, `the ${older.version} seat starts and answers`, up);
      const before = await seatSays(P.updSeat);
      check(before.version === older.version && before.commit === older.commit, `the node answers as ${older.version}`, before);
      check(/off/.test(String(before.latestWhy || '')), 'the test node makes no release check against the Arena site', before.latestWhy);
      U.identity = before.identity;
      U.ready = true;
      // THE UPDATE
      const t0 = Date.now();
      const r = await job(ctx, U, { op: 'update', newRelease: U.r2, waitMs: 180000 });
      const after = await seatSays(P.updSeat);
      const ev = { from: older.version, to: newer.version, seconds: Math.round((Date.now() - t0) / 1000), ok: r.ok, why: r.why, backup: r.backup, moved: r.moved, answered: r.answered, after };
      check(r.ok && r.answered && r.answered.version === newer.version && r.answered.commit === newer.commit, `the update answered ok as ${newer.version}`, r);
      check(after.identity === U.identity && after.version === newer.version, 'the same node answers as the new release', after);
      check(unitRelease(U) === U.r2, 'the seat\'s unit names the new release', unitRelease(U));
      check(stateOf(U.home).release.path === U.r2 && stateOf(U.home).release.from === U.r1, 'state.json names the new release and the one before', stateOf(U.home).release);
      check(/^e2e_owner_setting=kept-2642$/m.test(readFileSync(join(U.home, 'arena.conf'), 'utf8')), 'the owner\'s own setting in arena.conf is kept');
      const bk = readdirSync(r.backup);
      check(['node.db', 'arena.conf', 'state.json'].every((f) => bk.includes(f)), 'the backup holds the database, the settings and the state', bk);
      check(existsSync(U.r1), 'the release it came from stays (the way back)');
      return { ...ev, backupFiles: bk };
    },
  },
  {
    id: 'installer.rollback-failed-release', area: 'installer', title: 'node rollback: an update to a newer release whose seat does not start is rolled back - the old release answers again as the same node',
    money: 0, reach: 3, needs: ['devnet'], after: ['installer.update'], timeoutMs: 900000, order: 12,
    async run(ctx) {
      const U = needUpd(ctx);
      const cur = await seatSays(P.updSeat);
      check(cur.version === U.newer.version, `the node runs ${U.newer.version} before`, cur);
      // A NEWER RELEASE THAT DOES NOT START: a clone of the newest, its VERSION one fix up, its seat's start file ending at once
      const bad = `${vparts(U.newer.version).slice(0, 3).join('.')}.${(vparts(U.newer.version)[3] || 0) + 1}`;
      U.r3 = join(dirname(U.r2), U.newer.name.replace(U.newer.version, bad));
      clone(U.r2, U.r3);
      writeFileSync(join(U.r3, 'VERSION'), `${bad}\n`);
      const runJs = join(U.r3, 'packages/arena-node/src/run.js');
      renameSync(runJs, `${runJs}.e2e-aside`);
      writeFileSync(runJs, "console.error('e2e #2642: this release does not start'); process.exit(3);\n");
      const t0 = Date.now();
      const r = await job(ctx, U, { op: 'update', newRelease: U.r3, waitMs: 45000 });
      const after = await seatSays(P.updSeat);
      // moved aside (never deleted): a later update would prune it from releases/
      const aside = join(U.base, 'releases-aside'); mkdirSync(aside, { recursive: true }); renameSync(U.r3, join(aside, U.r3.split('/').pop()));
      const ev = { to: bad, seconds: Math.round((Date.now() - t0) / 1000), ok: r.ok, rolledBack: r.rolledBack, restored: r.restored, failedAt: r.failedAt, why: String(r.why || '').slice(0, 300), after };
      check(!r.ok && r.rolledBack && r.restored, 'the failed update is rolled back and the old release restored', ev);
      check(/did not come up/.test(r.why || '') && /does not start/.test(r.why || ''), 'the refusal says why, with the new release\'s own last log lines', r.why);
      check(after.identity === U.identity && after.version === U.newer.version && after.commit === U.newer.commit, `the same node answers as ${U.newer.version} again`, after);
      check(unitRelease(U) === U.r2, 'the seat\'s unit names the release before again', unitRelease(U));
      const j = JSON.parse(readFileSync(join(U.home, 'update-journal.json'), 'utf8'));
      check(j.phase === 'rolled-back' && j.restored === true, 'the update journal ends rolled back', { phase: j.phase, restored: j.restored });
      check(stateOf(U.home).release.path === U.r2, 'state.json still names the running release', stateOf(U.home).release);
      return { ...ev, journal: j.phase };
    },
  },
  {
    id: 'installer.downgrade-guard', area: 'installer', title: 'back to the previous release: refused unasked (#2601), then done with --allow-older - the same node answers as the older release',
    money: 0, reach: 2, needs: ['devnet'], after: ['installer.rollback-failed-release'], timeoutMs: 900000, order: 13,
    async run(ctx) {
      const U = needUpd(ctx);
      const r1 = await job(ctx, U, { op: 'update', newRelease: U.r1, waitMs: 180000 });
      const mid = await seatSays(P.updSeat);
      check(!r1.ok && /older than the release this node runs/.test(r1.why || ''), 'an older release is refused unasked', r1.why);
      check(mid.version === U.newer.version && mid.identity === U.identity, 'the node keeps running untouched', mid);
      const r2 = await job(ctx, U, { op: 'update', newRelease: U.r1, allowOlder: true, waitMs: 180000 });
      const after = await seatSays(P.updSeat);
      check(r2.ok && r2.answered && r2.answered.version === U.older.version, `with allowOlder the node moves back to ${U.older.version}`, r2);
      check(after.identity === U.identity && after.version === U.older.version, 'the same node answers as the older release', after);
      check(unitRelease(U) === U.r1, 'the seat\'s unit names the older release', unitRelease(U));
      return { refused: r1.why, moved: { ok: r2.ok, from: r2.from, to: r2.to, answered: r2.answered }, after };
    },
  },
  {
    id: 'installer.auto-update', area: 'installer', title: 'auto update (checkOnce): the newer release downloaded from 127.0.0.1 - a wrong download refused by its SHA-256, the real one checked against SHA256SUMS + signature, unpacked and moved to',
    money: 0, reach: 3, needs: ['devnet'], after: ['installer.downgrade-guard'], timeoutMs: 1200000, order: 14,
    async run(ctx) {
      const U = needUpd(ctx);
      let server = null;
      try {
        const cur = await seatSays(P.updSeat);
        if (cur.version !== U.older.version) throw new Skip(`the node runs ${cur.version}, not ${U.older.version} (installer.downgrade-guard did not pass)`);
        const dl = join(RELEASES, 'downloads', U.newer.version);
        const asset = existsSync(dl) ? readdirSync(dl).find((f) => /darwin-arm64\.tar\.gz$/.test(f)) : null;
        if (!asset) throw new Skip(`no signed download of ${U.newer.version} in ${dl}`);
        // the clone of the newer release moved aside (never deleted): the auto update unpacks its own from the download
        const aside = join(U.base, 'releases-aside'); mkdirSync(aside, { recursive: true });
        if (existsSync(U.r2)) renameSync(U.r2, join(aside, `${U.newer.name}.clone`));
        const sha = createHash('sha256').update(readFileSync(join(dl, asset))).digest('hex');
        let wrong = true;
        const served = [];
        server = createServer((q, s) => {
          const f = decodeURIComponent(new URL(q.url, 'http://x').pathname.slice(1));
          served.push(`${q.method} ${f}${wrong && f === `${asset}.part00` ? ' (wrong bytes)' : ''}`);
          if (f === `${asset}.part00`) {
            if (wrong) { const b = Buffer.from('not the release\n'); s.writeHead(200, { 'content-length': b.length }); return s.end(q.method === 'HEAD' ? undefined : b); }
            s.writeHead(200, { 'content-length': statSync(join(dl, asset)).size }); if (q.method === 'HEAD') return s.end(); return createReadStream(join(dl, asset)).pipe(s);
          }
          if (f === 'SHA256SUMS' || f === 'SHA256SUMS.sig') { s.writeHead(200); return s.end(q.method === 'HEAD' ? undefined : readFileSync(join(dl, f))); }
          s.writeHead(404); s.end();
        });
        await new Promise((ok, no) => { server.once('error', no); server.listen(P.serve, '127.0.0.1', ok); });
        const latest = { latest: { version: U.newer.version, commit: U.newer.commit, assets: { [asset]: sha },
          download: { base: `http://127.0.0.1:${P.serve}/`, sums: 'SHA256SUMS', sig: 'SHA256SUMS.sig', parts: { [asset]: [`${asset}.part00`] } } }, newer: true };
        const a = await job(ctx, U, { op: 'auto', latest, platform: 'darwin', arch: 'arm64', waitMs: 180000 });
        check(!a.ok && /downloaded with SHA-256 .* not the .* the signed latest\.json names: not used/.test(a.why || ''), 'a download that is not the named file is not used', a.why);
        check((await seatSays(P.updSeat)).version === U.older.version, 'the node keeps running untouched');
        wrong = false;
        const t0 = Date.now();
        const b = await job(ctx, U, { op: 'auto', latest, platform: 'darwin', arch: 'arm64', waitMs: 180000 });
        const after = await seatSays(P.updSeat);
        const newDir = join(U.home, 'releases', asset.replace(/\.tar\.gz$/, ''));
        check(b.ok && b.from === U.older.version && b.to === U.newer.version, `the auto update moved ${U.older.version} -> ${U.newer.version}`, b);
        check(after.identity === U.identity && after.version === U.newer.version && after.commit === U.newer.commit, 'the same node answers as the downloaded release', after);
        check(unitRelease(U) === newDir && existsSync(join(U.home, 'releases', `.unpacked-${asset.replace(/\.tar\.gz$/, '')}`)), 'the unit names the release unpacked from the download, marked whole', unitRelease(U));
        const rec = (() => { try { return JSON.parse(readFileSync(join(U.home, 'auto-update.json'), 'utf8')); } catch { return null; } })();
        return { wrongDownload: a.why, moved: { ok: b.ok, from: b.from, to: b.to }, seconds: Math.round((Date.now() - t0) / 1000), after, served, record: rec ? { ok: rec.ok, to: rec.to } : 'none read' };
      } finally {
        if (server) server.close();
        // THE END OF THE UPDATE NODE: its seat and its private bitcoind stopped (its files stay in the temp home)
        try { await job(ctx, U, { op: 'stop-all' }, 120000); } catch { /* the exit hook tries again */ }
        try { execFileSync(join(U.btcBin, 'bitcoin-cli'), [...U.btcArgs, 'stop'], { stdio: 'pipe', timeout: 20000 }); } catch { /* gone */ }
        U.cleaned = true;
      }
    },
  },
];
