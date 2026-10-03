#!/usr/bin/env node
// THE DEV'S DONATION CLIENT (the owner 2026-10-03): one instance per dev, one directory each.
//
//   blwp-donor init <dir> --label "dev a" [--lnddir D --rpcserver H:P]   makes the key (key.json, 0600) and donor.json
//   blwp-donor once <dir>      one pass: ask the seats, redeem in every federation, withdraw to the dev's LND
//   blwp-donor loop <dir>      a pass every donor.json intervalSec
//   blwp-donor status <dir>    the key, what the seats list for it, what each federation wallet holds
//
// The federation is the page's own wasm lock client (donor.json wasmPkg), run in Node; each federation's wallet state is
// kept in <dir>/wallet-<federation id 16>.json. The LND is the dev's own, through lncli. Invites: donor.json `invites`
// (federation id -> invite), and the `testnet.federation` invite of every `invitesFrom` daily.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { newKey, walletSecretFor, gatherDonations, redeemAll, withdrawToLnd, routeWebSockets } from '../src/donor.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d; };
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJson = (p, v) => { writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1)); renameSync(`${p}.tmp`, p); };
if (!cmd || !dir) { console.error('blwp-donor init|once|loop|status <dir>'); process.exit(2); }

if (cmd === 'init') {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.json');
  if (existsSync(keyPath)) { console.error(`${keyPath} exists: a key is never replaced`); process.exit(1); }
  const k = newKey();
  writeFileSync(keyPath, JSON.stringify({ label: flag('label', ''), ...k }, null, 1), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  writeJson(join(dir, 'donor.json'), {
    label: flag('label', ''),
    recipientPkHex: k.recipientPkHex,
    seats: (flag('seats', 'http://127.0.0.1:31221,http://127.0.0.1:31231,http://127.0.0.1:31241,http://127.0.0.1:31251,http://127.0.0.1:31261,http://127.0.0.1:31271,http://127.0.0.1:31281')).split(','),
    invites: {},
    invitesFrom: ['https://btc-logistics-core.pages.dev/daily.json'],
    wasmPkg: flag('wasm', '/mnt/bitcoin/blwp-2of2-s/page-hold'),
    lnd: { lncli: '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli', lnddir: flag('lnddir', '/mnt/bitcoin/lnd-testnet4-c'),
      rpcserver: flag('rpcserver', '127.0.0.1:11011'), network: 'testnet4' },
    minWithdrawMsat: flag('min', '10000'),
    intervalSec: Number(flag('interval', '300')),
  });
  say({ step: 'init', dir, label: flag('label', ''), recipientPk: k.recipientPkHex });
  process.exit(0);
}

const cfg = readJson(join(dir, 'donor.json'), null);
const key = readJson(join(dir, 'key.json'), null);
if (!cfg || !key) { console.error(`${dir} holds no donor.json and key.json: run init first`); process.exit(2); }
const statePath = join(dir, 'state.json');

const lncli = (...a) => new Promise((ok, no) => execFile(cfg.lnd.lncli, [`--lnddir=${cfg.lnd.lnddir}`, `--rpcserver=${cfg.lnd.rpcserver}`, `--network=${cfg.lnd.network}`, ...a],
  { timeout: 120000 }, (e, out, err) => (e ? no(new Error(String(err || e.message).trim())) : ok(JSON.parse(out)))));
const lnd = { invoice: async (msat, memo) => (await lncli('addinvoice', '--amt_msat', String(msat), '--memo', memo, '--expiry', '3600')).payment_request };

let LockClient = null;
async function lockClient() {
  if (LockClient) return LockClient;
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `blwp-donor-lock-client-${process.pid}.mjs`);
  copyFileSync(join(cfg.wasmPkg, 'blwp_lock_client.js'), esm);
  const m = await import(esm);
  await m.default({ module_or_path: readFileSync(join(cfg.wasmPkg, 'blwp_lock_client_bg.wasm')) });
  LockClient = m.LockClient;
  return LockClient;
}

/** A wallet store kept in a file: the lock client's state survives a restart, per federation. */
function fileStore(path) {
  const held = new Map(Object.entries(readJson(path, {})));
  const save = () => writeJson(path, Object.fromEntries(held));
  return { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); save(); }, remove: (k) => { held.delete(k); save(); } };
}

async function invites() {
  const LC = await lockClient();
  const out = { ...(cfg.invites || {}) };
  const routes = {};
  for (const url of cfg.invitesFrom || []) {
    try {
      const d = await (await fetch(url, { cache: 'no-store' })).json();
      // the guardians' second route, as the page takes it (not the loopback donation route)
      Object.assign(routes, (d && d.testnet && d.testnet.alt) || {});
      for (const inv of [d && d.testnet && d.testnet.federation, d && d.federation].filter((x) => typeof x === 'string')) {
        try { out[String(LC.federationIdOf(inv)).toLowerCase()] = inv; } catch { /* not an invite */ }
      }
    } catch (e) { say({ step: 'invites', from: url, why: e.message }); }
  }
  delete routes['127.0.0.1:18777'];
  if (!routed && routeWebSockets(routes)) { routed = true; say({ step: 'routes', guardians: Object.keys(routes).length }); }
  return out;
}
let routed = false;

async function pass() {
  const state = readJson(statePath, { done: [], withdrawals: [] });
  const done = new Set(state.done);
  const got = await gatherDonations({ recipientPkHex: cfg.recipientPkHex, seats: cfg.seats });
  say({ step: 'asked the seats', donations: got.total, federations: [...got.byFederation.keys()].map((f) => f.slice(0, 16)), unanswered: got.unanswered });
  const known = await invites();
  const LC = await lockClient();
  for (const [fed, donations] of got.byFederation) {
    const owed = donations.filter((d) => !done.has(d.outpoint));
    const invite = known[fed.toLowerCase()];
    if (!invite) { say({ step: 'federation', federation: fed.slice(0, 16), donations: donations.length, why: 'no invite to this federation is known: its funds stay there until one is' }); continue; }
    const client = await LC.join(invite, fed, walletSecretFor(key.secretHex, fed), fileStore(join(dir, `wallet-${fed.slice(0, 16)}.json`)));
    if (owed.length) {
      const r = await redeemAll({ client, donations: owed, recipientPkHex: cfg.recipientPkHex, secretHex: key.secretHex, done });
      for (const d of [...r.redeemed, ...r.spent]) done.add(d.outpoint);
      state.done = [...done];
      writeJson(statePath, state);
      say({ step: 'redeemed', federation: fed.slice(0, 16), redeemed: r.redeemed.length, redeemedMsat: r.redeemed.reduce((t, d) => t + BigInt(d.amountMsat), 0n),
        alreadySpent: r.spent.length, failed: r.failed.map((d) => `${d.outpoint.slice(0, 12)}: ${d.why}`) });
    }
    const w = await withdrawToLnd({ client, lnd, minMsat: BigInt(cfg.minWithdrawMsat || 10000), memo: `blwp donations ${cfg.label}` });
    if (w.withdrawn !== false || w.state) {
      state.withdrawals.push({ at: new Date().toISOString(), federation: fed, msat: String(w.withdrawableMsat), state: w.state, gateway: w.gateway, preimage: w.preimage || null });
      writeJson(statePath, state);
    }
    say({ step: 'withdraw', federation: fed.slice(0, 16), ...w, balanceMsat: await client.balanceMsat() });
  }
}

if (cmd === 'status') {
  const got = await gatherDonations({ recipientPkHex: cfg.recipientPkHex, seats: cfg.seats });
  const state = readJson(statePath, { done: [], withdrawals: [] });
  say({ label: cfg.label, recipientPk: cfg.recipientPkHex, donations: got.total, unanswered: got.unanswered,
    federations: Object.fromEntries([...got.byFederation].map(([f, ds]) => [f.slice(0, 16), { donations: ds.length, msat: String(ds.reduce((t, d) => t + BigInt(d.amountMsat), 0n)),
      redeemed: ds.filter((d) => state.done.includes(d.outpoint)).length }])), withdrawals: state.withdrawals.slice(-5) });
  process.exit(0);
}
if (cmd === 'once') { await pass(); process.exit(0); }
if (cmd === 'loop') {
  for (;;) {
    try { await pass(); } catch (e) { say({ step: 'pass failed', why: e.message }); }
    await new Promise((r) => setTimeout(r, (cfg.intervalSec || 300) * 1000));
  }
}
console.error(`no command ${cmd}`); process.exit(2);
